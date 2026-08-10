// monthly-billing-export/index.ts
// Sends a monthly billing email (Trip Fee + Driver Payment CSV, prior
// calendar month) via Resend, modeled on daily-trip-sheet/weekly-ops-
// digest's own shape (same auth pattern, same HTML style, same
// CSV-attachment convention).
//
// Ports the app's own agentFeeCategory/agentFeeAmount/tripDriverPayment
// billing model (TransitOS_web.jsx) against the raw database schema
// (lowercase column names) — a SEPARATE implementation, not an import of
// app code. Mirrors the exact per-agent billing model documented in the
// app's own exportTripsToCsv comments (2026-08-08 redesign): Trip Fee
// bills each agent's own outcome at the FULL category rate (not split);
// Driver Pay - Per Agent is each successfully-dropped-off agent's own
// flat share; Driver Pay - Extra KM is a genuine trip-level cost split
// evenly (in integer cents, remainder to the last agent) across every
// agent on the trip. Only ARCHIVED_COMPLETED/ARCHIVED_CANCELLED trips are
// billable — everything else is excluded outright (a monthly bill has no
// use for a "pending" row the client CSV export shows at R0).
//
// TEMPORARY STOPGAP: FROM is onboarding@resend.dev (Resend's sandbox
// domain), TO is the owner's own verified address — same constraint
// daily-trip-sheet/trip-history-retention/weekly-ops-digest already flag
// in their own header comments. Change both once a real sending domain is
// verified at resend.com/domains.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ROAD_FACTOR = 1.35; // same straight-line-to-road approximation used elsewhere in the app

