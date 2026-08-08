// daily-trip-sheet/index.ts
// Sends a daily trip sheet email (with a CSV attachment) to
// app@pearceandsons.co.za via Resend.
//
// SYNCED FROM DEPLOYED SOURCE (2026-08-01, v55) — keep this in sync with
// whatever's actually deployed. A prior drift here (committed source vs.
// live code) caused real confusion; don't let it happen again.
//
// TEMPORARY STOPGAP (2026-08-01): FROM is still onboarding@resend.dev,
// Resend's sandbox domain — confirmed live against the real API that it
// can ONLY deliver to the Resend account's own verified email, never to
// an arbitrary address. app@pearceandsons.co.za bounced with a 403 ("You
// can only send testing emails to your own email address..."). User's
// explicit choice: send to their own verified address for now rather
// than block on domain verification. TO DO once a real sending domain is
// verified at resend.com/domains: change FROM to an address on that
// domain and TO back to app@pearceandsons.co.za.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  // Dedicated shared secret for authenticating the pg_cron caller — NOT the
  // service role key (that was the original approach here, but it silently
  // broke: this project has since migrated to the newer sb_publishable_/
  // sb_secret_ key format, and the platform-injected
  // SUPABASE_SERVICE_ROLE_KEY this function reads at runtime no longer
  // matches the legacy-JWT-format token hardcoded in the pg_cron job's
  // Authorization header. A real edge-function secret (set via the
  // Supabase dashboard), matched by the same value in the pg_cron job's
  // SQL — both under this codebase's direct control — can't drift the
  // same way a platform-injected key can.
  //
  // FIXED (2026-08-08): this was previously a plaintext literal committed
  // to git in all 4 cron-triggered functions, identical across each —
  // found via a dedicated security audit. Anyone with repo read access
  // had standing, permanent access to invoke these functions directly,
  // bypassing the schedule entirely — worst case on this codebase's other
  // cron functions is trip-history-retention, which uses the same token
  // to gate permanent data deletion. Moved to a real secret; the old
  // literal must be treated as compromised (it lived in git history) and
  // is no longer accepted.
  const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

  if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  console.log("daily-trip-sheet: starting");
  console.log("FROM:", FROM, "| TO:", TO);

  if (!RESEND_KEY) {
    return json({ error: "Missing Resend_API_Key secret" }, 500);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const now = new Date();
  const sast = (d: Date) => new Date(d.getTime() + 2 * 3600000);
  const fmt = (d: Date) => {
    const s = sast(d);
    const y = s.getUTCFullYear();
    const m = String(s.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(s.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${dd}`;
  };
  const today = fmt(now);
  const tomorrow = fmt(new Date(now.getTime() + 86400000));

  console.log("Fetching trips for today:", today, "and tomorrow:", tomorrow);

  const { data: trips, error: tripErr } = await sb
    .from("trips")
    .select("id, scheduleddate, scheduledtimestr, status, direction, agentname, extraagentids, driverid, pickuplocation, dropofflocation, pickuplabel, dropofflabel")
    .in("scheduleddate", [today, tomorrow])
    .order("scheduledtime", { ascending: true });

  if (tripErr) {
    console.error("DB error:", tripErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }

  const { data: drivers } = await sb.from("users").select("id, fullname").eq("role", "DRIVER");
  const driverMap: Record<string, string> = {};
  for (const d of (drivers ?? [])) driverMap[d.id] = d.fullname;

  const allTrips = (trips ?? []).map((t: Record<string, unknown>) => ({
    ...t,
    drivername: t.driverid ? (driverMap[t.driverid as string] ?? "Unknown") : "Unassigned",
    pickup: (t.pickuplocation ?? t.pickuplabel ?? "—") as string,
    dropoff: (t.dropofflocation ?? t.dropofflabel ?? "—") as string,
    extras: ((t.extraagentids as unknown[]) ?? []).length,
  }));

  const todayTrips = allTrips.filter(t => t.scheduleddate === today);
  const tomorrowTrips = allTrips.filter(t => t.scheduleddate === tomorrow);
  const active = todayTrips.filter(t => !["ARCHIVED_COMPLETED","ARCHIVED_CANCELLED"].includes(t.status as string));
  const done = todayTrips.filter(t => t.status === "ARCHIVED_COMPLETED");

  console.log(`Trips: today=${todayTrips.length} (active=${active.length}), tomorrow=${tomorrowTrips.length}`);

  const humanDate = (s: string) => {
    const [y, m, d] = s.split("/").map(Number);
    return new Date(Date.UTC(y, m-1, d)).toLocaleDateString("en-ZA", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC"
    });
  };

  const badgeColor: Record<string, string> = {
    DRIVER_CONFIRMED: "#1db954",
    IN_TRANSIT: "#f5a623",
    ASSIGNED: "#6495ed",
    UNASSIGNED_BOOKING: "#888",
    ARCHIVED_COMPLETED: "#555",
    ARCHIVED_CANCELLED: "#e83a3a",
  };

  const statusLabel: Record<string, string> = {
    DRIVER_CONFIRMED: "CONFIRMED",
    IN_TRANSIT: "IN TRANSIT",
    ASSIGNED: "ASSIGNED",
    UNASSIGNED_BOOKING: "UNASSIGNED",
    ARCHIVED_COMPLETED: "COMPLETED",
    ARCHIVED_CANCELLED: "CANCELLED",
  };

  // Trip fields below (agent name, pickup/dropoff labels) ultimately come
  // from user-editable text (e.g. the app's manual "Type Address" entry) —
  // escape before interpolating into this HTML email, or a crafted label
  // could break the layout or inject markup into an otherwise-trusted
  // internal report.
  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

  const row = (t: Record<string, unknown>) => {
    const col = badgeColor[t.status as string] ?? "#888";
    const lbl = statusLabel[t.status as string] ?? String(t.status);
    const dir = t.direction === "INBOUND" ? "▶ IN" : t.direction === "OUTBOUND" ? "▶ OUT" : "";
    const pax = (t.extras as number) > 0 ? ` +${t.extras}` : "";
    return `<tr>
      <td style="font-weight:700;color:#fff;padding:7px 8px">${esc(t.id)}</td>
      <td style="padding:7px 8px">${esc(t.scheduledtimestr ?? "—")}</td>
      <td style="padding:7px 8px"><span style="color:${col};font-weight:700;font-size:10px">${lbl}</span>
        ${dir ? `<span style="color:#888;font-size:10px;margin-left:4px">${dir}</span>` : ""}</td>
      <td style="padding:7px 8px">${esc(t.agentname ?? "—")}${esc(pax)}</td>
      <td style="padding:7px 8px;color:#aaa">${esc(t.drivername)}</td>
      <td style="padding:7px 8px;font-size:11px;color:#aaa">${esc(t.pickup)}</td>
      <td style="padding:7px 8px;font-size:11px;color:#aaa">${esc(t.dropoff)}</td>
    </tr>`;
  };

  const table = (rows: Record<string, unknown>[]) => rows.length === 0
    ? `<p style="color:#555;font-style:italic;padding:12px 0">No trips</p>`
    : `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="border-bottom:1px solid #2a2a2a">
          <th style="text-align:left;color:#888;padding:5px 8px">ID</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Time</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Status</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Agent</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Driver</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Pickup</th>
          <th style="text-align:left;color:#888;padding:5px 8px">Drop-off</th>
        </tr></thead>
        <tbody>${rows.map(row).join("")}</tbody>
      </table>`;

  const tomorrowPax = tomorrowTrips.reduce((n, t) => n + 1 + (t.extras as number), 0);
  const tomorrowDrivers = new Set(tomorrowTrips.filter(t => t.driverid).map(t => t.driverid)).size;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">

  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;margin-bottom:20px;border-left:4px solid #f5a623">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">🚗 Daily Trip Sheet</h1>
    <p style="margin:0;font-size:13px;color:#888">Generated ${now.toLocaleString("en-ZA",{timeZone:"Africa/Johannesburg"})} SAST</p>
  </div>

  <div style="display:flex;gap:12px;margin-bottom:20px">
    ${[
      [tomorrowTrips.length, "Tomorrow's Trips"],
      [tomorrowPax, "Passengers"],
      [tomorrowDrivers, "Drivers on Duty"],
      [active.length, "Still Active Today"],
    ].map(([n, l]) => `<div style="background:#1a1a1a;border-radius:6px;padding:12px 18px;flex:1;text-align:center">
      <div style="font-size:28px;font-weight:800;color:#f5a623">${n}</div>
      <div style="font-size:11px;color:#888;text-transform:uppercase;letter-spacing:1px;margin-top:2px">${l}</div>
    </div>`).join("")}
  </div>

  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    📅 Tomorrow — ${humanDate(tomorrow)} (${tomorrowTrips.length} trips)
  </div>
  ${table(tomorrowTrips)}

  ${active.length ? `
  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    ⏳ Still Active Today — ${humanDate(today)} (${active.length})
  </div>
  ${table(active)}` : ""}

  ${done.length ? `
  <div style="font-size:13px;font-weight:700;color:#f5a623;letter-spacing:2px;text-transform:uppercase;margin:24px 0 10px;border-bottom:1px solid #2a2a2a;padding-bottom:6px">
    ✅ Completed Today (${done.length})
  </div>
  ${table(done)}` : ""}

  <div style="margin-top:28px;font-size:11px;color:#444;border-top:1px solid #1e1e1e;padding-top:12px">
    Pearce &amp; Sons Fleet Operations · Automated Report
  </div>
</div></body></html>`;

  const subject = tomorrowTrips.length > 0
    ? `🚗 Trip Sheet — ${tomorrowTrips.length} trip${tomorrowTrips.length !== 1 ? "s" : ""} tomorrow (${humanDate(tomorrow)})`
    : `🚗 Trip Sheet — No trips booked for tomorrow (${humanDate(tomorrow)})`;

  // ── CSV attachment ────────────────────────────────────────────────────
  // Same trip set as the HTML tables above (allTrips = today + tomorrow,
  // already sorted by scheduledtime via the query's .order() above) but
  // as a real downloadable CSV, per explicit request — the HTML email is
  // readable but not something you can filter/sort/import elsewhere.
  const csvCell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    // CSV/formula-injection guard — a field starting with =, +, -, or @
    // can be interpreted as a formula by Excel/Sheets when this CSV
    // attachment is opened, potentially executing attacker-controlled
    // content from a user-editable field (agent name, pickup label,
    // etc.). Prefixing with a single quote neutralizes it as a formula
    // trigger while keeping the value readable. Found missing here (and
    // in every escapeCsv/csvCell in the main app) via a dedicated audit.
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    // Matches the client app's own CSV escaping (csvCell/escapeCsv) — must
    // catch a lone \r too, not just \r\n, or a stray carriage return in a
    // user-editable field (agent name, pickup label, etc.) could slip
    // through unquoted and corrupt row boundaries.
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvHeaders = ["Trip ID", "Date", "Time", "Status", "Direction", "Agent", "Extra Passengers", "Driver", "Pickup", "Drop-off"];
  const csvRows = allTrips.map((t: Record<string, unknown>) => [
    t.id, t.scheduleddate, t.scheduledtimestr ?? "",
    statusLabel[t.status as string] ?? String(t.status ?? ""),
    t.direction ?? "", t.agentname ?? "", t.extras as number,
    t.drivername, t.pickup, t.dropoff,
  ].map(csvCell).join(","));
  const csvContent = "﻿" + [csvHeaders.map(csvCell).join(","), ...csvRows].join("\r\n"); // BOM for Excel
  const csvFilename = `trip-sheet_${today.replace(/\//g, "-")}.csv`;
  // Encode via TextEncoder first rather than handing encodeBase64 the raw
  // string directly — explicit UTF-8 bytes, not dependent on however the
  // library's string overload happens to treat multi-byte characters (the
  // BOM prefix itself is multi-byte, and agent/driver names can contain
  // accented characters).
  const csvBase64 = encodeBase64(new TextEncoder().encode(csvContent));

  console.log("Sending email:", subject, "| CSV rows:", csvRows.length);

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO], subject, html,
      attachments: [{ filename: csvFilename, content: csvBase64 }],
    }),
    // ADDED (2026-08-08, improvement audit): no explicit timeout meant a
    // hung Resend call relied entirely on the platform's own function
    // timeout to eventually kill it.
    signal: AbortSignal.timeout(20000),
  });

  const resendBody = await resendRes.json();

  if (!resendRes.ok) {
    console.error("Resend failed:", resendRes.status, JSON.stringify(resendBody));
    return json({ error: `Resend ${resendRes.status}: ${JSON.stringify(resendBody)}`, from: FROM, to: TO }, 500);
  }

  console.log("Email sent! Resend id:", resendBody.id);
  return json({ ok: true, to: TO, subject, tomorrowTrips: tomorrowTrips.length, resendId: resendBody.id });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
