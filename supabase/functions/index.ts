// Daily Trip Sheet — Supabase Edge Function
//
// Generates a CSV of every trip scheduled for a given date (defaults to
// "yesterday" in Africa/Johannesburg time, i.e. Cape Town) and emails it
// as an attachment to app@pearceandsons.co.za. Runs on a daily cron
// schedule (see schedule.sql — pg_cron + pg_net) so it fires even if
// nobody has the app open, per explicit requirement. Per explicit
// decision, this does NOT save anything to Supabase Storage — email
// only, nothing else to configure or clean up.
//
// This mirrors exportTripsToCsv()'s column structure from the main app
// (TransitOS_web.jsx) as closely as possible, but is a SEPARATE
// implementation — it runs server-side against the raw `trips` table
// (lowercase column names, no client-side tripRowToApp mapping
// available here), not by importing app code. If you change the CSV
// columns in the app, mirror the change here too.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// Hardcoded per explicit request — still overridable via the
// TRIP_SHEET_RECIPIENTS env var (comma-separated) if the destination
// ever needs to change without redeploying the function.
const TRIP_SHEET_RECIPIENTS = (Deno.env.get("TRIP_SHEET_RECIPIENTS") || "app@pearceandsons.co.za")
  .split(",").map(s => s.trim()).filter(Boolean);
const TRIP_SHEET_FROM = Deno.env.get("TRIP_SHEET_FROM") || "trips@pearceandsons.co.za";

