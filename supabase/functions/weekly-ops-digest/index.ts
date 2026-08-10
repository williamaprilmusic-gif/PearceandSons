// weekly-ops-digest/index.ts
// Sends a weekly ops summary email (SLA on-time report + fleet
// utilization breakdown, past 7 days) via Resend, modeled directly on
// daily-trip-sheet's own shape (same auth pattern, same HTML style, same
// CSV-attachment convention).
//
// Ports the app's own computeSlaReport/computeFleetUtilization logic
// (TransitOS_web.jsx) against the raw database schema (lowercase column
// names) — a SEPARATE implementation, not an import of app code, same
// reasoning as every other edge function in this project that mirrors a
// client-side computation.
//
// TEMPORARY STOPGAP: FROM is onboarding@resend.dev (Resend's sandbox
// domain), TO is the owner's own verified address — same constraint
// daily-trip-sheet/trip-history-retention already flag in their own
// header comments. Change both once a real sending domain is verified at
// resend.com/domains.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SLA_GRACE_MINUTES = 10;

Deno.serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Dedicated shared secret for authenticating the pg_cron caller — see
  // check-late-start's identical declaration for the full rationale.
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!RESEND_KEY) return json({ error: "Missing Resend_API_Key secret" }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const now = new Date();
  const sevenDaysAgo = now.getTime() - 7 * 24 * 60 * 60 * 1000;

  const { data: trips, error: tripErr } = await sb
    .from("trips")
    .select("id, status, driverid, scheduledtime, intransitat, confirmedat, completedat, bookedat, noshows")
    .eq("status", "ARCHIVED_COMPLETED")
    .gte("completedat", sevenDaysAgo);
  if (tripErr) {
    console.error("DB error (trips):", tripErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const { data: drivers } = await sb.from("users").select("id, fullname").eq("role", "DRIVER");
  const driverName = (id: unknown) => (drivers ?? []).find((d: { id: unknown }) => String(d.id) === String(id))?.fullname || String(id ?? "");

  // ── Open tickets/disputes — current snapshot, not a 7-day window ───────
  // Per explicit follow-up: tickets/disputes only ever fired ONE
  // notification when opened and never resurfaced (see check-stale-
  // oversight, which now re-escalates them directly) — this line gives
  // admins a standing weekly reminder of the current backlog even for
  // ones still inside their first 24h grace window. Same OPEN/DRIVER_
  // RESPONDED "still needs an admin decision" filter check-stale-
  // oversight uses for disputes.
  const { data: openTicketsRows } = await sb.from("tickets").select("id").eq("status", "OPEN");
  const { data: openDisputeRows } = await sb.from("trips").select("id")
    .not("dispute", "is", null)
    .or("dispute->>state.eq.OPEN,dispute->>state.eq.DRIVER_RESPONDED");
  const openTicketCount = (openTicketsRows ?? []).length;
  const openDisputeCount = (openDisputeRows ?? []).length;

  // ── SLA on-time report — mirrors computeSlaReport exactly ──────────────
  type SlaAgg = { name: string; total: number; onTime: number; lateMin: number[] };
  const slaByDriver: Record<string, SlaAgg> = {};
  for (const t of trips ?? []) {
    if (!t.driverid || !t.scheduledtime || !t.intransitat) continue;
    const deltaMin = (Number(t.intransitat) - Number(t.scheduledtime)) / 60000;
    const onTime = deltaMin <= SLA_GRACE_MINUTES;
    const key = String(t.driverid);
    if (!slaByDriver[key]) slaByDriver[key] = { name: driverName(t.driverid), total: 0, onTime: 0, lateMin: [] };
    slaByDriver[key].total++;
    if (onTime) slaByDriver[key].onTime++;
    else slaByDriver[key].lateMin.push(Math.round(deltaMin));
  }
  const slaRows = Object.values(slaByDriver).map(d => ({
    ...d,
    rate: d.total > 0 ? d.onTime / d.total : null,
    avgLateMin: d.lateMin.length > 0 ? Math.round(d.lateMin.reduce((a, b) => a + b, 0) / d.lateMin.length) : 0,
  })).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
  const slaOverall = slaRows.reduce((acc, d) => ({ total: acc.total + d.total, onTime: acc.onTime + d.onTime }), { total: 0, onTime: 0 });
  const slaOverallRate = slaOverall.total > 0 ? slaOverall.onTime / slaOverall.total : null;

  // ── Fleet utilization — mirrors computeFleetUtilization exactly ────────
  type UtilRow = { driver_id: string; driver_name: string; trips: number; driving_ms: number; loading_ms: number; gap_ms: number };
  type TripRow = Record<string, unknown> & { driverid?: unknown; confirmedat?: number; bookedat?: number; intransitat?: number; completedat?: number };
  const byDriverTrips: Record<string, TripRow[]> = {};
  for (const t of (trips ?? []) as TripRow[]) {
    if (!t.driverid) continue;
    const key = String(t.driverid);
    (byDriverTrips[key] = byDriverTrips[key] || []).push(t);
  }
  const utilRows: UtilRow[] = [];
  for (const driverId of Object.keys(byDriverTrips)) {
    const sorted = [...(byDriverTrips[driverId] ?? [])].sort((a, b) => (Number(a.confirmedat) || Number(a.bookedat) || 0) - (Number(b.confirmedat) || Number(b.bookedat) || 0));
    let drivingMs = 0, loadingMs = 0, gapMs = 0;
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const confirmedAt = t.confirmedat, inTransitAt = t.intransitat, completedAt = t.completedat;
      if (confirmedAt && inTransitAt && inTransitAt > confirmedAt) loadingMs += inTransitAt - confirmedAt;
      if (inTransitAt && completedAt && completedAt > inTransitAt) drivingMs += completedAt - inTransitAt;
      const next = sorted[i + 1];
      if (next && completedAt) {
        const nextStart = next.confirmedat || next.bookedat;
        if (nextStart && nextStart > completedAt && new Date(completedAt).toDateString() === new Date(nextStart).toDateString()) {
          gapMs += nextStart - completedAt;
        }
      }
    }
    utilRows.push({ driver_id: driverId, driver_name: driverName(driverId), trips: sorted.length, driving_ms: drivingMs, loading_ms: loadingMs, gap_ms: gapMs });
  }
  utilRows.sort((a, b) => b.driving_ms - a.driving_ms);

  const totalNoShows = (trips ?? []).reduce((n, t) => n + ((t.noshows as unknown[]) ?? []).length, 0);
  const hrs = (ms: number) => (ms / 3600000).toFixed(1);

  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

  const slaTable = slaRows.length === 0
    ? `<p style="color:#555;font-style:italic;padding:12px 0">No completed trips with timing data this week.</p>`
    : `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid #2a2a2a">
          <th style="text-align:left;color:#888;padding:5px 8px">Driver</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Trips</th>
          <th style="text-align:left;color:#888;padding:5px 8px">On-Time %</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Avg Late (min)</th>
        </tr></thead>
        <tbody>${slaRows.map(d => `<tr>
          <td style="padding:7px 8px;font-weight:700;color:#fff">${esc(d.name)}</td>
          <td style="padding:7px 8px">${d.total}</td>
          <td style="padding:7px 8px;color:${d.rate == null ? "#888" : d.rate >= 0.9 ? "#1db954" : d.rate >= 0.7 ? "#f5a623" : "#e83a3a"};font-weight:700">${d.rate != null ? Math.round(d.rate * 100) + "%" : "—"}</td>
          <td style="padding:7px 8px;color:#aaa">${d.avgLateMin > 0 ? d.avgLateMin : "—"}</td>
        </tr>`).join("")}</tbody>
      </table>`;

  const utilTable = utilRows.length === 0
    ? `<p style="color:#555;font-style:italic;padding:12px 0">No completed trips this week.</p>`
    : `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid #2a2a2a">
          <th style="text-align:left;color:#888;padding:5px 8px">Driver</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Trips</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Driving (h)</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Loading (h)</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Gap (h)</th>
        </tr></thead>
        <tbody>${utilRows.map(d => `<tr>
          <td style="padding:7px 8px;font-weight:700;color:#fff">${esc(d.driver_name)}</td>
          <td style="padding:7px 8px">${d.trips}</td>
          <td style="padding:7px 8px;color:#aaa">${hrs(d.driving_ms)}</td>
          <td style="padding:7px 8px;color:#aaa">${hrs(d.loading_ms)}</td>
          <td style="padding:7px 8px;color:#aaa">${hrs(d.gap_ms)}</td>
        </tr>`).join("")}</tbody>
      </table>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">

  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">📊 Weekly Ops Digest</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST · past 7 days</p>
  </div>

  <div style="display:flex;gap:12px;margin-bottom:20px">
    ${[
      [slaOverall.total, "Trips Completed"],
      [slaOverallRate != null ? Math.round(slaOverallRate * 100) + "%" : "—", "Overall On-Time"],
      [totalNoShows, "No-Shows"],
      [utilRows.length, "Drivers Active"],
    ].map(([n, l]) => `<div style="background:#1a1a1a;border-radius:6px;padding:12px 18px;flex:1;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#f5a623">${n}</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:2px">${l}</div>
    </div>`).join("")}
  </div>

  <div style="display:flex;gap:12px;margin-bottom:20px">
    ${[
      [openTicketCount, "Open Tickets", openTicketCount > 0 ? "#f5a623" : "#1db954"],
      [openDisputeCount, "Open Disputes", openDisputeCount > 0 ? "#e83a3a" : "#1db954"],
    ].map(([n, l, c]) => `<div style="background:#1a1a1a;border-radius:6px;padding:10px 18px;flex:1;text-align:center">
      <div style="font-size:22px;font-weight:800;color:${c}">${n}</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:2px">${l}</div>
    </div>`).join("")}
  </div>
  <p style="font-size:10px;color:#555;margin-top:-14px;margin-bottom:20px">Current backlog snapshot, not scoped to the past 7 days — an admin now also gets a re-escalation alert for any ticket/dispute still open 24h+ (see check-stale-oversight), this is just the standing weekly total.</p>

  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    ⏱ SLA On-Time Report (${SLA_GRACE_MINUTES} min grace)
  </div>
  ${slaTable}

  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    🚐 Fleet Utilization
  </div>
  ${utilTable}
  <p style="font-size:10px;color:#555;margin-top:6px">Gap only counts time between two trips on the same calendar day — an overnight gap is off-duty time, not idle time (v1-scope limitation, matches the in-app Fleet Utilization screen's own caption).</p>

  <div style="margin-top:28px;font-size:11px;color:#444;border-top:1px solid #1e1e1e;padding-top:12px">
    Pearce &amp; Sons Fleet Operations · Automated Weekly Report
  </div>
</div></body></html>`;

  const subject = `📊 Weekly Ops Digest — ${slaOverall.total} trips, ${slaOverallRate != null ? Math.round(slaOverallRate * 100) + "%" : "—"} on-time`;

  // ── CSV attachment ────────────────────────────────────────────────────
  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // formula-injection guard, same as daily-trip-sheet
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = ["Driver", "Trips Completed", "On-Time %", "Avg Late (min)", "Driving (h)", "Loading (h)", "Gap (h)"];
  const utilByDriverId: Record<string, UtilRow> = Object.fromEntries(utilRows.map(u => [u.driver_id, u]));
  const csvRows = slaRows.map(d => {
    const util = Object.values(utilByDriverId).find(u => u.driver_name === d.name);
    return [
      d.name, d.total, d.rate != null ? Math.round(d.rate * 100) : "", d.avgLateMin || "",
      util ? hrs(util.driving_ms) : "", util ? hrs(util.loading_ms) : "", util ? hrs(util.gap_ms) : "",
    ].map(csvCell).join(",");
  });
  const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvRows].join("\r\n"); // BOM for Excel
  const csvFilename = `weekly-ops-digest_${now.toISOString().slice(0, 10)}.csv`;
  const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

  console.log("Sending email:", subject, "| CSV rows:", csvRows.length);

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO], subject, html,
      attachments: [{ filename: csvFilename, content: csvBase64 }],
    }),
    signal: AbortSignal.timeout(20000),
  });

  const resendBody = await resendRes.json();
  if (!resendRes.ok) {
    console.error("Resend failed:", resendRes.status, JSON.stringify(resendBody));
    return json({ error: `Resend ${resendRes.status}: ${JSON.stringify(resendBody)}`, from: FROM, to: TO }, 500);
  }

  console.log("Email sent! Resend id:", resendBody.id);
  return json({ ok: true, to: TO, subject, tripsCompleted: slaOverall.total, resendId: resendBody.id });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
