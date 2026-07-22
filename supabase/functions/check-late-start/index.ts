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

Deno.serve(async (_req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: confirmedTrips, error } = await supabase
      .from("trips")
      .select("*")
      .eq("status", "DRIVER_CONFIRMED")
      .or("latestartnotified.is.null,latestartnotified.eq.false");
    if (error) throw error;

    let flaggedCount = 0;
    for (const t of confirmedTrips || []) {
      // scheduleddate is "YYYY/MM/DD", scheduledtime is "HH:MM" — same
      // parsing convention the main app uses throughout.
      const [y, m, d] = (t.scheduleddate || "").split("/").map(Number);
      const [hh, mm] = (t.scheduledtime || "").split(":").map(Number);
      if (!y || !m || !d || hh == null || mm == null) continue; // malformed — skip rather than false-positive
      const scheduledDt = new Date(y, m - 1, d, hh, mm);
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
          message: `⚠ Trip ${t.id} hasn't started — scheduled for ${t.scheduleddate} ${t.scheduledtime}, driver ${driverName} still hasn't begun the pickup ${Math.floor(minutesLate)} min later.`,
          tripid: t.id, timestamp: nowTs, isread: false,
        },
      ];
      if (t.driverid) {
        notifRows.push({
          title: "TRIP LATE START", type: "TRIP_LATE_START", forroles: ["DRIVER"], userid: t.driverid,
          message: `⚠ Trip ${t.id} was due to start at ${t.scheduledtime} — please begin the pickup or contact dispatch if there's a delay.`,
          tripid: t.id, timestamp: nowTs, isread: false,
        });
      }
      await supabase.from("notifications").insert(notifRows);
      flaggedCount++;
    }

    return new Response(JSON.stringify({ ok: true, checked: (confirmedTrips || []).length, flagged: flaggedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
