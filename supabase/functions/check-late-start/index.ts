// check-late-start — Supabase Edge Function
//
// Server-side half of the "trip not started 30 min before scheduled
// time" warning, per explicit decision to build BOTH a client-side
// check (immediate, but only catches it while someone has the app
// open) and this scheduled version (reliable — runs regardless of
// whether anyone's logged in at that moment).
//
// Finds every trip still sitting at DRIVER_CONFIRMED (driver assigned,
// but never actually started the pickup — never reached IN_TRANSIT)
// that's now 30+ minutes past its scheduled time and hasn't already
// been flagged, then notifies both the driver and every admin.
//
// This mirrors the app's own TRIP/CHECK_LATE_START action closely —
// same 30-minute threshold, same latestartnotified flag to avoid
// re-firing — but is a SEPARATE implementation, since it runs
// server-side against the raw database (lowercase column names, no
// access to the app's own JS), not by importing app code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated shared secret for authenticating the pg_cron caller — NOT the
// service role key. That was the original approach (matching
// daily-trip-sheet's fix), but it silently broke: the platform-injected
// SUPABASE_SERVICE_ROLE_KEY this function reads at runtime no longer
// matches the legacy-JWT-format service role token hardcoded in the
// pg_cron job's Authorization header (this project has since migrated to
// the newer sb_publishable_/sb_secret_ key format — see the client's
// SUPABASE_ANON_KEY constant, already on the new format). Confirmed via
// Supabase edge-function logs: every single scheduled invocation of this
// function was returning 401, silently, for hours — the late-start alert
// system had completely stopped working, not just degraded. A literal
// constant here, matched by the literal value in the pg_cron job's SQL
// (both under this codebase's direct control, not dependent on guessing
// which key format Supabase currently injects), can't drift the same way.
// FIXED (2026-08-08): this was a plaintext literal committed to git,
// identical across 4 functions — found via a dedicated security audit.
// Anyone with repo read access had standing, permanent access to invoke
// these functions directly, bypassing the cron schedule entirely. Moved
// to a real edge-function secret; the old literal is compromised (it
// lived in git history) and is no longer accepted.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

Deno.serve(async (req) => {
  try {
    // The platform's verify_jwt only requires *some* valid Supabase JWT —
    // the public anon key (shipped in the client bundle) satisfies that,
    // so it's not real access control. Require CRON_AUTH_TOKEN instead —
    // see the comment on its declaration above for why this isn't the
    // service role key.
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: confirmedTrips, error } = await supabase
      .from("trips")
      .select("*")
      .eq("status", "DRIVER_CONFIRMED")
      .or("latestartnotified.is.null,latestartnotified.eq.false");
    if (error) throw error;

    let flaggedCount = 0;
    for (const t of confirmedTrips || []) {
      // scheduleddate is "YYYY/MM/DD", scheduledtimestr is "HH:MM" — same
      // parsing convention the main app uses throughout. FIXED (2026-08-09):
      // this used to read t.scheduledtime, which is actually a bigint
      // column (not the "HH:MM" string this comment always claimed) —
      // .split(":") on a number throws immediately, caught by the outer
      // try/catch as a 500. Only manifested when a real DRIVER_CONFIRMED
      // trip actually reached this line (i.e. only during the exact
      // situation this function exists to catch), which is why it looked
      // "intermittent" rather than reliably broken — quiet periods with
      // nothing to flag returned 200 trivially without ever reaching the
      // buggy line.
      const [y, m, d] = (t.scheduleddate || "").split("/").map(Number);
      const [hh, mm] = (t.scheduledtimestr || "").split(":").map(Number);
      if (!y || !m || !d || hh == null || mm == null) continue; // malformed — skip rather than false-positive
      // scheduleddate/time are SAST (UTC+2) wall-clock values, but this
      // function runs in UTC — new Date(y, m-1, d, hh, mm) would build the
      // instant for hh:mm UTC instead, delaying every "late start" alert by
      // exactly 2 hours (matches daily-trip-sheet's own sast() helper,
      // which exists to correct for the same runtime-timezone mismatch).
      const scheduledDt = new Date(Date.UTC(y, m - 1, d, hh - 2, mm));
      const minutesLate = (Date.now() - scheduledDt.getTime()) / 60000;
      if (minutesLate < 30) continue;

      await supabase.from("trips").update({ latestartnotified: true }).eq("id", t.id);

      let driverName = t.driverid;
      if (t.driverid) {
        const { data: driverRow } = await supabase.from("users").select("fullname").eq("id", t.driverid).maybeSingle();
        if (driverRow?.fullname) driverName = driverRow.fullname;
      }

      const nowTs = Date.now();
      const notifRows = [
        {
          title: "TRIP LATE START", type: "TRIP_LATE_START", forroles: ["ADMIN"], userid: null,
          message: `⚠ Trip ${t.id} hasn't started — scheduled for ${t.scheduleddate} ${t.scheduledtimestr}, driver ${driverName} still hasn't begun the pickup ${Math.floor(minutesLate)} min later.`,
          tripid: t.id, timestamp: nowTs, isread: false,
        },
      ];
      const driverMessage = `⚠ Trip ${t.id} was due to start at ${t.scheduledtimestr} — please begin the pickup or contact dispatch if there's a delay.`;
      if (t.driverid) {
        notifRows.push({
          title: "TRIP LATE START", type: "TRIP_LATE_START", forroles: ["DRIVER"], userid: t.driverid,
          message: driverMessage,
          tripid: t.id, timestamp: nowTs, isread: false,
        });
      }
      await supabase.from("notifications").insert(notifRows);
      // FOUND VIA AUDIT (2026-08-09): this function's whole documented
      // purpose is reliability regardless of whether anyone's logged in —
      // but it only ever wrote the DB row above, never actually pushed.
      // The driver most likely to actually be late and away from the app
      // (mid-shift, phone in a pocket) is exactly the one this couldn't
      // reach. Targeted only at the driver row — the admin row above stays
      // a broadcast, matching this project's existing admin-FYI pattern
      // elsewhere. Awaited (not fire-and-forget) since this function's
      // invocation ends shortly after returning — see
      // check-upcoming-reminders' identical comment for why.
      if (t.driverid && SUPABASE_URL && CRON_AUTH_TOKEN) {
        await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
          body: JSON.stringify({ user_ids: [t.driverid], title: "TRIP LATE START", message: driverMessage, type: "TRIP_LATE_START", trip_id: t.id, ts: nowTs }),
          signal: AbortSignal.timeout(15000),
        }).catch(e => console.warn("[check-late-start] push failed:", e.message));
      }
      flaggedCount++;
    }

    return new Response(JSON.stringify({ ok: true, checked: (confirmedTrips || []).length, flagged: flaggedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-late-start failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
