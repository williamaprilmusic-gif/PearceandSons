// crash-alert/index.ts
// Sends an email alert (via Resend) when AppErrorBoundary catches a render
// crash — the escalation layer on top of the client_errors DB row + admin
// push notification that componentDidCatch already sends directly. Email
// reaches someone even when no admin device holds a live push subscription,
// which push alone can't guarantee.
//
// Called directly by the client (not pg_cron), including in states where
// the caller's session token may be invalid/expired — that's exactly when a
// crash is likely. So this can't gate on a valid session token the way
// other client-invoked functions do. Instead: requires a client_errors row
// matching (message, createdat) to already exist — the same anti-forgery
// shape send-push-notification uses (ties this function's one side effect
// to content the app's own already-authorized insert path actually
// produced), rather than accepting arbitrary POSTed content.

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

serve(async (req) => {
  const RESEND_KEY = Deno.env.get("Resend_API_Key") ?? "";
  const TO = "williamaprilmusic@gmail.com";
  const FROM = "Pearce & Sons <onboarding@resend.dev>";

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!RESEND_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    console.error("crash-alert: missing required secret(s)");
    return json({ error: "Internal error — please try again." }, 500);
  }

  let body: { message?: string; created_at?: number; url?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  const { message, created_at, url } = body;
  if (!message || typeof created_at !== "number") {
    return json({ error: "Invalid request body" }, 400);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  // Anti-forgery gate — see header comment. 5s window matches
  // send-push-notification's equivalent check.
  const { data: rows, error: dbErr } = await sb
    .from("client_errors")
    .select("id")
    .eq("message", message)
    .gte("createdat", created_at - 5000)
    .lte("createdat", created_at + 5000)
    .limit(1);

  if (dbErr) {
    console.error("crash-alert: lookup failed:", dbErr.message);
    return json({ error: "Internal error — please try again." }, 500);
  }
  if (!rows || rows.length === 0) {
    return json({ error: "No matching crash record found" }, 403);
  }

  const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));

  const when = new Date(created_at).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:0">
<div style="max-width:640px;margin:0 auto;padding:24px 16px">
  <div style="background:#1a1a1a;border-radius:8px;padding:20px 24px;border-left:4px solid #e83a3a">
    <h1 style="margin:0 0 4px;font-size:20px;color:#fff">🚨 App Crash — Pearce &amp; Sons</h1>
    <p style="margin:0;font-size:13px;color:#888">${esc(when)} SAST</p>
  </div>
  <div style="background:#111;border-radius:6px;padding:14px 16px;margin-top:16px;font-family:monospace;font-size:13px;color:#f5a623;word-break:break-word">
    ${esc(message)}
  </div>
  <p style="font-size:12px;color:#888;margin-top:16px">Page: ${esc(url || "—")}</p>
  <p style="font-size:11px;color:#555;margin-top:20px">Full stack trace and component stack are in the client_errors table — this email is a heads-up, not the full report.</p>
</div></body></html>`;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO],
      subject: `🚨 App crash: ${message.slice(0, 80)}`,
      html,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!resendRes.ok) {
    const resendBody = await resendRes.text();
    console.error("crash-alert: Resend failed:", resendRes.status, resendBody);
    return json({ error: "Internal error — please try again." }, 500);
  }

  return json({ ok: true });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
