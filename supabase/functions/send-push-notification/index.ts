// send-push-notification — Supabase Edge Function
//
// The server-side half of Web Push. A browser can SUBSCRIBE to push
// notifications on its own, but only a server holding the VAPID private
// key can actually SEND one — that's the whole reason this exists as a
// separate function rather than something the main app does directly.
//
// Called from the main app (App.jsx's insertNotification)
// every time a real in-app notification is created, with a specific
// list of target user ids. Looks up each user's stored push
// subscription(s) — a person can have more than one device — and
// delivers to every one of them via the standard Web Push protocol.
//
// Per explicit requirement: this is what lets a message/notification
// reach a user's phone even with the app fully closed or the screen
// locked — the actual mechanism, not just a nice-to-have.
//
// FIXED (2026-07-31) — two real, confirmed bugs:
//  1. No CORS/OPTIONS handling at all, combined with this function's
//     verify_jwt being ON at the platform level. A browser cross-origin
//     POST with a JSON body triggers a CORS preflight (OPTIONS) first —
//     preflight requests never carry an Authorization header (that's the
//     whole point of preflight), so Supabase's own platform-level JWT gate
//     rejected the OPTIONS request itself before this function's code ever
//     ran, and that platform-level rejection carries no CORS headers.
//     Result: every call failed in the browser with "No
//     'Access-Control-Allow-Origin' header is present" / net::ERR_FAILED,
//     regardless of whether the real POST would have succeeded — this
//     function has never actually been able to send a push notification
//     from the browser. Fixed by turning platform verify_jwt OFF (see
//     deploy config, matches webauthn/session-login/daily-trip-sheet) and
//     handling CORS/OPTIONS explicitly in code instead, the same pattern
//     used by every other function in this project.
//  2. No authorization at all otherwise — confirmed in the earlier
//     security audit: anyone who found this function's URL could POST
//     arbitrary user_ids/title/message and push a fully "real-looking"
//     Pearce & Sons notification to any device, unauthenticated. Now
//     requires a valid app session token (the same kind session-login/
//     webauthn issue), verified the same way those functions do.
//
// FIXED (2026-08-01) — a third bug, more subtle than #2 above:
//  3. verifySessionToken() proves WHO the caller is, but the code never
//     checked WHAT they were allowed to send. Any logged-in user of ANY
//     role — the lowest-privilege driver or agent account, just by
//     logging in normally — could POST directly to this function's URL
//     with an arbitrary user_ids array, title, message, type, and
//     trip_id, and it would send a real, official-looking "Pearce &
//     Sons" OS-level push to any device in the system with fully
//     fabricated content (including e.g. a fake SOS_ALERT). This
//     completely bypassed every in-app authorization check in
//     handleSupabaseAction — that logic only governs the in-app
//     notification path (the `notifications` table insert), never this
//     direct edge-function call. Fixed by requiring a matching row to
//     already exist in `notifications` (same userid, same message,
//     inserted within a few seconds of the client-supplied `ts`) before
//     sending anything — insertNotification() in the main app always
//     writes that row FIRST, then calls this function with the exact
//     same message/ts, so this ties every push to content the app's own
//     already-authorized insertNotification() path actually produced,
//     rather than trusting the POST body on its own. Any user_ids with
//     no matching row are silently dropped from the send list instead of
//     being pushed to.
//
// LOCAL/DEPLOYED DRIFT FOUND AND CLOSED (2026-08-06) — a dedicated
// security audit found this exact file on disk in the repo was MISSING
// fix #3 above entirely (no notifications-row-matching check at all,
// just the session-token check from fix #2) — a real, serious-looking
// regression on paper. Pulled the ACTUALLY DEPLOYED function via the
// Supabase MCP `get_edge_function` tool before touching anything (per
// this project's own established practice, given its documented history
// of exactly this kind of drift) and found production was already
// running the correct, fully-fixed v29 (deployed 2026-08-01, this exact
// code) — so there was no live vulnerability window, only a stale local
// source file that never got updated to match what was actually shipped.
// Restored local to match deployed exactly rather than deploying a
// freshly-written (and, on comparison, slightly worse — it required
// `ts` to be present at all, breaking silently for an old cached client
// bundle that predates this field) version over an already-correct one.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "https://esm.sh/web-push@3.6.7";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY");
// mailto: is required by the Web Push spec as a contact point push
// services can reach out to if something's wrong with how this server
// is sending pushes (e.g. sending too aggressively) — not shown to
// users anywhere, purely infrastructure-level.
const VAPID_CONTACT_EMAIL = Deno.env.get("VAPID_CONTACT_EMAIL") || "app@pearceandsons.co.za";
// Same secret as session-login/webauthn — cannot use a SUPABASE_ prefix,
// Supabase reserves that for its own auto-injected platform variables.
const JWT_SECRET = Deno.env.get("PROJECT_JWT_SECRETS");
// Same shared secret check-late-start/check-upcoming-reminders/
// daily-trip-sheet/trip-history-retention already use to authenticate
// themselves to pg_cron. Accepted here as an ALTERNATIVE to a real user
// session token — added 2026-08-09 so those two scheduled functions can
// actually push a reminder/late-start notification to a closed app
// instead of only ever writing a DB row nobody sees until they happen to
// reopen it (found via a dedicated logic audit: neither previously called
// this function at all). Safe to accept a second caller-identity path
// here specifically because verifySessionToken was never the actual
// anti-abuse boundary — the notifications-row-match check further down
// (fix #3 in this file's own history) is what prevents arbitrary content
// from being pushed, and that check is completely unaffected by which
// credential got the caller past this first gate.
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

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

