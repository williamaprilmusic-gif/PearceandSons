// TransitOS service worker — minimal app-shell caching.
//
// Scope deliberately kept small: this is a live dispatch/booking tool
// backed by Supabase, so real-time data must NEVER be served stale from
// cache. Only the static app shell (HTML/JS/CSS/icons) is cached, purely
// so the app still loads (to a "you're offline" state) if a driver briefly
// loses signal mid-route. All Supabase API calls always go to the network.

const CACHE_NAME = "transitos-shell-v1";
const SHELL_ASSETS = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache Supabase API/realtime traffic — trip/driver/notification
  // data must always be live. Let these pass straight through to network.
  if (url.hostname.endsWith(".supabase.co")) return;

  // Never cache Nominatim/OSM address lookups either — same reasoning.
  if (url.hostname.includes("nominatim.openstreetmap.org")) return;

  // App shell: cache-first, falling back to network, so the shell still
  // loads offline. Everything else: network-first, cache as a fallback
  // only (covers things like the street-name/leaflet assets if used).
  if (event.request.mode === "navigate" || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
