// audit-log-retention/index.ts
//
// Per explicit decision (2026-08-10): audit_logs gets the exact same
// retention treatment as trips (trip-history-retention) — 2-month
// cutoff, export-then-delete, one calendar day at a time — rather than
// the shorter no-export cutoff used for driver_position_log/
// notifications (stale-data-retention). audit_logs is compliance/
// regulatory-trail data (see AuditExportPanel's own "suitable for
// regulatory submissions" description), so unlike those two tables this
// is NOT a simple delete — every row must reach an admin's inbox before
// it's ever removed from the live DB, same safety property trip-
// history-retention already established.
//
// trip-history-retention's own header comment flagged this exact gap:
// audit_logs only ever loses the FK reference (tripid SET NULL when a
// trip is purged), never its own rows — 530+ rows and climbing with zero
// cleanup before this.
//
// Grouped by calendar day (SAST) from `timestamp`, oldest day first,
// same steady-state/backlog/safety-per-day behavior as trip-history-
// retention: that day's export must succeed BEFORE that day's rows are
// deleted; a failed day stops the run there, earlier successes in the
// same run stay deleted, the failed day and any older backlog retry next
// run. Unlike trips, audit_logs rows aren't scoped to one specific
// "scheduled date" business concept — the day bucket here is simply
// which calendar day the action itself was logged on.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

Deno.serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  // Same sandbox-domain constraint documented in daily-trip-sheet/index.ts.
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!RESEND_KEY) return json({ error: "Missing Resend_API_Key secret" }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // SAST-local calendar date for a given epoch ms — same sast()/fmt()
  // trick as trip-history-retention/daily-trip-sheet.
  const sastDateStr = (ms: number) => {
    const s = new Date(ms + 2 * 3600000);
    const y = s.getUTCFullYear();
    const m = String(s.getUTCMonth() + 1).padStart(2, "0");
    const d = String(s.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  const humanDate = (str: string) => {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  };

  const now = new Date();
  const cutoffMs = new Date(now.getTime());
  // FOUND VIA /code-review: setUTCMonth alone rolls forward on a month-end
  // date (31 Aug -> "June 31" -> 1 July), sweeping up to ~2 extra days of
  // audit trail. Snap to the 1st before shifting — see the identical fix
  // and rationale in trip-history-retention.
  cutoffMs.setUTCDate(1);
  cutoffMs.setUTCMonth(cutoffMs.getUTCMonth() - 2);

  console.log("audit-log-retention: sweeping audit_logs before", cutoffMs.toISOString());

  const { data: oldLogs, error: fetchErr } = await sb
    .from("audit_logs")
    .select("*")
    .lt("timestamp", cutoffMs.getTime())
    .order("timestamp", { ascending: true })
    .limit(5000); // generous cap — current volume is in the hundreds; well ahead of realistic growth

  if (fetchErr) {
    console.error("DB fetch error:", fetchErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const rows = oldLogs ?? [];
  if (rows.length === 0) {
    console.log("Nothing older than cutoff — nothing to export or purge.");
    return json({ ok: true, cutoff: cutoffMs.toISOString(), days: [] });
  }

  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const d = sastDateStr(r.timestamp as number);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(r);
  }

  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // formula-injection guard, same as trip-history-retention
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = ["ID", "Timestamp (SAST)", "Action Type", "User", "Actor Details", "Target User ID", "Trip ID", "Success", "Details"];

  const dayResults: { date: string; exported: number; purged: number; resendId?: string; error?: string }[] = [];

  for (const [date, dayRows] of byDate) {
    const dayLogIds = dayRows.map((r: Record<string, unknown>) => r.id);

    const csvRows = dayRows.map((r: Record<string, unknown>) => [
      r.id, new Date(r.timestamp as number).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }),
      r.actiontype, r.username, r.actordetails, r.targetuserid ?? "", r.tripid ?? "",
      r.issuccess ? "YES" : "NO", r.details ?? "",
    ].map(csvCell).join(","));
    const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvRows].join("\r\n"); // BOM for Excel
    const csvFilename = `audit-log_${date}.csv`;
    const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #1db954">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">📋 Audit Log Archive — ${humanDate(date)}</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>
  <p style="font-size:13px;line-height:1.6">
    <strong style="color:#1db954">${dayRows.length}</strong> audit log entr${dayRows.length !== 1 ? "ies" : "y"} logged on
    <strong>${humanDate(date)}</strong> — this is the oldest day still in the app, now past the 2-month retention window.
    ${dayRows.length !== 1 ? "They have" : "It has"} been exported to the attached CSV and will be permanently removed from the app immediately after this email is sent successfully.
  </p>
  <p style="font-size:12px;color:#666">This is the only remaining copy of this day's audit trail — keep this email/attachment somewhere durable (regulatory/insurance record).</p>
</div></body></html>`;

    const subject = `📋 Audit Log Archive — ${date} (${dayRows.length} entr${dayRows.length !== 1 ? "ies" : "y"}) — exported and removed`;

    console.log("Sending retention export for", date, "—", dayRows.length, "entries.");

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
      console.error("Resend failed for", date, ":", resendRes.status, JSON.stringify(resendBody));
      // Deliberately no deletion for this day or any older backlog beyond
      // it — see header comment. Days already processed earlier in this
      // same loop stay deleted (already safely emailed); stop here.
      dayResults.push({ date, exported: dayRows.length, purged: 0, error: `Resend ${resendRes.status}` });
      break;
    }

    const { error: delErr } = await sb.from("audit_logs").delete().in("id", dayLogIds);
    if (delErr) {
      console.error("Failed to purge audit_logs for", date, "after successful export:", delErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, resendId: resendBody.id, error: "purge failed" });
      break;
    }

    console.log(`Purged ${dayLogIds.length} audit_logs rows for ${date} after successful export.`);
    dayResults.push({ date, exported: dayRows.length, purged: dayLogIds.length, resendId: resendBody.id });
  }

  const totalPurged = dayResults.reduce((n, d) => n + d.purged, 0);
  return json({ ok: true, cutoff: cutoffMs.toISOString(), days: dayResults, totalPurged });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
