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
// function's logic — see check-late-start/check-upcoming-reminders's own
// (still-deployed but no longer scheduled) source for the original
// per-check header comments this summarizes (check-unassigned-
// approaching's local source was deleted as dead code once its logic
// was fully absorbed here; its deployment was already unscheduled).
// Nothing about any individual check's threshold/notified-
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
//   5. NEW — delay propagation: a driver running late on one trip almost
//      always drags their LATER same-day trips late too. This runs as a
//      post-loop pass (it needs each driver's worst current delay across
//      ALL their trips before it can act on the downstream ones): for
//      every not-yet-started trip whose driver is >= 20 min behind on an
//      earlier trip today (and within a 4h horizon), the agents on it get
//      one "your ride may be ~N min late" heads-up + push.
//      delaypropagatednotified / delaypropagatedmins dedupe it, re-firing
//      only if the estimate grows by 20+ min.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

// ── Delay-propagation tuning (check #5) ──────────────────────────────
const PROPAGATE_MIN_DELAY_MIN = 20;      // ignore a driver less than this behind
const PROPAGATE_HORIZON_MS = 4 * 60 * 60 * 1000; // only warn trips within 4h after the late one
const PROPAGATE_REFIRE_STEP_MIN = 20;    // re-notify only once the estimate grows this much
const IN_TRANSIT_GRACE_MIN = 60;         // an IN_TRANSIT trip isn't "late" until this far past departure

// A trip's scheduled departure as an epoch ms. Prefer the stored
// scheduledtime; fall back to parsing scheduleddate (YYYY/MM/DD) +
// scheduledtimestr (HH:MM) as SAST -> UTC, exactly as checks #1/#3 do.
function schedMs(t: Record<string, unknown>): number | null {
  if (t.scheduledtime != null) return Number(t.scheduledtime);
  const [y, m, d] = String(t.scheduleddate || "").split("/").map(Number);
  const [hh, mm] = String(t.scheduledtimestr || "").split(":").map(Number);
  if (!y || !m || !d || hh == null || mm == null || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return Date.UTC(y, m - 1, d, hh - 2, mm);
}

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

    const results = { lateStart: 0, upcomingReminders: 0, unassignedApproaching: 0, stuckInTransit: 0, delayPropagated: 0 };

    // check #5 input: per driver, every trip they're currently behind on
    // as { sMs: its scheduled departure, mins: how far behind }. A
    // downstream trip then inherits the worst delay among this driver's
    // sources scheduled BEFORE it (not just the single worst overall —
    // an 08:00 trip 25 min late still drags the 10:00 trip even if the
    // same driver's 14:00 trip is 90 min late).
    const driverDelays: Record<string, Array<{ sMs: number; mins: number }>> = {};
    const noteDelay = (driverId: unknown, mins: number, sMs: number) => {
      if (driverId == null || mins < PROPAGATE_MIN_DELAY_MIN) return;
      (driverDelays[String(driverId)] ||= []).push({ sMs, mins });
    };

    for (const t of trips || []) {
      // ── check #5 data-gathering (acts after the loop) ──────────────
      // A driver is "behind" if a trip they own is either past its
      // departure and not yet started, or has been IN_TRANSIT well past
      // departure. Independent of the notified flags above — we want the
      // live delay every run, not just the first.
      if (t.driverid && (t.status === "DRIVER_CONFIRMED" || t.status === "ASSIGNED" || t.status === "IN_TRANSIT")) {
        const sMs = schedMs(t);
        if (sMs != null) {
          const pastMin = (nowMs - sMs) / 60000;
          if (t.status === "IN_TRANSIT") {
            noteDelay(t.driverid, Math.floor(pastMin - IN_TRANSIT_GRACE_MIN), sMs);
          } else {
            noteDelay(t.driverid, Math.floor(pastMin), sMs);
          }
        }
      }

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

    // ── 5. Delay propagation (post-loop) ────────────────────────────────
    // driverDelays is now fully populated. Warn the agents on each
    // not-yet-started trip whose driver is behind on an EARLIER trip
    // today, within the horizon.
    for (const t of trips || []) {
      if (t.status !== "DRIVER_CONFIRMED" && t.status !== "ASSIGNED") continue;
      if (!t.driverid) continue;
      const sources = driverDelays[String(t.driverid)];
      if (!sources || sources.length === 0) continue;
      const sMs = schedMs(t);
      if (sMs == null) continue;
      // don't warn about a departure that's already well in the past
      if (sMs < nowMs - 30 * 60000) continue;
      // worst delay among this driver's late trips scheduled before this
      // one, within a horizon they can't realistically recover across
      let estMin = 0;
      for (const s of sources) {
        if (s.sMs < sMs && sMs - s.sMs <= PROPAGATE_HORIZON_MS && s.mins > estMin) estMin = s.mins;
      }
      if (estMin < PROPAGATE_MIN_DELAY_MIN) continue;
      const prevMin = t.delaypropagatedmins ?? 0;
      if (t.delaypropagatednotified && estMin - prevMin < PROPAGATE_REFIRE_STEP_MIN) continue;

      const agentIds = [t.agentid, ...(t.extraagentids || [])].filter(Boolean);
      if (agentIds.length === 0) {
        // nothing to notify, but still mark it so it isn't rechecked forever
        await supabase.from("trips").update({ delaypropagatednotified: true, delaypropagatedmins: estMin }).eq("id", t.id);
        continue;
      }

      await supabase.from("trips").update({ delaypropagatednotified: true, delaypropagatedmins: estMin }).eq("id", t.id);
      const whenStr = t.scheduledtimestr || (t.scheduleddate ? `${t.scheduleddate}` : "");
      const msg = `⚠ Your ride${whenStr ? ` (${whenStr})` : ""} may be about ${estMin} min late — your driver is running behind on an earlier trip. We'll keep you posted.`;
      const notifRows = agentIds.map((agentId: number) => ({
        title: "POSSIBLE DELAY", type: "TRIP_DELAY_PROPAGATED", forroles: ["AGENT"], userid: agentId,
        message: msg, tripid: t.id, timestamp: nowMs, isread: false,
      }));
      await supabase.from("notifications").insert(notifRows);
      await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
        body: JSON.stringify({ user_ids: agentIds, title: "POSSIBLE DELAY", message: msg, type: "TRIP_DELAY_PROPAGATED", trip_id: t.id, ts: nowMs }),
        signal: AbortSignal.timeout(15000),
      }).catch(e => console.warn("[check-trip-timing:delay-propagation] push failed:", e.message));
      results.delayPropagated++;
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
