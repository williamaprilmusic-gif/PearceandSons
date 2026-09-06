import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './TransitOS_web.jsx';
import { initErrorReporting } from './errorReporter.js';

// Inert until VITE_SENTRY_DSN is set (Vercel env var) — no account exists
// yet for this project. @sentry/react is loaded as its own lazy chunk
// only when a DSN is present, so it costs the initial bundle nothing
// today. See errorReporter.js and README's "Error tracking" section.
initErrorReporting();

// Vite dispatches this when a lazy-loaded chunk's dynamic import() fails
// to fetch — e.g. a driver's tab has index.html cached from before a
// later deploy replaced that chunk's content hash, so the old filename
// 404s against the new deployment. Without this listener the rejected
// import propagates to React's lazy/Suspense boundary and crashes to
// AppErrorBoundary's "Something went wrong" screen (see the
// client_errors row this produced for DriverNavMap's chunk on
// 2026-08-21) even though nothing is actually broken — the fix is just
// to fetch the current index.html.
//
// Guarded by a one-time-per-tab sessionStorage flag against a reload
// loop if this keeps failing for some other reason (e.g. a genuinely
// broken deploy, not just a stale client cache). FOUND VIA /code-review
// (two bugs, both fixed):
// 1. reload() used to run unconditionally after the try/catch, so if
//    sessionStorage.setItem itself threw (privacy-restricted browser,
//    quota exceeded) the flag never actually persisted and every
//    preloadError reloaded again with no guard at all — reload() now
//    only runs once the flag write is confirmed to have succeeded.
// 2. The flag used to self-clear a fixed 5s after mount so a later,
//    unrelated deploy-while-tab-open would still get its own retry —
//    but that same timer meant a persistently broken chunk (not a
//    stale-cache issue) would just keep re-arming the reload every 5s+
//    forever, so it was removed in favor of a single reload per tab
//    visit. FOUND VIA /code-review (7th pass): that traded one real bug
//    for another — this app's admin/dispatch tabs are routinely left
//    open across a full overnight shift (see this session's other live-
//    map/dispatch work), so a SECOND, wholly independent deploy hours
//    later would permanently fall through to the crash screen with no
//    further self-heal attempt for the rest of that shift. Reinstated
//    the self-clearing timer, but at 5 MINUTES instead of 5 seconds —
//    long enough that even a persistently broken chunk can only re-arm
//    a reload at most once every 5 minutes (an occasional retry, not
//    the tight loop the 5s version risked), while still letting a
//    later, independent stale-chunk failure in a long-lived tab recover
//    on its own instead of requiring a manual RELOAD click.
// 3. FOUND VIA /code-review (2nd pass): Vite's preload helper re-throws
//    the original import error after dispatching this event unless the
//    handler calls event.preventDefault() — without it, the reload below
//    was racing the still-rejected import promise, which could still hit
//    AppErrorBoundary (client_errors row + Sentry report) for a moment
//    before navigation actually took over. preventDefault() only fires
//    on the path that's actually about to reload, so the "already
//    attempted"/sessionStorage-unavailable fallback paths still let the
//    error propagate to the crash boundary as intended.
// 4. FOUND VIA /code-review (4th pass): a deploy that replaces several
//    chunk hashes at once can fire multiple preloadError events within
//    the same tick (e.g. two prefetched chunks both 404 together). Only
//    the FIRST used to get preventDefault() — by the time the second
//    ran, sessionStorage already read back '1' from the first, so it
//    hit the "already attempted" return above without ever calling
//    preventDefault(), letting ITS rejection through to the crash
//    boundary even though a reload was already in flight to fix
//    everything. reloadTriggeredThisPageLoad tracks that in memory (not
//    sessionStorage, which persists across the reload itself) so every
//    preloadError event during the SAME page life gets suppressed once
//    the first one has kicked off a reload — only a genuine repeat
//    failure AFTER a completed reload (sessionStorage flag already '1'
//    when this page life started) falls through to the crash boundary.
let reloadTriggeredThisPageLoad = false;
window.addEventListener('vite:preloadError', (event) => {
  if (reloadTriggeredThisPageLoad) { event.preventDefault(); return; }
  const key = 'transitos_chunk_reload_attempted';
  let alreadyAttempted;
  try {
    alreadyAttempted = sessionStorage.getItem(key) === '1';
    if (!alreadyAttempted) {
      sessionStorage.setItem(key, '1');
      // FOUND VIA /code-review: some embedded webviews / privacy-restricted
      // contexts accept setItem without throwing AND without persisting it —
      // getItem would still read null on the next page load, so a genuinely
      // broken (not stale-cache) deploy would reload-loop, since the
      // try/catch only covers the throw case. Read it back and bail if the
      // guard didn't actually stick.
      if (sessionStorage.getItem(key) !== '1') return;
    }
  } catch (e) {
    return; // can't confirm the guard held — don't risk an unguarded reload loop
  }
  if (alreadyAttempted) return; // already reloaded once this tab and it didn't help
  reloadTriggeredThisPageLoad = true;
  event.preventDefault();
  window.location.reload();
});

const root = createRoot(document.getElementById('root'));
root.render(<App />);
setTimeout(() => { try { sessionStorage.removeItem('transitos_chunk_reload_attempted'); } catch (e) {} }, 5 * 60 * 1000);
