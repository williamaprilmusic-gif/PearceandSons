importScripts('/push-handler.js');

const CACHE = 'transitos-v1';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', e => {
  // Deliberately keep addAll's fail-safe semantics: if a precache URL
  // can't be fetched (mid-deploy 5xx, a blip right after load), the whole
  // install rejects, NO worker activates, the browser handles the page
  // normally, and the full precache is retried on the next load. The
  // alternative (install anyway with a half-empty cache) lets the worker
  // claim the page while the navigate handler's offline fallback has
  // nothing to serve — a worse failure than "no worker yet".
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Guard against non-http(s) schemes (e.g. chrome-extension://, injected
  // by some browser extensions' content scripts triggering fetches this
  // listener still sees) — Cache.put() throws "Request scheme ...
  // is unsupported" for these, which was an uncaught promise rejection
  // on every page load for affected users. Nothing below can handle
  // these anyway; let the browser's default handling take it.
  if (!url.protocol.startsWith('http')) return;

  // Network-only for Supabase API calls — no cache fallback, because this
  // branch never writes anything TO the cache in the first place (unlike
  // the app-shell and static-asset branches below, which both call
  // caches.open(CACHE).then(c => c.put(...)) on a successful fetch). The
  // old `.catch(() => caches.match(e.request))` here was dead code: on any
  // genuine network failure it fell through to a cache lookup that was
  // GUARANTEED to find nothing, which — instead of a useful offline
  // fallback — produced a confusing "FetchEvent ... resulted in a network
  // error response" browser-level error on every transient network hiccup
  // (this app's own established normal condition for a driver on the
  // road), on top of the genuine failure that was already happening.
  // Dynamic per-request REST data isn't something that should ever be
  // served from a stale cache anyway — same reasoning already applied to
  // the TomTom/Nominatim branch below. Letting the fetch failure propagate
  // cleanly (no catch) hands it straight to the app's own already-robust
  // offline handling (enqueueOfflineAction/isNetworkError, the useFallback
  // fix, etc.) instead of routing it through a pointless dead end first.
  if (url.hostname.includes('supabase.co')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-only for third-party routing/geocoding APIs — TomTom and
  // Nominatim URLs are near-always unique (embedded coordinates, query
  // text), so letting them fall through to the cache-first branch below
  // grew this cache UNBOUNDED: one entry per distinct route/search/geocode
  // request ever made over the app's lifetime, with nothing here ever
  // expiring an individual entry, and CACHE's name never changing between
  // deploys (see the app-shell branch below for why that matters) means
  // activate's cleanup never evicted any of it either. These responses are
  // also just wrong to cache on their own terms — a routing/geocoding
  // result is only valid for the specific query that produced it, not
  // something meant to be replayed offline.
  if (url.hostname.includes('api.tomtom.com') || url.hostname.includes('nominatim.openstreetmap.org')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Network-first for the app shell (page navigations) and manifest.json
  // — these must always reflect the LATEST deploy for anyone online. The
  // blanket cache-first strategy below never re-checks the network once
  // something's cached, and CACHE's name never changes between deploys
  // (so activate's cleanup below never actually discards anything) —
  // together that meant a returning user could get stuck FOREVER on
  // whatever index.html/manifest.json their browser happened to cache
  // before their very first visit, silently never receiving any fix
  // shipped in any later deploy (confirmed in production: manifest.json
  // was fixed to reference the real icon filenames several commits ago,
  // but a browser that had already cached the old manifest kept 404ing
  // on the old, wrong filename indefinitely). Cache-first below stays
  // safe for hashed JS/CSS bundle filenames specifically, since Vite
  // content-hashes those — a stale cache entry for an old filename is
  // simply unused once a new deploy's index.html references a new one.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/manifest.json') {
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (hashed JS/CSS bundles, icons)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
