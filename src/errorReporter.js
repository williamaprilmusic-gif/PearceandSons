// Lazy error reporting (Sentry).
//
// There is no Sentry DSN configured for this project yet, so
// @sentry/react must not sit in the initial bundle that every agent /
// driver / admin downloads on first load — it is a large dependency for
// what is currently a no-op. This module keeps the import behind a
// dynamic `import()` so the bundler emits it as its own chunk that is
// only ever fetched once VITE_SENTRY_DSN is set (and even then, only on
// first init or first error).
//
// The primary error trail is unaffected either way: componentDidCatch /
// dispatch's catch block still write a client_errors row and fire the
// admin push + crash-alert email directly (see AppErrorBoundary and the
// crash-alert Edge Function). Sentry is only the optional external
// aggregator on top of that.

const DSN = import.meta.env.VITE_SENTRY_DSN;
let sentryPromise = null;

function loadSentry() {
  if (!DSN) return null;
  if (!sentryPromise) {
    sentryPromise = import("@sentry/react").catch((e) => {
      // A failed chunk fetch must never escalate into an app error —
      // reporting is best-effort. Reset so a later call can retry.
      console.warn("[errorReporter] Sentry chunk failed to load:", e?.message);
      sentryPromise = null;
      return null;
    });
  }
  return sentryPromise;
}

export function initErrorReporting() {
  const p = loadSentry();
  if (!p) return;
  p.then((S) => {
    if (!S) return;
    S.init({
      dsn: DSN,
      environment: import.meta.env.MODE,
      // Error reporting only — no perf/replay sampling, matching the
      // scope of the client_errors table it complements.
      sendDefaultPii: false,
    });
  }).catch(() => {});
}

// Best-effort: no DSN → resolves to nothing and @sentry/react is never
// fetched. `extra` is an arbitrary context object.
export function reportError(error, extra) {
  const p = loadSentry();
  if (!p) return;
  p.then((S) => { if (S) S.captureException(error, extra ? { extra } : undefined); }).catch(() => {});
}
