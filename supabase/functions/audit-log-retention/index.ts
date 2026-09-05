// audit-log-retention/index.ts
//
// Per explicit decision (2026-08-10): audit_logs gets the same 2-month
// retention treatment as trips — but as compliance/regulatory-trail data
// (see AuditExportPanel's "suitable for regulatory submissions"
// description) it is NEVER simply deleted; every row must reach a durable
// archive first.
//
// SAFETY MECHANISM (rewritten 2026-09-05, /code-review finding): the
// day's rows are uploaded to the private `retention-archives` Storage
// bucket FIRST, a `retention_exports` row is written, and ONLY THEN are
// the DB rows deleted. Previously deletion was gated on Resend returning
// HTTP 2xx (accepted-for-processing, not delivered) — a later bounce left
// no copy anywhere. The email is still sent, as a convenience only; its
// failure is logged and does not block or unblock deletion.
//
// Grouped by calendar day (SAST) from `timestamp`, oldest day first: that
// day's archive upload must succeed BEFORE that day's rows are deleted; a
// failed day stops the run there, earlier successes in the same run stay
// deleted, the failed day and any older backlog retry next run.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const ARCHIVE_BUCKET = "retention-archives";

Deno.serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

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
  // date (31 Aug -> "June 31" -> 1 July). Snap to the 1st before shifting.
  cutoffMs.setUTCDate(1);
  cutoffMs.setUTCMonth(cutoffMs.getUTCMonth() - 2);

  console.log("audit-log-retention: sweeping audit_logs before", cutoffMs.toISOString());

  const { data: oldLogs, error: fetchErr } = await sb
    .from("audit_logs")
    .select("*")
    .lt("timestamp", cutoffMs.getTime())
    .order("timestamp", { ascending: true })
    .limit(5000);

  if (fetchErr) {
    console.error("DB fetch error:", fetchErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const rows = oldLogs ?? [];
  if (rows.length === 0) {
    console.log("Nothing older than cutoff — nothing to archive or purge.");
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
    if (/^[=+\-@]/.test(s)) s = "'" + s;
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
    const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvRows].join("\r\n");
    const storagePath = `audit_logs/${date}/audit-log_${date}.csv`;

    // ── 1. Archive to Storage FIRST — the safety mechanism. ──
    const { error: upErr } = await sb.storage.from(ARCHIVE_BUCKET)
      .upload(storagePath, new TextEncoder().encode(csvContent), { contentType: "text/csv;charset=utf-8", upsert: true });
    if (upErr) {
      console.error("Archive upload FAILED for", storagePath, "— NOT deleting this day or older:", upErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, error: "archive upload failed" });
      break;
    }
    await sb.from("retention_exports").insert({
      table_name: "audit_logs", export_date: date, storage_path: storagePath,
      row_count: dayRows.length, exported_at: Date.now(),
    });
    console.log(`Archived ${dayRows.length} audit_logs rows for ${date} to ${storagePath}`);

    // ── 2. Email — a convenience only; failure logged, not fatal. ──
    let resendId: string | undefined;
    if (RESEND_KEY) {
      try {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #1db954">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">📋 Audit Log Archive — ${humanDate(date)}</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>
  <p style="font-size:13px;line-height:1.6">
    <strong style="color:#1db954">${dayRows.length}</strong> audit log entr${dayRows.length !== 1 ? "ies" : "y"} logged on
    <strong>${humanDate(date)}</strong> have been archived to secure storage and removed from the live app.
  </p>
  <p style="font-size:12px;color:#666">The durable copy is in the <code>retention-archives</code> storage bucket at
    <code>${storagePath}</code> — this email attachment is a convenience copy, not the system of record.</p>
</div></body></html>`;
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM, to: [TO],
            subject: `📋 Audit Log Archive — ${date} (${dayRows.length} entr${dayRows.length !== 1 ? "ies" : "y"}) — archived and removed`,
            html,
            attachments: [{ filename: `audit-log_${date}.csv`, content: encodeBase64(new TextEncoder().encode(csvContent)) }],
          }),
          signal: AbortSignal.timeout(20000),
        });
        const resendBody = await resendRes.json().catch(() => ({}));
        if (resendRes.ok) {
          resendId = resendBody.id;
          await sb.from("retention_exports").update({ resend_id: resendId }).eq("storage_path", storagePath);
        } else {
          console.warn("Retention email failed for", date, "(archive already safe, continuing):", resendRes.status);
        }
      } catch (e) {
        console.warn("Retention email threw for", date, "(archive already safe, continuing):", e instanceof Error ? e.message : String(e));
      }
    }

    // ── 3. Delete — reachable only after the archive succeeded. ──
    const { error: delErr } = await sb.from("audit_logs").delete().in("id", dayLogIds);
    if (delErr) {
      console.error("Failed to purge audit_logs for", date, "after successful archive:", delErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, resendId, error: "purge failed" });
      break;
    }

    console.log(`Purged ${dayLogIds.length} audit_logs rows for ${date} after successful archive.`);
    dayResults.push({ date, exported: dayRows.length, purged: dayLogIds.length, resendId });
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
