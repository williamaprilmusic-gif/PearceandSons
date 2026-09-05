// trip-history-retention/index.ts
//
// Per explicit request: the app should only keep up to 2 months of trip
// history in the live database. Processes ONE calendar day at a time —
// per explicit follow-up request (2026-08-08): each email must be a
// single day's trip sheet, not a bulk multi-day export. Example given:
// if today is 31 July, the retention window is 1 June through today, so
// the 1 June trip sheet is emailed and ONLY THEN is 1 June's data
// deleted. Runs once a day via pg_cron, same CRON_AUTH_TOKEN pattern as
// daily-trip-sheet/check-late-start.
//
// SAFETY MECHANISM (rewritten 2026-09-05, /code-review finding): the
// day's data is now uploaded to the private `retention-archives` Storage
// bucket FIRST, and a `retention_exports` row is written, and ONLY THEN
// are the DB rows deleted. Previously deletion was gated on Resend
// returning HTTP 2xx — which only means "accepted for processing," not
// delivered; a later bounce (the file headers here document the sender
// address doing exactly that) left NO copy anywhere. The email is still
// sent, but purely as a convenience/notification now — its failure is
// logged and does NOT block or unblock deletion. Also NEW: messages and
// feedbacks for the purged trips (dispute/insurance evidence) are now
// archived too; they used to be hard-deleted with no export at all.
//
// Steady-state behavior: exactly one new calendar day ages past the
// 2-month mark each day this runs, so normally this processes exactly one
// day per run. If the job missed runs (or on the very first run after
// this feature shipped), there may be a backlog of several days still
// within the live DB despite being older than the cutoff — this walks
// them oldest-first, one archive + one day's deletion at a time, until
// caught up to the 2-month window or an archive/delete fails.
//
// Safety property per day: that day's archive upload must succeed BEFORE
// that day's rows are deleted. If it fails, processing stops there —
// earlier days in the same run that already succeeded stay deleted
// (already safely archived), this day and any older backlog beyond it
// are left untouched and retried on the next scheduled run.
//
// Only ARCHIVED_COMPLETED/ARCHIVED_CANCELLED trips are ever swept — a
// trip that's somehow still not in a terminal state 2+ months after its
// scheduled date is a data anomaly, not something this job should ever
// touch. Only scheduleddate (this app's primary temporal identity for a
// trip everywhere else — archive bucketing, filtering, etc.) is used for
// the age check, computed in LOCAL (SAST) calendar terms via the same
// sast()/fmt() trick daily-trip-sheet already uses — never a raw UTC
// toISOString() cutoff.
//
// FK note (verified against the live schema): trips is referenced by
// messages and feedbacks with ON DELETE NO ACTION — a delete on trips
// would fail outright if either still has matching rows, so both are
// explicitly purged first, per day (after being archived). notifications/
// driver_positions/driver_position_log/tickets/audit_logs/driver_status
// all SET NULL their tripid/currenttripid automatically; trip_delays
// CASCADEs.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const TERMINAL_STATES = ["ARCHIVED_COMPLETED", "ARCHIVED_CANCELLED"];
const ARCHIVE_BUCKET = "retention-archives";

