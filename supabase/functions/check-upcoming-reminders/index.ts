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
// literal constant rather than the platform service-role key.
const CRON_AUTH_TOKEN = "2e032b24f3d9b86c5dec616d999a17f71ba43255707af8335a61e2cc65fd6108";

Deno.serve(async (req) => {
  try {
    if (req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
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

      const notifRows = tripAgentIds.map((agentId: number) => ({
        title: "UPCOMING TRIP", type: "UPCOMING_TRIP", forroles: ["AGENT"], userid: agentId,
        message: `Reminder: your trip from ${t.pickuplocation} departs at ${t.scheduledtimestr || t.scheduledtime}.`,
        tripid: t.id, timestamp: nowMs, isread: false,
      }));
      await supabase.from("notifications").insert(notifRows);
      firedCount++;
    }

    return new Response(JSON.stringify({ ok: true, checked: (reminderCandidates || []).length, fired: firedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-upcoming-reminders failed:", e instanceof Error ? e.message : String(e));
    return new Response(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
