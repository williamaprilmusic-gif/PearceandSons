// stale-data-retention/index.ts
//
// trip-history-retention already purges trips 2+ months old (export then
// delete) — but its own header comment notes that notifications/
// driver_positions/driver_position_log/tickets/audit_logs/driver_status
// all just SET NULL their tripid when a trip is deleted, they never lose
// their OWN rows. Found via a dedicated audit: two of those tables grow
// unbounded with zero cleanup —
//   - driver_position_log: ~1 row per active driver per ~8s GPS tick
//     (3,900+ rows and climbing), kept as a breadcrumb trail "for later
//     route review" (see the client's own comment on this table) tied to
//     a specific trip — once that trip is gone (2-month retention), the
//     breadcrumb has nothing left to be "for," so this uses the exact
//     same 2-month cutoff as trip-history-retention for coherence, not an
//     arbitrary new number.
//   - notifications: every alert ever fired, read or not. The client only
//     ever fetches the most recent 500 rows (see fetchAllFromSupabase's
//     own .limit(500)), so anything past that is already invisible in the
//     live app — a 90-day cutoff is generous relative to that existing
//     cap, not a new restriction on what admins can actually see today.
//
// Unlike trip-history-retention, this does NOT export before deleting —
// per explicit scope decision: these aren't billing/compliance records
// (trips are), they're operational telemetry/alert history with no
// standalone reporting value once stale. Simple delete, same
// CRON_AUTH_TOKEN pattern as every other scheduled function here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
    const twoMonthsAgo = new Date(nowMs);
    // FOUND VIA /code-review: setUTCMonth alone rolls forward on a
    // month-end date (31 Aug -> "June 31" -> 1 July). Snap to the 1st
    // before shifting — see trip-history-retention for the full rationale.
    twoMonthsAgo.setUTCDate(1);
    twoMonthsAgo.setUTCMonth(twoMonthsAgo.getUTCMonth() - 2);
    const ninetyDaysAgo = nowMs - 90 * 24 * 60 * 60 * 1000;

    // Two independent deletes against unrelated tables — FOUND VIA AUDIT:
    // these were awaited one after another; Promise.all cuts this run's
    // DB-wait time to roughly the slowest single delete instead of the sum
    // of both, same pattern as weekly-ops-digest's own fix.
    const [
      { error: posErr, count: posCount },
      { error: notifErr, count: notifCount },
    ] = await Promise.all([
      supabase.from("driver_position_log").delete({ count: "exact" }).lt("recordedat", twoMonthsAgo.getTime()),
      supabase.from("notifications").delete({ count: "exact" }).lt("timestamp", ninetyDaysAgo),
    ]);
    if (posErr) throw posErr;
    if (notifErr) throw notifErr;

    return new Response(JSON.stringify({ ok: true, purgedPositionLog: posCount ?? 0, purgedNotifications: notifCount ?? 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("stale-data-retention failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
