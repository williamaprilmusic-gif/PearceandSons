importScripts('/push-handler.js');

const CACHE = 'transitos-v1';
const PRECACHE = ['/', '/index.html'];

self.addEventListener('install', e => {
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

  // Network-first for Supabase API calls
  if (url.hostname.includes('supabase.co')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
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
