// check-unassigned-approaching — Supabase Edge Function
//
// Server-side half of the "booking still has no driver as its scheduled
// time approaches" warning, same reasoning as check-late-start: a
// client-side check only fires while someone has the app open, this
// scheduled version fires reliably regardless.
//
// check-late-start only ever watches trips already at DRIVER_CONFIRMED
// (a driver was assigned but never actually started the pickup) — it
// never looks at UNASSIGNED_BOOKING at all, so a booking that never even
// got a driver assigned was invisible until an admin happened to notice
// it on the Dispatch board themselves. This closes that gap: finds every
// trip still at UNASSIGNED_BOOKING within 2 hours of its scheduled time
// that hasn't already been flagged, then notifies admins.
//
// Mirrors the app's own TRIP/CHECK_UNASSIGNED_APPROACHING action closely
// — same 2-hour threshold, same unassignedapproachingnotified flag to
// avoid re-firing — but is a SEPARATE implementation, since it runs
// server-side against the raw database (lowercase column names, no
// access to the app's own JS), not by importing app code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated shared secret for authenticating the pg_cron caller — NOT the
// service role key. See check-late-start's identical declaration for the
// full rationale (this project's service-role key format drifted from
// what pg_cron's hardcoded header expects; a literal edge-function secret,
// under this codebase's direct control, can't drift the same way).
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const UNASSIGNED_WARN_MS = 2 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: unassignedTrips, error } = await supabase
      .from("trips")
      .select("*")
      .eq("status", "UNASSIGNED_BOOKING")
      .or("unassignedapproachingnotified.is.null,unassignedapproachingnotified.eq.false");
    if (error) throw error;

    let flaggedCount = 0;
    for (const t of unassignedTrips || []) {
      // scheduleddate is "YYYY/MM/DD", scheduledtimestr is "HH:MM" — same
      // parsing convention as check-late-start.
      const [y, m, d] = (t.scheduleddate || "").split("/").map(Number);
      const [hh, mm] = (t.scheduledtimestr || "").split(":").map(Number);
      if (!y || !m || !d || hh == null || mm == null) continue; // malformed — skip rather than false-positive
      // scheduleddate/time are SAST (UTC+2) wall-clock values, but this
      // function runs in UTC — see check-late-start's identical comment
      // for why the -2 offset is needed here.
      const scheduledDt = new Date(Date.UTC(y, m - 1, d, hh - 2, mm));
      const msUntil = scheduledDt.getTime() - Date.now();
      if (msUntil > UNASSIGNED_WARN_MS || msUntil < 0) continue; // not yet in window, or already passed

      await supabase.from("trips").update({ unassignedapproachingnotified: true }).eq("id", t.id);

      const nowTs = Date.now();
      await supabase.from("notifications").insert([{
        title: "BOOKING UNASSIGNED", type: "TRIP_UNASSIGNED_APPROACHING", forroles: ["ADMIN"], userid: null,
        message: `⚠ Booking ${t.id} still has no driver — scheduled for ${t.scheduleddate} ${t.scheduledtimestr}, ${Math.round(msUntil / 60000)} min away.`,
        tripid: t.id, timestamp: nowTs, isread: false,
      }]);
      flaggedCount++;
    }

    return new Response(JSON.stringify({ ok: true, checked: (unassignedTrips || []).length, flagged: flaggedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-unassigned-approaching failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
