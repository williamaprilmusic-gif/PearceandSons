// trip-history-retention/index.ts
//
// Per explicit request: the app should only keep up to 2 months of trip
// history in the live database — anything older gets exported to a full
// CSV and emailed via Resend (same integration daily-trip-sheet already
// uses), THEN removed from the trips table. Runs once a day via pg_cron,
// same CRON_AUTH_TOKEN pattern as daily-trip-sheet/check-late-start.
//
// Safety property: the export must succeed BEFORE anything is deleted.
// If the Resend send fails for any reason, this function returns an error
// and deletes nothing — the same batch is picked up again on the next
// scheduled run, so a transient email failure can never silently destroy
// data that was never actually captured anywhere else.
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
// so both are explicitly purged first. notifications/driver_positions/
// driver_position_log/tickets/audit_logs/driver_status all SET NULL their
// tripid/currenttripid automatically; trip_delays CASCADEs. All of that
// is intentional: those tables keep their own content, they just lose the
// now-meaningless reference to a trip that no longer exists.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const TERMINAL_STATES = ["ARCHIVED_COMPLETED", "ARCHIVED_CANCELLED"];

serve(async (req) => {
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
  // see those files' header comments for why this is a literal constant
  // rather than the platform service-role key.
  const CRON_AUTH_TOKEN = "2e032b24f3d9b86c5dec616d999a17f71ba43255707af8335a61e2cc65fd6108";

  if (req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
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
    return json({ error: "DB fetch error: " + fetchErr.message }, 500);
  }

  const rows = oldTrips ?? [];
  if (rows.length === 0) {
    console.log("Nothing older than", cutoffStr, "— nothing to export or purge.");
    return json({ ok: true, purged: 0, cutoff: cutoffStr });
  }

  const tripIds = rows.map((t: Record<string, unknown>) => t.id);

  // Driver names — trips only store driverid, not a denormalized name
  // (unlike agentname, which IS denormalized on the row already).
  const driverIds = [...new Set(rows.map((t: Record<string, unknown>) => t.driverid).filter(Boolean))];
  const { data: drivers } = driverIds.length > 0
    ? await sb.from("users").select("id, fullname").in("id", driverIds)
    : { data: [] as { id: number; fullname: string }[] };
  const driverMap: Record<string, string> = {};
  for (const d of (drivers ?? [])) driverMap[String(d.id)] = d.fullname;

  // ── CSV export — the only remaining copy of this data once purged, so
  // this is deliberately more complete than daily-trip-sheet's summary
  // CSV (includes route distance, fee category is left to the dedicated
  // financial export elsewhere; this is the operational trip record).
  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // Same CSV/formula-injection guard as every other CSV export in this
    // app (daily-trip-sheet, the main client's escapeCsv/csvCell) — a
    // field starting with =, +, -, or @ can be interpreted as a formula
    // by Excel/Sheets when opened.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = [
    "Trip ID", "Scheduled Date", "Scheduled Time", "Status", "Direction",
    "Agent", "Extra Passengers", "Driver", "Pickup", "Drop-off",
    "Route Distance (km)", "Booked At", "Completed At", "No-Shows",
  ];
  const csvRows = rows.map((t: Record<string, unknown>) => {
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
  const oldestDate = rows[0].scheduleddate as string;
  const newestDate = rows[rows.length - 1].scheduleddate as string;
  const csvFilename = `trip-history_${oldestDate.replace(/\//g, "-")}_to_${newestDate.replace(/\//g, "-")}.csv`;
  const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">🗄 Trip History Retention Sweep</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" })} SAST</p>
  </div>
  <p style="font-size:13px;line-height:1.6">
    <strong style="color:#f5a623">${rows.length}</strong> trip${rows.length !== 1 ? "s" : ""} scheduled between
    <strong>${oldestDate}</strong> and <strong>${newestDate}</strong> (older than the app's 2-month retention window)
    ${rows.length !== 1 ? "have" : "has"} been exported to the attached CSV and permanently removed from the app.
  </p>
  <p style="font-size:12px;color:#666">This is the only remaining copy of this data — keep this email/attachment somewhere durable.</p>
</div></body></html>`;

  const subject = `🗄 Trip History Retention — ${rows.length} trip${rows.length !== 1 ? "s" : ""} archived out (${oldestDate} to ${newestDate})`;

  console.log("Sending retention export:", subject);

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO], subject, html,
      attachments: [{ filename: csvFilename, content: csvBase64 }],
    }),
  });
  const resendBody = await resendRes.json();

  if (!resendRes.ok) {
    console.error("Resend failed:", resendRes.status, JSON.stringify(resendBody));
    // Deliberately no deletion below this point — see header comment.
    return json({ error: `Resend ${resendRes.status}: ${JSON.stringify(resendBody)}`, purged: 0 }, 500);
  }
  console.log("Export email sent, Resend id:", resendBody.id, "— proceeding to purge", tripIds.length, "trips.");

  // ── Purge — only reachable after a confirmed-successful export above.
  // Explicit deletes first for the two NO ACTION foreign keys (messages,
  // feedbacks); everything else SET NULLs/CASCADEs automatically once the
  // trips rows themselves are deleted.
  const { error: msgDelErr } = await sb.from("messages").delete().in("tripid", tripIds);
  if (msgDelErr) {
    console.error("Failed to purge messages for old trips (trips NOT deleted, will retry next run):", msgDelErr.message);
    return json({ error: "Failed to purge messages: " + msgDelErr.message, purged: 0, exported: rows.length, resendId: resendBody.id }, 500);
  }
  const { error: fbDelErr } = await sb.from("feedbacks").delete().in("tripid", tripIds);
  if (fbDelErr) {
    console.error("Failed to purge feedbacks for old trips (trips NOT deleted, will retry next run):", fbDelErr.message);
    return json({ error: "Failed to purge feedbacks: " + fbDelErr.message, purged: 0, exported: rows.length, resendId: resendBody.id }, 500);
  }
  const { error: tripDelErr } = await sb.from("trips").delete().in("id", tripIds);
  if (tripDelErr) {
    console.error("Failed to purge trips after successful export (messages/feedbacks for these ids are already gone):", tripDelErr.message);
    return json({ error: "Failed to purge trips: " + tripDelErr.message, purged: 0, exported: rows.length, resendId: resendBody.id }, 500);
  }

  console.log(`Purged ${tripIds.length} trips after successful export.`);
  return json({ ok: true, exported: rows.length, purged: tripIds.length, cutoff: cutoffStr, resendId: resendBody.id });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