function escapeCsv(val) {
  const s = val == null ? "" : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function fmtTs(epochMs) {
  return epochMs ? new Date(epochMs).toLocaleString("en-ZA") : "";
}

function fmtLoc(loc) {
  return loc && loc.lat != null ? `${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}` : "";
}

// Builds the CSV for every trip scheduled on `dateStr` (app's own
// "YYYY/MM/DD" string format, matching trips.scheduleddate exactly —
// this is a plain text column, not a real date type, per the app's
// existing schema).
async function buildTripSheetCsv(supabase, dateStr) {
  const { data: trips, error: tripsErr } = await supabase
    .from("trips")
    .select("*")
    .eq("scheduleddate", dateStr)
    .order("id", { ascending: true });
  if (tripsErr) throw tripsErr;

  const { data: users, error: usersErr } = await supabase.from("users").select("id, fullname");
  if (usersErr) throw usersErr;
  const nameById = Object.fromEntries((users || []).map(u => [u.id, u.fullname]));

  const tripIds = (trips || []).map(t => t.id);
  const { data: delays } = tripIds.length
    ? await supabase.from("trip_delays").select("*").in("tripid", tripIds)
    : { data: [] };
  const delaysByTrip = {};
  for (const d of delays || []) (delaysByTrip[d.tripid] ||= []).push(d);

  const { data: auditEntries } = tripIds.length
    ? await supabase.from("audit_logs").select("*").in("tripid", tripIds)
    : { data: [] };
  const auditByTrip = {};
  for (const a of auditEntries || []) (auditByTrip[a.tripid] ||= []).push(a);

  const headers = [
    "Trip ID", "Exception", "Direction", "Trip Type", "Agent", "Driver", "Status",
    "Pickup", "Drop-off", "Scheduled Date", "Scheduled Time",
    "Booked At", "Driver Confirmed At", "Agent Picked Up At", "Pickup Location (lat,lng)", "Agent Dropped Off At", "Dropoff Location (lat,lng)",
    "Distance (km)", "Driver's Full Route (km)", "Long Distance", "No Show", "Delay/Detour Reported", "Admin Edits", "Admin Note", "Phone",
  ];

  const rows = [];
  for (const t of trips || []) {
    const agentIds = [t.agentid, ...(t.extraagentids || [])].filter(Boolean);
    const idsToIterate = agentIds.length ? agentIds : [null];
    const pickupTimestamps = t.pickuptimestamps || {};
    const pickupLocations = t.pickuplocations || {};
    const dropoffTimestamps = t.dropofftimestamps || {};
    const dropoffLocations = t.dropofflocations || {};

    const delaySummary = (delaysByTrip[t.id] || [])
      .map(d => `${d.reason}${d.note ? ` (${d.note})` : ""} @ ${fmtTs(d.reportedat)}`)
      .join(" | ");
    const auditSummary = (auditByTrip[t.id] || [])
      .map(a => `${a.username} — ${a.actiontype}${a.details ? ` (${a.details})` : ""} @ ${fmtTs(a.timestamp)}`)
      .join(" | ");
    const noShowSummary = (t.noshows || [])
      .map(ns => {
        const nm = nameById[ns.agent_id] || ns.agent_id;
        const loc = ns.location ? ` @ ${ns.location.lat?.toFixed?.(5)},${ns.location.lng?.toFixed?.(5)}` : "";
        const note = ns.note ? ` — "${ns.note}"` : "";
        return `${nm}${loc}${note}`;
      })
      .join("; ");

    for (const aid of idsToIterate) {
      rows.push([
        t.id, t.isexception ? "E" : "", t.direction || "", t.triptype || "",
        aid != null ? (nameById[aid] || aid) : (t.agentname || ""), nameById[t.driverid] || "", t.status,
        t.pickuplocation || "", t.dropofflocation || "",
        t.scheduleddate || "", t.scheduledtimestr || "",
        t.bookedat ? fmtTs(t.bookedat) : "", t.confirmedat ? fmtTs(t.confirmedat) : "",
        fmtTs(aid != null ? pickupTimestamps[aid] : null),
        fmtLoc(aid != null ? pickupLocations[aid] : null),
        fmtTs(aid != null ? dropoffTimestamps[aid] : null),
        fmtLoc(aid != null ? dropoffLocations[aid] : null),
        t.estdistancekm != null ? (t.estdistancekm * 1.35).toFixed(1) : "",
        t.routetotalkm != null ? t.routetotalkm.toFixed(1) : "",
        t.longdistanceflag ? "YES" : "NO",
        noShowSummary, delaySummary, auditSummary,
        t.adminnote || "", t.phone || "",
      ]);
    }
  }

  const lines = [headers, ...rows].map(r => r.map(escapeCsv).join(","));
  return { csv: lines.join("\n"), tripCount: (trips || []).length };
}

async function sendEmail(dateStr, csv, tripCount) {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured — email is the only output this function produces, so there's nothing else for it to do. Set it with: supabase secrets set RESEND_API_KEY=your_key");
  }
  const base64Csv = btoa(unescape(encodeURIComponent(csv)));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: TRIP_SHEET_FROM,
      to: TRIP_SHEET_RECIPIENTS,
      subject: `Daily Trip Sheet — ${dateStr} (${tripCount} trip${tripCount !== 1 ? "s" : ""})`,
      text: `Attached is the trip sheet for ${dateStr}, covering ${tripCount} trip${tripCount !== 1 ? "s" : ""}. This was generated automatically.`,
      attachments: [{ filename: `trip-sheet-${dateStr.replace(/\//g, "-")}.csv`, content: base64Csv }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }
  return { sent: true };
}

Deno.serve(async (req) => {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured for this function.");
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Defaults to "yesterday" in Cape Town time — this function is meant
    // to run early the NEXT morning (see the cron schedule), summarizing
    // the day that just finished, not the day still in progress. A
    // specific date can still be requested manually via ?date=YYYY/MM/DD
    // for backfilling a missed day.
    const url = new URL(req.url);
    const requestedDate = url.searchParams.get("date");
    const dateStr = requestedDate || (() => {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Johannesburg" }));
      now.setDate(now.getDate() - 1);
      const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, "0"), d = String(now.getDate()).padStart(2, "0");
      return `${y}/${m}/${d}`;
    })();

    const { csv, tripCount } = await buildTripSheetCsv(supabase, dateStr);
    const emailResult = await sendEmail(dateStr, csv, tripCount);

    return new Response(JSON.stringify({ ok: true, date: dateStr, tripCount, emailSent: emailResult.sent, sentTo: TRIP_SHEET_RECIPIENTS }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[daily-trip-sheet] failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
