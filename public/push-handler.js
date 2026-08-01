// push-handler.js — place this in your project's public/ folder
// Then add importScripts: ['push-handler.js'] to your VitePWA workbox config
// See SERVICE_WORKER_SETUP.md for full instructions.

// Handles incoming Web Push events — shows a real notification even
// with the app fully closed or the screen locked.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); } catch (e) { return; }

  const notificationData = {
    url: '/',
    tripId: data.trip_id || null,
    type: data.type || null,
    callChannelName: data.callChannelName || null,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'Pearce & Sons', {
      body: data.message || data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: notificationData,
      // tag groups same-trip notifications so a burst doesn't pile up
      tag: data.trip_id ? `trip-${data.trip_id}` : (data.type || 'general'),
      requireInteraction: data.type === 'INCOMING_CALL',
    })
  );
});

// Tapping a notification: focus or open the app, then tell it what
// was tapped via postMessage so it can jump to the right screen
// (trip detail, conversation, or incoming call screen).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientsList) => {
        // Find an existing open window for this origin
        const existing = clientsList.find(
          (c) => c.url.includes(self.location.origin) && 'focus' in c
        );

        const postAction = (client) => {
          // Tell the app what to do now that it's focused — the app
          // listens for this message on window and handles it
          // (show ringing screen, jump to trip, open conversation, etc.)
          client.postMessage({
            type: 'NOTIFICATION_CLICKED',
            tripId: notifData.tripId || null,
            notifType: notifData.type || null,
            callChannelName: notifData.callChannelName || null,
          });
        };

        if (existing) {
          return existing.focus().then((client) => { postAction(client); return client; });
        }
        return self.clients.openWindow(notifData.url || '/').then((client) => {
          if (client) {
            // Small delay gives the app time to mount before the message arrives
            setTimeout(() => postAction(client), 1500);
          }
        });
      })
  );
});

// Recovers when the browser's push service silently rotates/invalidates a
// subscription (a real, documented Push API behavior — Chrome in
// particular does this periodically, not hypothetical). Without this,
// nothing ever detects the rotation: the app's own login-triggered
// subscribeToPushNotifications() only creates a NEW subscription if
// getSubscription() returns none, but the browser's local subscription
// object often still resolves even after the push SERVICE has invalidated
// it server-side — so that fallback just silently re-saves the same dead
// endpoint. This is a service-worker-only event; it can never fire from
// the main app thread, which is why it has to live here.
//
// Values below are duplicated from src/TransitOS_web.jsx (VAPID_PUBLIC_KEY,
// SUPABASE_URL/ANON_KEY, urlBase64ToUint8Array) since this is a static
// public/ file with no bundler access to the app's constants — same
// reason push-handler.js already exists as its own file. All three are
// public-safe values already shipped in the client bundle, not secrets.
const _PUSH_VAPID_PUBLIC_KEY = 'BMJk0yevqTBRrkZnR3jYmifhfELzhbXMNJV6HR5iNREt7GCGeNFZx_dfBumHyIOLnJv_UWgjbquNBmNQK6FrgsE';
const _PUSH_SUPABASE_URL = 'https://kwkgiylwnafwimxqmjwk.supabase.co';
const _PUSH_SUPABASE_ANON_KEY = 'sb_publishable_Kyne7Q6PJ2uKmcfslI-qNQ_CX-m7mxF';

function _pushUrlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const oldEndpoint = event.oldSubscription ? event.oldSubscription.endpoint : null;
        // Prefer the browser-furnished applicationServerKey from the old
        // subscription (the spec-recommended approach) — falls back to
        // the hardcoded VAPID key only if the browser didn't supply one.
        const appServerKey = (event.oldSubscription && event.oldSubscription.options
          && event.oldSubscription.options.applicationServerKey)
          || _pushUrlBase64ToUint8Array(_PUSH_VAPID_PUBLIC_KEY);
        const newSub = event.newSubscription
          || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey });

        // The service worker has no direct access to "who is currently
        // logged in" — carry ownership forward from the OLD row instead
        // of trying to re-derive it, matching how account-switch re-keying
        // already works via the (userid, endpoint) upsert on the main
        // thread (onConflict: "endpoint").
        let userId = null;
        if (oldEndpoint) {
          const lookupRes = await fetch(
            `${_PUSH_SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(oldEndpoint)}&select=userid`,
            { headers: { apikey: _PUSH_SUPABASE_ANON_KEY, Authorization: `Bearer ${_PUSH_SUPABASE_ANON_KEY}` } }
          );
          const rows = await lookupRes.json().catch(() => []);
          userId = (rows && rows[0] && rows[0].userid) || null;
        }
        if (userId == null) return; // nothing to re-associate the new subscription with — best-effort, give up quietly

        await fetch(`${_PUSH_SUPABASE_URL}/rest/v1/push_subscriptions?on_conflict=endpoint`, {
          method: 'POST',
          headers: {
            apikey: _PUSH_SUPABASE_ANON_KEY,
            Authorization: `Bearer ${_PUSH_SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates',
          },
          body: JSON.stringify({
            userid: userId, endpoint: newSub.endpoint,
            subscription: newSub.toJSON(), updatedat: new Date().toISOString(),
          }),
        });

        // Clean up the now-dead old row if the endpoint actually changed —
        // otherwise it just sits there forever, a subscription nothing
        // will ever successfully push to again.
        if (oldEndpoint && oldEndpoint !== newSub.endpoint) {
          await fetch(`${_PUSH_SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(oldEndpoint)}`, {
            method: 'DELETE',
            headers: { apikey: _PUSH_SUPABASE_ANON_KEY, Authorization: `Bearer ${_PUSH_SUPABASE_ANON_KEY}` },
          });
        }
      } catch (e) {
        // Best-effort — a failure here just leaves push silently broken
        // until the user's next login re-triggers subscribeToPushNotifications,
        // matching the pre-existing fallback behavior. Never let a push
        // recovery failure surface as anything the user sees.
      }
    })()
  );
});