// Verifies a token minted by session-login/webauthn (same HS256 scheme,
// same shared secret) — checks the signature AND expiry, not just that it
// parses as JSON. Returns the app_user_id claim if valid, null otherwise.
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
  try {
    const authHeader = req.headers.get("authorization");
    const isCronCaller = !!CRON_AUTH_TOKEN && authHeader === `Bearer ${CRON_AUTH_TOKEN}`;
    const callerId = isCronCaller ? null : await verifySessionToken(authHeader);
    if (!isCronCaller && !callerId) return json({ ok: false, error: "Unauthorized — a valid session token is required" }, 401);

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured — see this function's README to generate a real keypair.");
    }
    webpush.setVapidDetails(`mailto:${VAPID_CONTACT_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const { user_ids, title, message, type, trip_id, ts } = await req.json();
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return json({ ok: true, sent: 0, note: "No target users provided" });
    }
    if (!message) {
      return json({ ok: true, sent: 0, note: "No message provided" });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Authorization check #2 (see fix #3 above) — verifySessionToken only
    // proves the caller is SOMEONE logged in, not that THIS push content
    // was ever legitimately produced. Require a real notifications row —
    // written by the app's own already-authorized insertNotification()
    // path — matching each target user + this exact message, inserted
    // within a few seconds of the client-supplied ts (falls back to "in
    // the last 15s" if ts is missing, e.g. an older cached client bundle).
    // Any user_id without a matching row is dropped from the send list —
    // never pushed to based on the POST body alone.
    const tsNum = Number(ts);
    const windowStart = Number.isFinite(tsNum) ? tsNum - 5000 : Date.now() - 15000;
    const windowEnd = Number.isFinite(tsNum) ? tsNum + 5000 : Date.now() + 1000;
    const { data: matchedNotifs, error: matchError } = await supabase
      .from("notifications")
      .select("userid")
      .in("userid", user_ids)
      .eq("message", message)
      .gte("timestamp", windowStart)
      .lte("timestamp", windowEnd);
    if (matchError) throw matchError;
    const authorizedIds = new Set((matchedNotifs || []).map((r: { userid: unknown }) => String(r.userid)));
    const targetIds = user_ids.filter((id: unknown) => authorizedIds.has(String(id)));
    if (targetIds.length === 0) {
      return json({ ok: true, sent: 0, note: "No matching notification found for any target user — nothing sent" });
    }

    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("userid", targetIds);
    if (subsError) throw subsError;

    const payload = JSON.stringify({
      title: title || "Pearce & Sons",
      body: message || "",
      type: type || null,
      trip_id: trip_id ?? null,
      // Used by the service worker's push-event handler to open the
      // right screen when the user taps the notification, rather than
      // just opening the app to whatever tab it last had open.
      url: "/",
    });

    let sentCount = 0;
    const staleEndpoints = [];
    // Sent one at a time rather than Promise.all — a push service
    // rejecting one subscription (expired, user revoked permission,
    // etc.) must never block or fail delivery to anyone else in the
    // same batch.
    for (const sub of subs || []) {
      try {
        // ADDED (2026-08-08, improvement audit): web-push's
        // sendNotification() has no built-in per-call timeout option, so
        // a single hung push-service connection previously had no
        // app-level bound at all — worse than the other edge functions'
        // equivalent gap, since this call runs inside a sequential loop
        // (deliberately not Promise.all, see the comment above), so one
        // stuck request would stall delivery to every subscriber still
        // waiting behind it in the same batch, not just fail gracefully
        // for itself. Promise.race with a timeout, since the library
        // doesn't accept an AbortSignal directly.
        await Promise.race([
          webpush.sendNotification(sub.subscription, payload),
          new Promise((_, reject) => setTimeout(() => reject(new Error("push send timed out")), 15000)),
        ]);
        sentCount++;
      } catch (e) {
        // 404/410 from the push service means this subscription is
        // permanently dead (uninstalled, revoked, expired) — clean it
        // up so future notifications don't keep wasting a send
        // attempt on it. Any OTHER error (e.g. a transient network
        // issue) is logged but the row is left alone, since it might
        // still be good next time.
        if (e.statusCode === 404 || e.statusCode === 410) {
          staleEndpoints.push(sub.endpoint);
        } else {
          console.warn(`[send-push-notification] failed for endpoint ${sub.endpoint}:`, e.message);
        }
      }
    }
    if (staleEndpoints.length > 0) {
      await supabase.from("push_subscriptions").delete().in("endpoint", staleEndpoints);
    }

    return json({ ok: true, sent: sentCount, staleRemoved: staleEndpoints.length, targeted: (subs || []).length });
  } catch (e) {
    console.error("[send-push-notification]", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "Internal error — please try again." }, 500);
  }
});