Deno.serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  // Same sandbox-domain constraint documented in daily-trip-sheet/index.ts.
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Same dedicated shared secret as daily-trip-sheet/check-late-start.
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // SAST-local calendar date, matching daily-trip-sheet's own fmt() helper
  // exactly — scheduleddate is stored as "YYYY/MM/DD" strings throughout
  // this app, so string comparison against a same-format cutoff is safe.
  const sast = (d: Date) => new Date(d.getTime() + 2 * 3600000);
  const fmt = (d: Date) => {
    const s = sast(d);
    const y = s.getUTCFullYear();
    const m = String(s.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(s.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${dd}`;
  };
  const humanDate = (str: string) => {
    const [y, m, d] = str.split("/").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-ZA", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    });
  };
  const now = new Date();
  const cutoffDate = new Date(now.getTime());
  // FOUND VIA /code-review: setUTCMonth alone rolls FORWARD on a month-end
  // date whose target month is shorter (31 Aug -> "June 31" -> 1 July).
  // Snap to the 1st before shifting; the boundary becomes the 1st of the
  // month two months back — slightly conservative, the safe direction.
  cutoffDate.setUTCDate(1);
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 2);
  const cutoffStr = fmt(cutoffDate);

  console.log("trip-history-retention: sweeping trips scheduled before", cutoffStr);

  const { data: oldTrips, error: fetchErr } = await sb
    .from("trips")
    .select("*")
    .in("status", TERMINAL_STATES)
    .lt("scheduleddate", cutoffStr)
    .order("scheduleddate", { ascending: true })
    .limit(5000);

  if (fetchErr) {
    console.error("DB fetch error:", fetchErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const rows = oldTrips ?? [];
  if (rows.length === 0) {
    console.log("Nothing older than", cutoffStr, "— nothing to archive or purge.");
    return json({ ok: true, cutoff: cutoffStr, days: [] });
  }

  const driverIds = [...new Set(rows.map((t: Record<string, unknown>) => t.driverid).filter(Boolean))];
  const { data: drivers } = driverIds.length > 0
    ? await sb.from("users").select("id, fullname").in("id", driverIds)
    : { data: [] as { id: number; fullname: string }[] };
  const driverMap: Record<string, string> = {};
  for (const d of (drivers ?? [])) driverMap[String(d.id)] = d.fullname;

  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const t of rows) {
    const d = t.scheduleddate as string;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }

  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // formula-injection guard
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Generic object-array -> CSV, BOM-prefixed for Excel. `columns` is a
  // list of [header, accessor] pairs.
  const rowsToCsv = (dataRows: Record<string, unknown>[], columns: [string, (r: Record<string, unknown>) => unknown][]) => {
    const header = columns.map(([h]) => csvCell(h)).join(",");
    const body = (dataRows || []).map(r => columns.map(([, acc]) => csvCell(acc(r))).join(","));
    return "﻿" + [header, ...body].join("\r\n");
  };

  const tripColumns: [string, (r: Record<string, unknown>) => unknown][] = [
    ["Trip ID", r => r.id],
    ["Scheduled Date", r => r.scheduleddate],
    ["Scheduled Time", r => r.scheduledtimestr ?? ""],
    ["Status", r => r.status],
    ["Direction", r => r.direction ?? ""],
    ["Agent", r => r.agentname ?? ""],
    ["Extra Passengers", r => ((r.extraagentids as unknown[]) ?? []).length],
    ["Driver", r => r.driverid ? (driverMap[String(r.driverid)] ?? "Unknown") : "Unassigned"],
    ["Pickup", r => r.pickuplocation ?? r.pickuplabel ?? ""],
    ["Drop-off", r => r.dropofflocation ?? r.dropofflabel ?? ""],
    ["Route Distance (km)", r => r.driverroutekm ?? ""],
    ["Booked At", r => r.bookedat ? new Date(r.bookedat as number).toISOString() : ""],
    ["Completed At", r => r.completedat ? new Date(r.completedat as number).toISOString() : ""],
    ["No-Shows", r => ((r.noshows as unknown[]) ?? []).length],
  ];
  // messages/feedbacks columns kept deliberately generic ("dump every
  // column") — these are being archived as evidence, so completeness
  // matters more than a curated layout.
  const dumpColumns = (sample: Record<string, unknown> | undefined): [string, (r: Record<string, unknown>) => unknown][] => {
    const keys = sample ? Object.keys(sample) : [];
    return keys.map(k => [k, (r: Record<string, unknown>) => {
      const v = r[k];
      return v != null && typeof v === "object" ? JSON.stringify(v) : v;
    }]);
  };

  const dayResults: { date: string; archived: Record<string, number>; purged: number; resendId?: string; error?: string }[] = [];

  for (const [date, dayRows] of byDate) {
    const dayTripIds = dayRows.map((t: Record<string, unknown>) => t.id);
    const safeDate = date.replace(/\//g, "-");

    // Fetch the child rows that are about to be permanently deleted so
    // they can be archived first.
    const [{ data: dayMessages }, { data: dayFeedbacks }] = await Promise.all([
      sb.from("messages").select("*").in("tripid", dayTripIds),
      sb.from("feedbacks").select("*").in("tripid", dayTripIds),
    ]);

    const tripsCsv = rowsToCsv(dayRows, tripColumns);
    const messagesCsv = rowsToCsv(dayMessages || [], dumpColumns((dayMessages || [])[0]));
    const feedbacksCsv = rowsToCsv(dayFeedbacks || [], dumpColumns((dayFeedbacks || [])[0]));

    const base = `trips/${safeDate}`;
    const uploads: { path: string; body: string; table: string; count: number }[] = [
      { path: `${base}/trips_${safeDate}.csv`, body: tripsCsv, table: "trips", count: dayRows.length },
      { path: `${base}/messages_${safeDate}.csv`, body: messagesCsv, table: "messages", count: (dayMessages || []).length },
      { path: `${base}/feedbacks_${safeDate}.csv`, body: feedbacksCsv, table: "feedbacks", count: (dayFeedbacks || []).length },
    ];

    // ── 1. Archive to Storage FIRST — the safety mechanism. ──
    let archiveOk = true;
    for (const u of uploads) {
      const { error: upErr } = await sb.storage.from(ARCHIVE_BUCKET)
        .upload(u.path, new TextEncoder().encode(u.body), { contentType: "text/csv;charset=utf-8", upsert: true });
      if (upErr) {
        console.error("Archive upload FAILED for", u.path, "— NOT deleting this day or older:", upErr.message);
        archiveOk = false;
        break;
      }
    }
    if (!archiveOk) {
      dayResults.push({ date, archived: {}, purged: 0, error: "archive upload failed" });
      break;
    }
    const archivedCounts: Record<string, number> = {};
    for (const u of uploads) {
      archivedCounts[u.table] = u.count;
      await sb.from("retention_exports").insert({
        table_name: u.table, export_date: date, storage_path: u.path,
        row_count: u.count, exported_at: Date.now(),
      });
    }
    console.log(`Archived ${date}: ${dayRows.length} trips, ${(dayMessages || []).length} messages, ${(dayFeedbacks || []).length} feedbacks to ${base}/`);

    // ── 2. Email — a convenience only now; failure is logged, not fatal. ──
    let resendId: string | undefined;
    if (RESEND_KEY) {
      try {
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">🗄 Trip Sheet Archive — ${humanDate(date)}</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>
  <p style="font-size:13px;line-height:1.6">
    <strong style="color:#f5a623">${dayRows.length}</strong> trip${dayRows.length !== 1 ? "s" : ""} scheduled on
    <strong>${date}</strong> (plus ${(dayMessages || []).length} chat message${(dayMessages || []).length !== 1 ? "s" : ""} and
    ${(dayFeedbacks || []).length} feedback record${(dayFeedbacks || []).length !== 1 ? "s" : ""}) have been archived to
    secure storage and removed from the live app.
  </p>
  <p style="font-size:12px;color:#666">The durable copy is in the <code>retention-archives</code> storage bucket at
    <code>${base}/</code> — this email attachment is a convenience copy, not the system of record.</p>
</div></body></html>`;
        const csvBase64 = encodeBase64(new TextEncoder().encode(tripsCsv));
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: FROM, to: [TO],
            subject: `🗄 Trip Sheet Archive — ${date} (${dayRows.length} trip${dayRows.length !== 1 ? "s" : ""}) — archived and removed`,
            html,
            attachments: [{ filename: `trip-sheet_${safeDate}.csv`, content: csvBase64 }],
          }),
          signal: AbortSignal.timeout(20000),
        });
        const resendBody = await resendRes.json().catch(() => ({}));
        if (resendRes.ok) {
          resendId = resendBody.id;
          for (const u of uploads) {
            await sb.from("retention_exports").update({ resend_id: resendId }).eq("storage_path", u.path);
          }
        } else {
          console.warn("Retention email failed for", date, "(archive already safe, continuing):", resendRes.status);
        }
      } catch (e) {
        console.warn("Retention email threw for", date, "(archive already safe, continuing):", e instanceof Error ? e.message : String(e));
      }
    }

    // ── 3. Delete — reachable only after the archive succeeded. ──
    const { error: msgDelErr } = await sb.from("messages").delete().in("tripid", dayTripIds);
    if (msgDelErr) {
      console.error("Failed to purge messages for", date, "(trip rows NOT deleted, will retry next run):", msgDelErr.message);
      dayResults.push({ date, archived: archivedCounts, purged: 0, resendId, error: "purge messages failed" });
      break;
    }
    const { error: fbDelErr } = await sb.from("feedbacks").delete().in("tripid", dayTripIds);
    if (fbDelErr) {
      console.error("Failed to purge feedbacks for", date, "(trip rows NOT deleted, will retry next run):", fbDelErr.message);
      dayResults.push({ date, archived: archivedCounts, purged: 0, resendId, error: "purge feedbacks failed" });
      break;
    }
    const { error: tripDelErr } = await sb.from("trips").delete().in("id", dayTripIds);
    if (tripDelErr) {
      console.error("Failed to purge trips for", date, "after successful archive:", tripDelErr.message);
      dayResults.push({ date, archived: archivedCounts, purged: 0, resendId, error: "purge trips failed" });
      break;
    }

    console.log(`Purged ${dayTripIds.length} trips for ${date} after successful archive.`);
    dayResults.push({ date, archived: archivedCounts, purged: dayTripIds.length, resendId });
  }

  const totalPurged = dayResults.reduce((n, d) => n + d.purged, 0);
  return json({ ok: true, cutoff: cutoffStr, days: dayResults, totalPurged });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
