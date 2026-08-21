// check-shift-duration — Supabase Edge Function
//
// Server-side twin of the app's own DRIVER/CHECK_SHIFT_DURATION sweep,
// same reasoning as check-hours-compliance: the client-side version only
// runs while an admin has the app open, polled every 10 minutes from
// AdminApp — so this would silently pause for however long nobody was
// logged in. This runs the exact same check on a schedule instead.
//
// Deliberately a SEPARATE signal from check-hours-compliance/
// MAX_DRIVER_HOURS_PER_DAY-WEEK: those measure cumulative TRIP DRIVING
// time (only actual trip intervals count); this measures CONTINUOUS
// ONLINE time (driver_status.shiftstartedat, set at login and cleared at
// logout — idle/waiting time between trips counts too), so a driver who's
// been on shift 10+ hours with lots of downtime between short trips still
// trips this even while comfortably under the daily driving-hours cap.
// This was originally scoped out entirely ("there's no shift-start
// timestamp anywhere in driver_status... would need a real schema
// change") until shiftstartedat/shiftdurationnotifiedat were added.
//
// Advisory-only (never blocks dispatch). shiftdurationnotifiedat de-dups
// to at most once per continuous shift (reset to null on every fresh
// login), same shape as hourscompliancenotifiedfor's per-calendar-day dedup.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated shared secret for authenticating the pg_cron caller — NOT the
// service role key. See check-late-start's identical declaration for the
// full rationale.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const MAX_CONTINUOUS_SHIFT_HOURS = 10;

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: shiftRows, error: dsError } = await supabase
      .from("driver_status")
      .select("driverid, shiftstartedat")
      .eq("isonline", true)
      .not("shiftstartedat", "is", null)
      .is("shiftdurationnotifiedat", null);
    if (dsError) throw dsError;
    if (!shiftRows || shiftRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, flagged: 0 }), { headers: { "Content-Type": "application/json" } });
    }

    const nowMs = Date.now();
    const thresholdMs = MAX_CONTINUOUS_SHIFT_HOURS * 3600000;
    const overShift = shiftRows.filter(r => nowMs - r.shiftstartedat >= thresholdMs);
    if (overShift.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: shiftRows.length, flagged: 0 }), { headers: { "Content-Type": "application/json" } });
    }

    // Driver names, batched into ONE query up front — same N+1 avoidance
    // as check-hours-compliance's own identical fix.
    const driverNameById: Record<string, string> = {};
    const { data: driverRows } = await supabase.from("users").select("id, fullname").in("id", overShift.map(r => r.driverid));
    for (const d of driverRows || []) driverNameById[String(d.id)] = d.fullname;

    for (const r of overShift) {
      const driverName = driverNameById[String(r.driverid)] || String(r.driverid);
      const hoursOnShift = ((nowMs - r.shiftstartedat) / 3600000).toFixed(1);

      await supabase.from("notifications").insert([
        {
          title: "DRIVER SHIFT WARNING", type: "DRIVER_SHIFT_DURATION_WARNING", forroles: ["ADMIN"], userid: null,
          message: `⚠ ${driverName} has been on a continuous shift for ${hoursOnShift}h — exceeds the ${MAX_CONTINUOUS_SHIFT_HOURS}h advisory threshold.`,
          timestamp: nowMs, isread: false,
        },
        {
          title: "DRIVER SHIFT WARNING", type: "DRIVER_SHIFT_DURATION_WARNING", forroles: ["DRIVER"], userid: r.driverid,
          message: `⚠ You've been on shift for ${hoursOnShift}h continuously — please plan for adequate rest.`,
          timestamp: nowMs, isread: false,
        },
      ]);
      await supabase.from("driver_status").update({ shiftdurationnotifiedat: nowMs }).eq("driverid", r.driverid);
    }

    return new Response(JSON.stringify({ ok: true, checked: shiftRows.length, flagged: overShift.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-shift-duration failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