type FeeRates = {
  normalzar: number; latebookingzar: number; latecancellationzar: number; noshowzar: number;
  driverpayperagentzar: number; driverpayperextrakmzar: number;
};

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

  // ── Prior SAST calendar month's [start, end) as UTC epoch ms ───────────
  // This function runs in UTC, but scheduledtime is reasoned about in
  // SAST (UTC+2) wall-clock terms, same -2h correction every other edge
  // function in this project applies for the same reason.
  const now = new Date();
  const sastShifted = new Date(now.getTime() + 2 * 3600000);
  const sY = sastShifted.getUTCFullYear(), sM = sastShifted.getUTCMonth();
  const monthStartMs = Date.UTC(sY, sM - 1, 1, 0, 0, 0, 0) - 2 * 3600000;
  const monthEndMs = Date.UTC(sY, sM, 1, 0, 0, 0, 0) - 2 * 3600000;
  const monthLabel = new Date(Date.UTC(sY, sM - 1, 1)).toLocaleDateString("en-ZA", { month: "long", year: "numeric", timeZone: "UTC" });

  const { data: feeRatesRow, error: feeErr } = await sb.from("trip_fee_rates").select("*").eq("id", 1).maybeSingle();
  if (feeErr || !feeRatesRow) {
    console.error("DB error (trip_fee_rates):", feeErr?.message ?? "no row");
    return json({ error: "Internal error — please try again." }, 500);
  }
  const feeRates = feeRatesRow as FeeRates;

  const { data: trips, error: tripErr } = await sb
    .from("trips")
    .select("id, status, scheduleddate, driverid, agentid, extraagentids, latebookingflag, noshows, completeddropoffs, actualdistancekm, estdistancekm")
    .in("status", ["ARCHIVED_COMPLETED", "ARCHIVED_CANCELLED"])
    .gte("scheduledtime", monthStartMs)
    .lt("scheduledtime", monthEndMs);
  if (tripErr) {
    console.error("DB error (trips):", tripErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const { data: users } = await sb.from("users").select("id, fullname");
  const userName = (id: unknown) => (users ?? []).find((u: { id: unknown }) => String(u.id) === String(id))?.fullname || String(id ?? "");

  // ── Per-agent billing model — mirrors agentFeeCategory/agentFeeAmount/
  // agentDriverPayShare/extraKmShareCentsByIdx exactly. ──────────────────
  function agentFeeCategory(t: Record<string, unknown>, aid: unknown): string {
    const status = t.status as string;
    const isResolved = status === "ARCHIVED_COMPLETED" || status === "ARCHIVED_CANCELLED";
    if (!isResolved) return "pending";
    if (status === "ARCHIVED_CANCELLED") return "late_cancellation";
    const noShows = (t.noshows as { agent_id: unknown }[]) ?? [];
    const thisAgentNoShow = aid != null && noShows.some(ns => String(ns.agent_id) === String(aid));
    if (thisAgentNoShow) return "no_show";
    if (t.latebookingflag) return "late_booking";
    return "normal";
  }
  function agentFeeAmount(t: Record<string, unknown>, aid: unknown): number {
    const cat = agentFeeCategory(t, aid);
    if (cat === "pending") return 0;
    return cat === "late_cancellation" ? feeRates.latecancellationzar
      : cat === "no_show" ? feeRates.noshowzar
      : cat === "late_booking" ? feeRates.latebookingzar
      : feeRates.normalzar;
  }
  function agentDriverPayShare(t: Record<string, unknown>, aid: unknown): number {
    if (t.status !== "ARCHIVED_COMPLETED" || aid == null) return 0;
    const completedDropoffs = t.completeddropoffs as unknown[] | null;
    const wasSuccessful = completedDropoffs != null ? completedDropoffs.map(String).includes(String(aid)) : true;
    return wasSuccessful ? feeRates.driverpayperagentzar : 0;
  }
  function tripExtraKmDriverPay(t: Record<string, unknown>): number {
    if (t.status !== "ARCHIVED_COMPLETED") return 0;
    const actualKm = t.actualdistancekm as number | null;
    const estKm = t.estdistancekm as number | null;
    const roadKm = actualKm != null ? actualKm * ROAD_FACTOR : estKm != null ? estKm * ROAD_FACTOR : 0;
    const extraKm = Math.max(0, roadKm - 40);
    return extraKm * feeRates.driverpayperextrakmzar;
  }

  const categoryOrder = ["normal", "late_booking", "late_cancellation", "no_show"];
  const categoryLabel: Record<string, string> = { normal: "Normal", late_booking: "Late Booking", late_cancellation: "Late Cancellation", no_show: "No Show" };
  const categoryTotals: Record<string, { count: number; fee: number; driverPay: number }> = Object.fromEntries(categoryOrder.map(c => [c, { count: 0, fee: 0, driverPay: 0 }]));
  let grandTotalFee = 0, grandTotalDriverPayPerAgent = 0, grandTotalDriverPayExtraKm = 0;

  type CsvRow = { tripId: unknown; date: unknown; agent: string; driver: string; category: string; fee: number; driverPayAgent: number; driverPayExtraKm: number };
  const csvRows: CsvRow[] = [];

  for (const t of trips ?? []) {
    const agentIds: unknown[] = [t.agentid, ...((t.extraagentids as unknown[]) ?? [])].filter(Boolean);
    const ids = agentIds.length ? agentIds : [null];
    // Extra-km driver pay: genuine trip-level cost, split evenly across
    // every agent in exact integer cents, remainder to the last agent —
    // same technique as the app's own extraKmShareCentsByIdx.
    const totalExtraKmCents = Math.round(tripExtraKmDriverPay(t) * 100);
    const n = ids.length;
    const base = Math.floor(totalExtraKmCents / n);
    const remainder = totalExtraKmCents - base * n;

    ids.forEach((aid, idx) => {
      const cat = agentFeeCategory(t, aid);
      const fee = agentFeeAmount(t, aid);
      const driverPayAgent = agentDriverPayShare(t, aid);
      const driverPayExtraKm = (base + (idx === n - 1 ? remainder : 0)) / 100;

      if (cat !== "pending") {
        categoryTotals[cat].count += 1;
        categoryTotals[cat].fee += fee;
        categoryTotals[cat].driverPay += driverPayAgent;
        grandTotalFee += fee;
        grandTotalDriverPayPerAgent += driverPayAgent;
        grandTotalDriverPayExtraKm += driverPayExtraKm;
      }

      csvRows.push({
        tripId: t.id, date: t.scheduleddate, agent: aid != null ? userName(aid) : "—",
        driver: t.driverid ? userName(t.driverid) : "Unassigned",
        category: categoryLabel[cat] ?? cat, fee, driverPayAgent, driverPayExtraKm,
      });
    });
  }

  const grandTotalDriverPay = grandTotalDriverPayPerAgent + grandTotalDriverPayExtraKm;

  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

  const subtotalTable = `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="border-bottom:1px solid #2a2a2a">
      <th style="text-align:left;color:#888;padding:5px 8px">Category</th>
      <th style="text-align:left;color:#888;padding:5px 8px">Count</th>
      <th style="text-align:left;color:#888;padding:5px 8px">Trip Fee (ZAR)</th>
      <th style="text-align:left;color:#888;padding:5px 8px">Driver Pay (ZAR)</th>
    </tr></thead>
    <tbody>${categoryOrder.map(c => `<tr>
      <td style="padding:7px 8px;font-weight:700;color:#fff">${categoryLabel[c]}</td>
      <td style="padding:7px 8px">${categoryTotals[c].count}</td>
      <td style="padding:7px 8px;color:#aaa">R${categoryTotals[c].fee.toFixed(2)}</td>
      <td style="padding:7px 8px;color:#aaa">R${categoryTotals[c].driverPay.toFixed(2)}</td>
    </tr>`).join("")}
    <tr style="border-top:1px solid #2a2a2a">
      <td style="padding:7px 8px;font-weight:800;color:#f5a623">TOTAL</td>
      <td style="padding:7px 8px;font-weight:800;color:#f5a623">${csvRows.length}</td>
      <td style="padding:7px 8px;font-weight:800;color:#f5a623">R${grandTotalFee.toFixed(2)}</td>
      <td style="padding:7px 8px;font-weight:800;color:#f5a623">R${grandTotalDriverPay.toFixed(2)}</td>
    </tr>
    </tbody>
  </table>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">

  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">💰 Monthly Billing Export</h1>
    <p style="margin:0;font-size:13px;color:#888">${esc(monthLabel)} · generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>

  <div style="display:flex;gap:12px;margin-bottom:20px">
    ${[
      [csvRows.length, "Billable Passenger-Trips"],
      ["R" + grandTotalFee.toFixed(2), "Total Trip Fee Revenue"],
      ["R" + grandTotalDriverPay.toFixed(2), "Total Driver Pay"],
    ].map(([n, l]) => `<div style="background:#1a1a1a;border-radius:6px;padding:12px 18px;flex:1;text-align:center">
      <div style="font-size:22px;font-weight:800;color:#f5a623">${n}</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:2px">${l}</div>
    </div>`).join("")}
  </div>

  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    📋 Category Breakdown
  </div>
  ${subtotalTable}
  <p style="font-size:10px;color:#555;margin-top:6px">Full per-passenger detail (Trip ID, Agent, Driver, Category, Trip Fee, Driver Pay) is attached as CSV — every numeric column is each row's own real amount, so summing directly in a spreadsheet gives the correct total with no dedup step needed.</p>

  <div style="margin-top:28px;font-size:11px;color:#444;border-top:1px solid #1e1e1e;padding-top:12px">
    Pearce &amp; Sons Fleet Operations · Automated Monthly Report
  </div>
</div></body></html>`;

  const subject = `💰 Monthly Billing — ${monthLabel} — R${grandTotalFee.toFixed(2)} billed, R${grandTotalDriverPay.toFixed(2)} driver pay`;

  // ── CSV attachment ────────────────────────────────────────────────────
  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // formula-injection guard, same as daily-trip-sheet
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = ["Trip ID", "Date", "Agent", "Driver", "Fee Category", "Trip Fee (ZAR)", "Driver Pay - Per Agent (ZAR)", "Driver Pay - Extra KM (ZAR)", "Driver Pay - Total (ZAR)"];
  const csvBody = csvRows.map(r => [
    r.tripId, r.date, r.agent, r.driver, r.category,
    r.fee.toFixed(2), r.driverPayAgent.toFixed(2), r.driverPayExtraKm.toFixed(2), (r.driverPayAgent + r.driverPayExtraKm).toFixed(2),
  ].map(csvCell).join(","));
  const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvBody].join("\r\n"); // BOM for Excel
  const csvFilename = `billing_${monthLabel.replace(" ", "-")}.csv`;
  const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

  console.log("Sending email:", subject, "| CSV rows:", csvBody.length);

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
  return json({ ok: true, to: TO, subject, billableRows: csvRows.length, totalFee: grandTotalFee, totalDriverPay: grandTotalDriverPay, resendId: resendBody.id });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
