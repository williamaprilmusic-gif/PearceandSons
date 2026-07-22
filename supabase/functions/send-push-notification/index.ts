// send-push-notification — Supabase Edge Function
//
// The server-side half of Web Push. A browser can SUBSCRIBE to push
// notifications on its own, but only a server holding the VAPID private
// key can actually SEND one — that's the whole reason this exists as a
// separate function rather than something the main app does directly.
//
// Called from the main app (TransitOS_web.jsx's insertNotification)
// every time a real in-app notification is created, with a specific
// list of target user ids. Looks up each user's stored push
// subscription(s) — a person can have more than one device — and
// delivers to every one of them via the standard Web Push protocol.
//
// Per explicit requirement: this is what lets a message/notification
// reach a user's phone even with the app fully closed or the screen
// locked — the actual mechanism, not just a nice-to-have.

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

Deno.serve(async (req) => {
  try {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      throw new Error("VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY not configured — see this function's README to generate a real keypair.");
    }
    webpush.setVapidDetails(`mailto:${VAPID_CONTACT_EMAIL}`, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

    const { user_ids, title, message, type, trip_id } = await req.json();
    if (!user_ids || !Array.isArray(user_ids) || user_ids.length === 0) {
      return new Response(JSON.stringify({ ok: true, sent: 0, note: "No target users provided" }), { headers: { "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: subs, error: subsError } = await supabase
      .from("push_subscriptions")
      .select("*")
      .in("userid", user_ids);
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
        await webpush.sendNotification(sub.subscription, payload);
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

    return new Response(JSON.stringify({ ok: true, sent: sentCount, staleRemoved: staleEndpoints.length, targeted: (subs || []).length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
