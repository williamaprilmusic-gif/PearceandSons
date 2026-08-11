// check-document-expiry — Supabase Edge Function
//
// Server-side twin of the app's own DRIVER/CHECK_DOCUMENT_EXPIRY sweep,
// same reasoning as check-late-start: the client-side version only runs
// while an admin has the app open, polled every 10 minutes from
// AdminApp — so document-expiry compliance silently paused for however
// long nobody was logged in (overnight, weekends). This runs the exact
// same check on a schedule instead, regardless of who's logged in.
//
// Mirrors the app's own case closely — same DOC_WARN_DAYS=30 threshold,
// same docexpirynotified={docType: dateVal} flag (stores the DATE VALUE
// last notified per doc type, so this fires once per genuinely-still-
// expiring date and re-fires if the admin renews to a new date that's
// STILL expiring) — but is a SEPARATE implementation, since it runs
// server-side against the raw database (lowercase column names, no
// access to the app's own JS), not by importing app code.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Dedicated shared secret for authenticating the pg_cron caller — NOT the
// service role key. See check-late-start's identical declaration for the
// full rationale.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const DOC_WARN_DAYS = 30;
const DOC_TYPES = [
  { key: "prdp", label: "PrDP" },
  { key: "licence", label: "Vehicle Licence" },
  { key: "roadworthy", label: "Roadworthy Cert" },
];

// Mirrors the app's own docExpiryStatus exactly — a document is valid
// through 23:59:59.999 of its own stated date, not midnight. This
// function runs in UTC (Deno's server runtime), but scheduleddate-style
// "YYYY-MM-DD" doc-expiry dates are SAST (UTC+2) wall-clock values — same
// -2 offset correction check-late-start already applies for the same
// reason, or every expiry would silently read as valid 2 hours too long.
function docExpiryStatus(dateStr: string | null | undefined): { status: string; daysLeft: number | null } {
  if (!dateStr) return { status: "missing", daysLeft: null };
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return { status: "missing", daysLeft: null };
  const expiry = new Date(Date.UTC(y, m - 1, d, 21, 59, 59, 999));
  const daysLeft = Math.ceil((expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft < 0) return { status: "expired", daysLeft };
  if (daysLeft <= DOC_WARN_DAYS) return { status: "expiring", daysLeft };
  return { status: "ok", daysLeft };
}

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: driverStatusRows, error } = await supabase
      .from("driver_status")
      .select("driverid, documents, docexpirynotified");
    if (error) throw error;

    // First pass: figure out which drivers actually need notifying, and
    // for which doc types (pure in-memory math against driverStatusRows,
    // no DB calls) — same two-pass shape as check-hours-compliance, so
    // docExpiryStatus is computed exactly once per doc per driver instead
    // of once in a pre-filter and again in the notify loop.
    type DocFlag = { docType: typeof DOC_TYPES[number]; dateVal: string; status: string };
    type FlaggedDriver = { driverid: unknown; notified: Record<string, string>; flags: DocFlag[] };
    const flagged: FlaggedDriver[] = [];
    for (const ds of driverStatusRows || []) {
      const docs = (ds.documents as Record<string, string>) || {};
      const notified = (ds.docexpirynotified as Record<string, string>) || {};
      const flags: DocFlag[] = [];
      for (const docType of DOC_TYPES) {
        const dateVal = docs[docType.key];
        if (!dateVal) continue;
        const { status } = docExpiryStatus(dateVal);
        if (status !== "expiring" && status !== "expired") continue;
        if (notified[docType.key] === dateVal) continue; // already notified for this exact date
        flags.push({ docType, dateVal, status });
      }
      if (flags.length > 0) flagged.push({ driverid: ds.driverid, notified, flags });
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

    let flaggedCount = 0;
    for (const { driverid, notified, flags } of flagged) {
      const driverName = driverNameById[String(driverid)] || String(driverid);
      const newNotified = { ...notified };

      for (const { docType, dateVal, status } of flags) {
        newNotified[docType.key] = dateVal;
        flaggedCount++;

        const verb = status === "expired" ? "has EXPIRED" : "is expiring soon";
        const nowTs = Date.now();
        await supabase.from("notifications").insert([
          {
            title: "DRIVER DOCUMENT EXPIRY", type: "DRIVER_DOCUMENT_EXPIRY", forroles: ["ADMIN"], userid: null,
            message: `⚠ ${driverName}'s ${docType.label} ${verb} (${dateVal}).`,
            timestamp: nowTs, isread: false,
          },
          {
            title: "DRIVER DOCUMENT EXPIRY", type: "DRIVER_DOCUMENT_EXPIRY", forroles: ["DRIVER"], userid: driverid,
            message: `⚠ Your ${docType.label} ${verb} (${dateVal}) — please renew and update it as soon as possible.`,
            timestamp: nowTs, isread: false,
          },
        ]);
      }

      await supabase.from("driver_status").update({ docexpirynotified: newNotified }).eq("driverid", driverid);
    }

    return new Response(JSON.stringify({ ok: true, checked: (driverStatusRows || []).length, flagged: flaggedCount }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("check-document-expiry failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
