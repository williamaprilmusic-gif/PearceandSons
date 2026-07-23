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
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
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
