import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './TransitOS_web.jsx';

// Inert until VITE_SENTRY_DSN is set (Vercel env var) — no account exists
// yet for this project. See README's "Error tracking" section.
const dsn = import.meta.env.VITE_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // No perf/replay sampling — this is error reporting only, matching
    // the scope of the client_errors table it complements (see
    // AppErrorBoundary and dispatch's catch block in TransitOS_web.jsx).
    sendDefaultPii: false,
  });
}

const root = createRoot(document.getElementById('root'));
root.render(<App />);
