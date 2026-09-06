// retention-archive-url — Supabase Edge Function
//
// Mints a short-lived signed download URL for one file in the private
// `retention-archives` Storage bucket (the durable CSV archives written
// by trip-history-retention / audit-log-retention). The bucket has no
// storage.objects RLS policy, so the client can't call createSignedUrl
// itself — this does it with the service key after checking the caller
// is an admin, exactly like ai-ops-assistant's gate.
//
// Input: POST { path } where `path` is a retention_exports.storage_path
// value. `path` is validated against a real retention_exports row so a
// caller can't sign an arbitrary object key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const JWT_SECRET = Deno.env.get("PROJECT_JWT_SECRETS");
const BUCKET = "retention-archives";
const URL_TTL_SECONDS = 300;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

function base64urlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    b64url.length + (4 - (b64url.length % 4)) % 4, "="
  );
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

// Same HS256 scheme + shared secret as session-login/webauthn — verifies
// signature AND expiry, kept self-contained per this project's edge-fn
// convention (see ai-ops-assistant's verifySessionToken).
async function verifySessionToken(authHeader: string | null): Promise<number | null> {
  if (!authHeader?.startsWith("Bearer ") || !JWT_SECRET) return null;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC", key, base64urlToBytes(encSig), new TextEncoder().encode(`${encHeader}.${encPayload}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encPayload)));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload.app_user_id ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const callerId = await verifySessionToken(req.headers.get("authorization"));
    if (!callerId) return json({ ok: false, error: "Unauthorized — a valid session token is required" }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: caller } = await supabase.from("users").select("role").eq("id", callerId).maybeSingle();
    if (!caller || caller.role !== "ADMIN") {
      return json({ ok: false, error: "Admins only." }, 403);
    }

    let body: { path?: string };
    try { body = await req.json(); } catch { return json({ ok: false, error: "Invalid request body" }, 400); }
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) return json({ ok: false, error: "A storage path is required." }, 400);

    // Only sign a path that a real retention_exports row points at — never
    // an arbitrary object key from the request.
    const { data: exportRow, error: exportErr } = await supabase
      .from("retention_exports").select("id").eq("storage_path", path).limit(1).maybeSingle();
    if (exportErr) {
      console.error("[retention-archive-url] lookup failed:", exportErr.message);
      return json({ ok: false, error: "Internal error — please try again." }, 500);
    }
    if (!exportRow) return json({ ok: false, error: "No archive record matches that path." }, 404);

    const { data: signed, error: signErr } = await supabase.storage
      .from(BUCKET).createSignedUrl(path, URL_TTL_SECONDS, { download: true });
    if (signErr || !signed?.signedUrl) {
      console.error("[retention-archive-url] sign failed:", signErr?.message);
      return json({ ok: false, error: "Couldn't generate a download link." }, 500);
    }

    return json({ ok: true, url: signed.signedUrl, expires_in: URL_TTL_SECONDS });
  } catch (e) {
    console.error("retention-archive-url failed:", (e as Error).message);
    return json({ ok: false, error: "Internal error — please try again." }, 500);
  }
});
