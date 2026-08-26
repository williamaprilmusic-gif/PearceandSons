// check-hours-compliance — Supabase Edge Function
//
// Server-side twin of the app's own DRIVER/CHECK_HOURS_COMPLIANCE sweep,
// same reasoning as check-document-expiry: the client-side version only
// runs while an admin has the app open, polled every 10 minutes from
// AdminApp — so driver-hours compliance silently paused for however long
// nobody was logged in. This runs the exact same check on a schedule
// instead. Advisory-only (never blocks dispatch) — see
// MAX_DRIVER_HOURS_PER_DAY/WEEK below and the app's own identical
// constants for why "hours worked" is derived from actual trip
// timestamps, not planned availability.
//
// Mirrors the app's own case closely — same 12h/day, 60h/week advisory
// thresholds, same hourscompliancenotifiedfor={date, notifiedAt} flag
// (fires at most once per calendar day per driver) — but is a SEPARATE
// implementation, since it runs server-side against the raw database
// (lowercase column names, no access to the app's own JS), not by
// importing app code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated shared secret for authenticating the pg_cron caller — NOT the
// service role key. See check-late-start's identical declaration for the
// full rationale.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const MAX_DRIVER_HOURS_PER_DAY = 12;
const MAX_DRIVER_HOURS_PER_WEEK = 60;

type TripRow = {
  driverid: string | number | null;
  status: string | null;
  bookedat: number | null;
  confirmedat: number | null;
  acceptedat: number | null;
  completedat: number | null;
};

