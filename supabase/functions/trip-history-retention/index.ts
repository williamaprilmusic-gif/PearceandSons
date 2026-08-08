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
// Steady-state behavior: exactly one new calendar day ages past the
// 2-month mark each day this runs, so normally this sends exactly one
// email per run. If the job missed runs (or on the very first run after
// this feature shipped), there may be a backlog of several days still
// within the live DB despite being older than the cutoff — this walks
// them oldest-first, one email + one day's deletion at a time, until
// caught up to the 2-month window or a send/delete fails.
//
// Safety property per day: that day's export must succeed BEFORE that
// day's rows are deleted. If a day's Resend send fails, processing stops
// there — earlier days in the same run that already succeeded stay
// deleted (already safely emailed), but this day and any older backlog
// beyond it are left untouched and retried on the next scheduled run.
//
// Only ARCHIVED_COMPLETED/ARCHIVED_CANCELLED trips are ever swept — a
// trip that's somehow still not in a terminal state 2+ months after its
// scheduled date is a data anomaly, not something this job should ever
// touch. Only scheduleddate (this app's primary temporal identity for a
// trip everywhere else — archive bucketing, filtering, etc.) is used for
// the age check, computed in LOCAL (SAST) calendar terms via the same
// sast()/fmt() trick daily-trip-sheet already uses — never a raw UTC
// toISOString() cutoff, which would silently include/exclude trips
// crossing the boundary by up to 2 hours (the exact bug class fixed
// twice elsewhere in this app this session).
//
// FK note (verified against the live schema before writing this): trips
// is referenced by messages and feedbacks with ON DELETE NO ACTION — a
// delete on trips would fail outright if either still has matching rows,
// so both are explicitly purged first, per day. notifications/
// driver_positions/driver_position_log/tickets/audit_logs/driver_status
// all SET NULL their tripid/currenttripid automatically; trip_delays
// CASCADEs. All of that is intentional: those tables keep their own
// content, they just lose the now-meaningless reference to a trip that
// no longer exists.

import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const TERMINAL_STATES = ["ARCHIVED_COMPLETED", "ARCHIVED_CANCELLED"];

