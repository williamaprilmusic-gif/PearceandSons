// check-trip-timing — Supabase Edge Function
//
// Consolidates 3 previously-separate pg_cron jobs (check-late-start,
// check-upcoming-reminders, check-unassigned-approaching) plus a new
// stuck-in-transit check into ONE function running off ONE shared
// `trips` query — per a dedicated resource-usage audit: this project had
// grown to 5 separate every-10-minute pg_cron jobs (those 3 plus check-
// document-expiry/check-hours-compliance), each a fully separate
// serverless invocation + auth check + trips query on the same cadence.
// The other 2 stay separate (they read driver_status, not trips, so
// there's no shared query to consolidate them around) — this function
// specifically unifies the trip-timing family, all of which need
// "every non-terminal trip" as their base set anyway.
//
// Each of the 4 checks below is a straight port of its own now-retired
// function's logic — see check-late-start/check-upcoming-reminders/
// check-unassigned-approaching's own (still-deployed but no longer
// scheduled) source for the original per-check header comments this
// summarizes. Nothing about any individual check's threshold/notified-
// flag/re-fire behavior changed in the merge, only that they now share
// one query instead of four, plus a post-merge fix batching the driver-
// name lookups checks #1/#4 need into one query up front instead of one
// per trip inside the loop (see driverNameById below).
//
//   1. Late start: DRIVER_CONFIRMED trips 30+ min past scheduled time,
//      never having reached IN_TRANSIT — latestartnotified flag. Pushes
//      the driver (send-push-notification requires the matching
//      notifications row to already exist, so the insert must run
//      before the push fetch, not after).
//   2. Upcoming reminders: any non-terminal trip with remindersent=true,
//      within 2h of scheduled time, re-fires hourly — lastreminderat.
//   3. Unassigned approaching: UNASSIGNED_BOOKING trips within 2h of
//      scheduled time — unassignedapproachingnotified flag.
//   4. NEW — stuck in transit: IN_TRANSIT trips 3+ hours with no
//      completion (driver forgot to tap COMPLETE, app crashed mid-trip,
//      etc.) — the other end of what check #1 covers. stuckintransit-
//      notified flag. Also pushes the driver, same insert-then-push
//      ordering as check #1 — a stuck-for-3h trip is exactly the
//      closed/crashed-app case a push (not just an in-app row) exists
//      to reach.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const nowMs = Date.now();

    // ── One shared query — superset covering all 4 checks below ────────
    const { data: trips, error } = await supabase
      .from("trips")
      .select("*")
      .not("status", "in", "(ARCHIVED_COMPLETED,ARCHIVED_CANCELLED)");
    if (error) throw error;

    // Driver names for checks #1/#4, batched into ONE query up front —
    // FOUND VIA AUDIT: this used to run one `users` lookup per trip
    // INSIDE the loop, in both checks separately, reintroducing the
    // exact N+1 query pattern this whole consolidation was built to
    // eliminate.
    const driverIdsNeedingName = [...new Set(
      (trips || [])
        .filter(t => (t.status === "DRIVER_CONFIRMED" || t.status === "IN_TRANSIT") && t.driverid)
        .map(t => t.driverid)
    )];
    const driverNameById: Record<string, string> = {};
    if (driverIdsNeedingName.length > 0) {
      const { data: driverRows } = await supabase.from("users").select("id, fullname").in("id", driverIdsNeedingName);
      for (const d of driverRows || []) driverNameById[String(d.id)] = d.fullname;
    }

    const results = { lateStart: 0, upcomingReminders: 0, unassignedApproaching: 0, stuckInTransit: 0 };

    for (const t of trips || []) {
      // ── 1. Late start ──────────────────────────────────────────────
      if (t.status === "DRIVER_CONFIRMED" && !t.latestartnotified) {
        const [y, m, d] = (t.scheduleddate || "").split("/").map(Number);
        const [hh, mm] = (t.scheduledtimestr || "").split(":").map(Number);
        if (y && m && d && hh != null && mm != null) {
          const scheduledDt = new Date(Date.UTC(y, m - 1, d, hh - 2, mm)); // SAST -> UTC, see check-late-start's original comment
          const minutesLate = (nowMs - scheduledDt.getTime()) / 60000;
          if (minutesLate >= 30) {
            await supabase.from("trips").update({ latestartnotified: true }).eq("id", t.id);
            const driverName = t.driverid ? (driverNameById[String(t.driverid)] || t.driverid) : t.driverid;
            const notifRows = [{
              title: "TRIP LATE START", type: "TRIP_LATE_START", forroles: ["ADMIN"], userid: null,
              message: `⚠ Trip ${t.id} hasn't started — scheduled for ${t.scheduleddate} ${t.scheduledtimestr}, driver ${driverName} still hasn't begun the pickup ${Math.floor(minutesLate)} min later.`,
              tripid: t.id, timestamp: nowMs, isread: false,
            }];
            const driverMessage = `⚠ Trip ${t.id} was due to start at ${t.scheduledtimestr} — please begin the pickup or contact dispatch if there's a delay.`;
            if (t.driverid) {
              notifRows.push({ title: "TRIP LATE START", type: "TRIP_LATE_START", forroles: ["DRIVER"], userid: t.driverid, message: driverMessage, tripid: t.id, timestamp: nowMs, isread: false });
            }
            // FOUND VIA AUDIT: the push fetch used to fire BEFORE this
            // insert — send-push-notification looks up a matching
            // notifications row to find its targets/verify the push is
            // real, so calling it before the row exists silently sent to
            // nobody every single time. Insert first, push second.
            await supabase.from("notifications").insert(notifRows);
            if (t.driverid) {
              await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
                method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
                body: JSON.stringify({ user_ids: [t.driverid], title: "TRIP LATE START", message: driverMessage, type: "TRIP_LATE_START", trip_id: t.id, ts: nowMs }),
                signal: AbortSignal.timeout(15000),
              }).catch(e => console.warn("[check-trip-timing:late-start] push failed:", e.message));
            }
            results.lateStart++;
          }
        }
      }

      // ── 2. Upcoming reminders ──────────────────────────────────────
      if (t.remindersent && t.scheduledtime != null) {
        const timeUntil = t.scheduledtime - nowMs;
        const lastAt = t.lastreminderat || 0;
        if (timeUntil >= 0 && timeUntil <= TWO_HOURS_MS && (nowMs - lastAt) >= ONE_HOUR_MS) {
          const tripAgentIds = [t.agentid, ...(t.extraagentids || [])].filter(Boolean);
          if (tripAgentIds.length > 0) {
            await supabase.from("trips").update({ lastreminderat: nowMs }).eq("id", t.id);
            const reminderMessage = `Reminder: your trip from ${t.pickuplocation} departs at ${t.scheduledtimestr || t.scheduledtime}.`;
            const notifRows = tripAgentIds.map((agentId: number) => ({
              title: "UPCOMING TRIP", type: "UPCOMING_TRIP", forroles: ["AGENT"], userid: agentId,
              message: reminderMessage, tripid: t.id, timestamp: nowMs, isread: false,
            }));
            await supabase.from("notifications").insert(notifRows);
            await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
              body: JSON.stringify({ user_ids: tripAgentIds, title: "UPCOMING TRIP", message: reminderMessage, type: "UPCOMING_TRIP", trip_id: t.id, ts: nowMs }),
              signal: AbortSignal.timeout(15000),
            }).catch(e => console.warn("[check-trip-timing:upcoming-reminders] push failed:", e.message));
            results.upcomingReminders++;
          }
        }
      }

      // ── 3. Unassigned approaching ───────────────────────────────────
      if (t.status === "UNASSIGNED_BOOKING" && !t.unassignedapproachingnotified) {
        const [y, m, d] = (t.scheduleddate || "").split("/").map(Number);
        const [hh, mm] = (t.scheduledtimestr || "").split(":").map(Number);
        if (y && m && d && hh != null && mm != null) {
          const scheduledDt = new Date(Date.UTC(y, m - 1, d, hh - 2, mm));
          const msUntil = scheduledDt.getTime() - nowMs;
          if (msUntil >= 0 && msUntil <= TWO_HOURS_MS) {
            await supabase.from("trips").update({ unassignedapproachingnotified: true }).eq("id", t.id);
            await supabase.from("notifications").insert([{
              title: "BOOKING UNASSIGNED", type: "TRIP_UNASSIGNED_APPROACHING", forroles: ["ADMIN"], userid: null,
              message: `⚠ Booking ${t.id} still has no driver — scheduled for ${t.scheduleddate} ${t.scheduledtimestr}, ${Math.round(msUntil / 60000)} min away.`,
              tripid: t.id, timestamp: nowMs, isread: false,
            }]);
            results.unassignedApproaching++;
          }
        }
      }

      // ── 4. Stuck in transit (NEW) ───────────────────────────────────
      if (t.status === "IN_TRANSIT" && !t.stuckintransitnotified && t.intransitat) {
        const msStuck = nowMs - t.intransitat;
        if (msStuck >= THREE_HOURS_MS) {
          await supabase.from("trips").update({ stuckintransitnotified: true }).eq("id", t.id);
          const driverName = t.driverid ? (driverNameById[String(t.driverid)] || t.driverid) : t.driverid;
          const notifRows = [{
            title: "TRIP STUCK IN TRANSIT", type: "TRIP_STUCK_IN_TRANSIT", forroles: ["ADMIN"], userid: null,
            message: `⚠ Trip ${t.id} has been IN TRANSIT for ${Math.floor(msStuck / 3600000)}h with no completion — driver ${driverName} may have forgotten to mark it complete.`,
            tripid: t.id, timestamp: nowMs, isread: false,
          }];
          const driverMessage = `⚠ Trip ${t.id} still shows as in progress — please mark it complete if you've finished, or contact dispatch.`;
          if (t.driverid) {
            notifRows.push({ title: "TRIP STUCK IN TRANSIT", type: "TRIP_STUCK_IN_TRANSIT", forroles: ["DRIVER"], userid: t.driverid, message: driverMessage, tripid: t.id, timestamp: nowMs, isread: false });
          }
          await supabase.from("notifications").insert(notifRows);
          // FOUND VIA AUDIT: this is exactly the "driver's app is closed"
          // case check #1's push wiring exists for — a trip stuck for 3h
          // is a real candidate for a closed/crashed app, so an in-app-
          // only notification here defeats the point. Same push shape as
          // check #1, fired after the insert for the same reason.
          if (t.driverid) {
            await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
              method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
              body: JSON.stringify({ user_ids: [t.driverid], title: "TRIP STUCK IN TRANSIT", message: driverMessage, type: "TRIP_STUCK_IN_TRANSIT", trip_id: t.id, ts: nowMs }),
              signal: AbortSignal.timeout(15000),
            }).catch(e => console.warn("[check-trip-timing:stuck-in-transit] push failed:", e.message));
          }
          results.stuckInTransit++;
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, checked: (trips || []).length, ...results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-trip-timing failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