// Same interval-merge approach as the app's own driverTripIntervalsMs —
// only trips that actually started (accepted/confirmed/booked) AND either
// completed or are still in transit contribute, and overlapping windows
// for the same driver (e.g. a merged multi-passenger trip reflected as
// more than one row) can't double-count the same minutes.
function driverTripIntervalsMs(driverId: string | number, trips: TripRow[], fromMs: number, toMs: number): number {
  const intervals: [number, number][] = [];
  for (const t of trips) {
    if (String(t.driverid) !== String(driverId)) continue;
    const start = t.acceptedat || t.confirmedat || t.bookedat;
    if (!start) continue;
    const end = t.completedat || (t.status === "IN_TRANSIT" ? Date.now() : null);
    if (!end || end <= start) continue;
    if (end < fromMs || start > toMs) continue;
    intervals.push([Math.max(start, fromMs), Math.min(end, toMs)]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.reduce((sum, [s, e]) => sum + (e - s), 0);
}

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // driver_status and trips are independent reads — FOUND VIA AUDIT:
    // these were awaited one after another; Promise.all cuts this run's
    // DB-wait time to roughly the slowest single query instead of the
    // sum of both.
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const [
      { data: driverStatusRows, error: dsError },
      { data: recentTripRows, error: tripError },
    ] = await Promise.all([
      supabase.from("driver_status").select("driverid, hourscompliancenotifiedfor"),
      // Filtered on scheduledtime, NOT bookedat — see the app's own
      // identical comment: a WEEK-type trip (booked up to 14 days in
      // advance, all days sharing nearly the same bookedat) can have its
      // actual driving day fall outside an 8-day bookedat window even
      // though scheduledtime always stays close to when it's actually
      // driven.
      supabase.from("trips")
        .select("driverid, status, bookedat, confirmedat, acceptedat, completedat")
        .gte("scheduledtime", eightDaysAgo),
    ]);
    if (dsError) throw dsError;
    if (tripError) throw tripError;
    if (!driverStatusRows || driverStatusRows.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, flagged: 0 }), { headers: { "Content-Type": "application/json" } });
    }
    const trips: TripRow[] = recentTripRows || [];

    // SAST (UTC+2) calendar date/week boundaries, NOT this runtime's own
    // UTC date — same correction check-document-expiry and check-late-
    // start already apply for the same reason: this function runs in
    // UTC, but scheduledtime/hours-compliance is reasoned about in SAST
    // wall-clock terms. Between 22:00-23:59 UTC (00:00-01:59 SAST, i.e.
    // already the next SAST day), a naive UTC-based "today" would still
    // read yesterday's date and wrongly skip a driver who's genuinely
    // over-limit on the new SAST day.
    const nowMs = Date.now();
    const sastShifted = new Date(nowMs + 2 * 3600000);
    const sY = sastShifted.getUTCFullYear(), sM = sastShifted.getUTCMonth(), sD = sastShifted.getUTCDate(), sDow = sastShifted.getUTCDay();
    const todayDateStr = `${sY}-${String(sM + 1).padStart(2, "0")}-${String(sD).padStart(2, "0")}`;
    const startOfDayMs = Date.UTC(sY, sM, sD, 0, 0, 0, 0) - 2 * 3600000;
    const diffToMonday = sDow === 0 ? 6 : sDow - 1;
    const startOfWeekMs = Date.UTC(sY, sM, sD - diffToMonday, 0, 0, 0, 0) - 2 * 3600000;

    // First pass: figure out which drivers are actually over-limit (pure
    // in-memory math against `trips`, no DB calls) before touching the
    // network again.
    type FlaggedDriver = { driverid: string | number; hoursToday: number; hoursWeek: number; overDay: boolean; overWeek: boolean };
    const flagged: FlaggedDriver[] = [];
    for (const ds of driverStatusRows) {
      const notified = ds.hourscompliancenotifiedfor || {};
      if (notified.date === todayDateStr) continue;

      const hoursToday = driverTripIntervalsMs(ds.driverid, trips, startOfDayMs, nowMs) / 3600000;
      const hoursWeek = driverTripIntervalsMs(ds.driverid, trips, startOfWeekMs, nowMs) / 3600000;
      const overDay = hoursToday >= MAX_DRIVER_HOURS_PER_DAY;
      const overWeek = hoursWeek >= MAX_DRIVER_HOURS_PER_WEEK;
      if (!overDay && !overWeek) continue;
      flagged.push({ driverid: ds.driverid, hoursToday, hoursWeek, overDay, overWeek });
    }

    // Driver names, batched into ONE query up front — FOUND VIA AUDIT:
    // this used to run one `users` lookup per flagged driver INSIDE the
    // loop below, the exact N+1 pattern check-trip-timing's own header
    // comment already calls out and fixes for its own sweeps.
    const driverNameById: Record<string, string> = {};
    if (flagged.length > 0) {
      const { data: driverRows } = await supabase.from("users").select("id, fullname").in("id", flagged.map(f => f.driverid));
      for (const d of driverRows || []) driverNameById[String(d.id)] = d.fullname;
    }

    for (const { driverid, hoursToday, hoursWeek, overDay, overWeek } of flagged) {
      const driverName = driverNameById[String(driverid)] || String(driverid);
      const reason = overDay && overWeek
        ? `${hoursToday.toFixed(1)}h today and ${hoursWeek.toFixed(1)}h this week`
        : overDay ? `${hoursToday.toFixed(1)}h today` : `${hoursWeek.toFixed(1)}h this week`;

      // Admin-only per explicit request — same fix as the app's own
      // identical client-side sweep (DRIVER/CHECK_HOURS_COMPLIANCE):
      // used to also insert a driver-facing row here; removed so
      // hours-compliance stays an admin-facing advisory only.
      await supabase.from("notifications").insert([
        {
          title: "DRIVER HOURS WARNING", type: "DRIVER_HOURS_WARNING", forroles: ["ADMIN"], userid: null,
          message: `⚠ ${driverName} has logged ${reason} — approaching/over the advisory limit (${MAX_DRIVER_HOURS_PER_DAY}h/day, ${MAX_DRIVER_HOURS_PER_WEEK}h/week).`,
          timestamp: nowMs, isread: false,
        },
      ]);
      await supabase.from("driver_status").update({ hourscompliancenotifiedfor: { date: todayDateStr, notifiedAt: nowMs } }).eq("driverid", driverid);
    }

    return new Response(JSON.stringify({ ok: true, checked: driverStatusRows.length, flagged: flagged.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-hours-compliance failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