Deno.serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  // Same sandbox-domain constraint documented in daily-trip-sheet/index.ts
  // — Resend's onboarding@resend.dev sender can only deliver to the
  // account's own verified address until a real sending domain is
  // verified. Update both functions together once that happens.
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Same dedicated shared secret as daily-trip-sheet/check-late-start —
  // see those files' header comments for why this is a real edge-function
  // secret rather than the platform service-role key.
  //
  // FIXED (2026-08-08): this was a plaintext literal committed to git,
  // identical across 4 functions — found via a dedicated security audit.
  // This function is the highest-stakes of the four: a leaked token meant
  // anyone with repo read access could trigger unscheduled, repeated
  // PERMANENT DELETION of trip/message/feedback rows. Moved to a real
  // secret; the old literal is compromised (it lived in git history) and
  // is no longer accepted.
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (!RESEND_KEY) return json({ error: "Missing Resend_API_Key secret" }, 500);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // SAST-local calendar date, matching daily-trip-sheet's own fmt() helper
  // exactly — scheduleddate is stored as "YYYY/MM/DD" strings throughout
  // this app (see parseScheduledDateTime's comment in the main client),
  // so string comparison against a same-format cutoff is safe and correct.
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
  cutoffDate.setUTCMonth(cutoffDate.getUTCMonth() - 2);
  const cutoffStr = fmt(cutoffDate);

  console.log("trip-history-retention: sweeping trips scheduled before", cutoffStr);

  const { data: oldTrips, error: fetchErr } = await sb
    .from("trips")
    .select("*")
    .in("status", TERMINAL_STATES)
    .lt("scheduleddate", cutoffStr)
    .order("scheduleddate", { ascending: true })
    .limit(5000); // generous cap — current volume is in the dozens; well ahead of realistic growth

  if (fetchErr) {
    console.error("DB fetch error:", fetchErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const rows = oldTrips ?? [];
  if (rows.length === 0) {
    console.log("Nothing older than", cutoffStr, "— nothing to export or purge.");
    return json({ ok: true, cutoff: cutoffStr, days: [] });
  }

  // Driver names — trips only store driverid, not a denormalized name
  // (unlike agentname, which IS denormalized on the row already). Fetched
  // once for every row in this run, not per-day, since the same driver
  // can appear across multiple days' backlog.
  const driverIds = [...new Set(rows.map((t: Record<string, unknown>) => t.driverid).filter(Boolean))];
  const { data: drivers } = driverIds.length > 0
    ? await sb.from("users").select("id, fullname").in("id", driverIds)
    : { data: [] as { id: number; fullname: string }[] };
  const driverMap: Record<string, string> = {};
  for (const d of (drivers ?? [])) driverMap[String(d.id)] = d.fullname;

  // Group by scheduleddate — rows already arrive sorted ascending by the
  // query's own .order(), so insertion order into this Map is oldest-day-
  // first, which is exactly the order this must process (and delete) in.
  const byDate = new Map<string, Record<string, unknown>[]>();
  for (const t of rows) {
    const d = t.scheduleddate as string;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(t);
  }

  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV/formula-injection guard — a field starting with =, +, -, or @
    // can be interpreted as a formula by Excel/Sheets when opened.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = [
    "Trip ID", "Scheduled Date", "Scheduled Time", "Status", "Direction",
    "Agent", "Extra Passengers", "Driver", "Pickup", "Drop-off",
    "Route Distance (km)", "Booked At", "Completed At", "No-Shows",
  ];

  const dayResults: { date: string; exported: number; purged: number; resendId?: string; error?: string }[] = [];

  for (const [date, dayRows] of byDate) {
    const dayTripIds = dayRows.map((t: Record<string, unknown>) => t.id);

    const csvRows = dayRows.map((t: Record<string, unknown>) => {
      const bookedAt = t.bookedat ? new Date(t.bookedat as number).toISOString() : "";
      const completedAt = t.completedat ? new Date(t.completedat as number).toISOString() : "";
      return [
        t.id, t.scheduleddate, t.scheduledtimestr ?? "", t.status, t.direction ?? "",
        t.agentname ?? "", ((t.extraagentids as unknown[]) ?? []).length,
        t.driverid ? (driverMap[String(t.driverid)] ?? "Unknown") : "Unassigned",
        t.pickuplocation ?? t.pickuplabel ?? "", t.dropofflocation ?? t.dropofflabel ?? "",
        t.driverroutekm ?? "", bookedAt, completedAt,
        ((t.noshows as unknown[]) ?? []).length,
      ].map(csvCell).join(",");
    });
    const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvRows].join("\r\n"); // BOM for Excel
    const csvFilename = `trip-sheet_${date.replace(/\//g, "-")}.csv`;
    const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">🗄 Trip Sheet Archive — ${humanDate(date)}</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>
  <p style="font-size:13px;line-height:1.6">
    <strong style="color:#f5a623">${dayRows.length}</strong> trip${dayRows.length !== 1 ? "s" : ""} scheduled on
    <strong>${date}</strong> — this is the oldest day still in the app, now past the 2-month retention window.
    ${dayRows.length !== 1 ? "They have" : "It has"} been exported to the attached CSV and will be permanently removed from the app immediately after this email is sent successfully.
  </p>
  <p style="font-size:12px;color:#666">This is the only remaining copy of this day's trip data — keep this email/attachment somewhere durable.</p>
</div></body></html>`;

    const subject = `🗄 Trip Sheet Archive — ${date} (${dayRows.length} trip${dayRows.length !== 1 ? "s" : ""}) — exported and removed`;

    console.log("Sending retention export for", date, "—", dayRows.length, "trips.");

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [TO], subject, html,
        attachments: [{ filename: csvFilename, content: csvBase64 }],
      }),
      // ADDED (2026-08-08, improvement audit): no explicit timeout meant
      // a hung Resend call relied entirely on the platform's own
      // function timeout — worth being explicit here specifically since
      // a stuck call mid-loop would also stall every remaining backlog
      // day this run was about to process.
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

    // ── Purge this day only — reachable only after this day's export
    // succeeded. Explicit deletes first for the two NO ACTION foreign
    // keys (messages, feedbacks); everything else SET NULLs/CASCADEs
    // automatically once the trips rows themselves are deleted.
    const { error: msgDelErr } = await sb.from("messages").delete().in("tripid", dayTripIds);
    if (msgDelErr) {
      console.error("Failed to purge messages for", date, "(trip rows NOT deleted, will retry next run):", msgDelErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, resendId: resendBody.id, error: "purge messages failed" });
      break;
    }
    const { error: fbDelErr } = await sb.from("feedbacks").delete().in("tripid", dayTripIds);
    if (fbDelErr) {
      console.error("Failed to purge feedbacks for", date, "(trip rows NOT deleted, will retry next run):", fbDelErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, resendId: resendBody.id, error: "purge feedbacks failed" });
      break;
    }
    const { error: tripDelErr } = await sb.from("trips").delete().in("id", dayTripIds);
    if (tripDelErr) {
      console.error("Failed to purge trips for", date, "after successful export (messages/feedbacks for these ids are already gone):", tripDelErr.message);
      dayResults.push({ date, exported: dayRows.length, purged: 0, resendId: resendBody.id, error: "purge trips failed" });
      break;
    }

    console.log(`Purged ${dayTripIds.length} trips for ${date} after successful export.`);
    dayResults.push({ date, exported: dayRows.length, purged: dayTripIds.length, resendId: resendBody.id });
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
