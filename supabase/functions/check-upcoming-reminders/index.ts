// check-upcoming-reminders — Supabase Edge Function
//
// Server-side replacement for the client-side TRIP/CHECK_UPCOMING_REMINDERS
// polling that used to run independently in EVERY logged-in session
// (AgentApp, DriverApp, AdminApp each ran their own 5-minute setInterval
// dispatching this same check) — found via a dedicated API-call-volume
// audit. With N agents + M drivers + K admins all logged in simultaneously,
// that was N+M+K redundant copies of the exact same global check firing
// every 5 minutes, all racing to read/write the same trip rows. Moved here
// to run ONCE, on a schedule, regardless of how many sessions are open —
// same CRON_AUTH_TOKEN pattern as daily-trip-sheet/check-late-start.
//
// This also closes a real gap the old design had: a reminder for a trip
// with REMIND enabled would previously only ever fire if some agent,
// driver, or admin happened to have the app open at the right moment —
// silently never firing overnight/unattended, exactly the failure mode
// check-late-start's own header comment already warned about for a
// different check. The client still fires ONE immediate check on mount
// (see AgentApp/DriverApp/AdminApp — the repeating interval was removed,
// the one-shot on-open check was kept) for instant feedback right after
// someone taps REMIND; this scheduled function is what makes the reminder
// actually reliable the rest of the time.
//
// Mirrors handleSupabaseAction's TRIP/CHECK_UPCOMING_REMINDERS closely —
// same 2-hour window, same 1-hour re-fire guard via lastreminderat — but
// is a separate implementation against the raw database (lowercase
// column names), not by importing app code, same reasoning as
// check-late-start.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Same dedicated shared secret as daily-trip-sheet/check-late-start — see
// check-late-start's own comment on its declaration for why this is a
// real edge-function secret rather than the platform service-role key.
// FIXED (2026-08-08): was a plaintext literal committed to git, identical
// across 4 functions — see check-late-start's comment for the full
// rationale. The old literal is compromised and no longer accepted.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const nowMs = Date.now();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
    const ONE_HOUR_MS = 60 * 60 * 1000;

    const { data: reminderCandidates, error } = await supabase
      .from("trips")
      .select("*")
      .eq("remindersent", true)
      .neq("status", "ARCHIVED_COMPLETED")
      .neq("status", "ARCHIVED_CANCELLED");
    if (error) throw error;

    let firedCount = 0;
    for (const t of reminderCandidates || []) {
      if (t.scheduledtime == null) continue;
      const timeUntil = t.scheduledtime - nowMs;
      if (timeUntil > TWO_HOURS_MS || timeUntil < 0) continue; // not yet in window, or already passed
      const lastAt = t.lastreminderat || 0;
      if (nowMs - lastAt < ONE_HOUR_MS) continue; // reminded within the last hour already

      await supabase.from("trips").update({ lastreminderat: nowMs }).eq("id", t.id);
      const tripAgentIds = [t.agentid, ...(t.extraagentids || [])].filter(Boolean);
      if (tripAgentIds.length === 0) continue;

      const reminderTitle = "UPCOMING TRIP";
      const reminderMessage = `Reminder: your trip from ${t.pickuplocation} departs at ${t.scheduledtimestr || t.scheduledtime}.`;
      const notifRows = tripAgentIds.map((agentId: number) => ({
        title: reminderTitle, type: "UPCOMING_TRIP", forroles: ["AGENT"], userid: agentId,
        message: reminderMessage,
        tripid: t.id, timestamp: nowMs, isread: false,
      }));
      await supabase.from("notifications").insert(notifRows);
      // FOUND VIA AUDIT (2026-08-09): this function's whole documented
      // purpose is reliability when nobody has the app open — but it only
      // ever wrote the DB row above, never actually pushed. A reminder for
      // someone with the app fully closed sat unseen until they happened
      // to reopen it, which for a trip reminder could be after the window
      // already passed. One call covers every agent on this trip since
      // they all share the identical message (send-push-notification
      // matches on exact message text + a timestamp window, not per-id).
      // AWAITED, not fire-and-forget — unlike the client's insertNotification
      // (a long-lived browser tab, where an un-awaited promise just keeps
      // running), this function's invocation ends shortly after returning,
      // which could abort an in-flight, unawaited push before it completes.
      // Still best-effort: a failed push must never affect the reminder's
      // own "fired" outcome below, so the error is only logged, not thrown.
      if (SUPABASE_URL && CRON_AUTH_TOKEN) {
        await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
          body: JSON.stringify({ user_ids: tripAgentIds, title: reminderTitle, message: reminderMessage, type: "UPCOMING_TRIP", trip_id: t.id, ts: nowMs }),
          signal: AbortSignal.timeout(15000),
        }).catch(e => console.warn("[check-upcoming-reminders] push failed:", e.message));
      }
      firedCount++;
    }

    return new Response(JSON.stringify({ ok: true, checked: (reminderCandidates || []).length, fired: firedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-upcoming-reminders failed:", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
