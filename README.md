# TransitOS — Pearce & Sons Staff Transport

A dispatch and staff-transport management app: agents book rides, drivers run them with in-app turn-by-turn navigation, and admins (Fleet Ops / Standard / Viewer / Financial tiers) dispatch, track, and bill for it. Deployed live at `pearceand-sons.vercel.app`.

## Stack

- **Client**: React 19, single-page app, no router (view switching is plain `useState`). Vite build.
- **Backend**: Supabase — Postgres (with row-level security), realtime subscriptions, and Deno edge functions.
- **Auth**: a **custom** JWT system, not Supabase's native GoTrue. `supabase/functions/session-login` mints HS256-signed tokens after checking the password server-side; `supabase/functions/webauthn` does the same for biometric/passkey login. Every RLS policy in the database checks `auth.jwt() ->> 'app_user_id'` against these tokens, not `auth.uid()`.
- **Maps/nav**: Leaflet + TomTom tiles for the driver's in-app navigation (not an external Waze handoff), a hand-rolled SVG Web Mercator projection for the admin live-fleet map.
- **Push**: Web Push (VAPID keys), sent from `supabase/functions/send-push-notification`.
- **AI**: an admin-only ops-assistant chat backed by Google Gemini (`supabase/functions/ai-ops-assistant`), answering from a bounded read-only data snapshot — never runs SQL itself.

## Layout

```
src/TransitOS_web.jsx      Almost the entire client app — shared constants/helpers,
                            the demo-mode reducer, real Supabase action handlers,
                            and the Agent/Driver/ClientPortal UI. Large by design;
                            see inline comments before restructuring anything.
src/admin/AdminSection.jsx Every admin-only screen (dashboard, dispatch, live map,
                            vehicles, users, tickets, CSV exports, AI assistant,
                            financial). Dynamically imported (React.lazy) so
                            agent/driver sessions never download this code.
src/main.jsx                Entry point.
supabase/functions/*        Edge functions — session-login, webauthn,
                            send-push-notification, ai-ops-assistant, and 3
                            pg_cron-scheduled jobs (check-late-start,
                            check-upcoming-reminders, daily-trip-sheet,
                            trip-history-retention).
public/                     Static assets — icons, manifest, service worker.
```

There is no separate backend server — Vercel serves the static client build, and everything server-side is a Supabase edge function or a direct RLS-protected Postgres query from the client.

## Running locally

```
npm install
npm run dev       # Vite dev server
npm run build     # production build (also what Vercel runs on push to main)
npm run lint      # ESLint — real bug-catching rules (no-undef, rules-of-hooks)
                   # are errors; missing-hook-dependency warnings need individual
                   # judgment, not a blind fix — several are intentional
npm test          # Vitest — pure business-logic unit tests (fee/pay calculations,
                   # admin scoping, doc/vehicle expiry, driver-hours math). Imports
                   # straight from TransitOS_web.jsx; no rendered-component tests yet.
```

`.env` holds local secrets (Supabase URL/anon key, TomTom key, etc.) — gitignored, not `VITE_`-prefixed where it shouldn't be bundled into the client.

## Deploying

Push to `main` — Vercel auto-deploys. `.github/workflows/ci.yml` runs build/lint/test on every push and PR against `main` as a fail-fast gate (GitHub Actions, `ubuntu-latest`, Node 22 — Node 20 doesn't work, see the workflow's own comment). Database migrations and edge function deploys are applied directly against the live Supabase project (ref `kwkgiylwnafwimxqmjwk`) as part of the same change, not through that pipeline.

## Error tracking

Client-side crash reporting exists in two layers, both active without any setup: `AppErrorBoundary` (render errors) and `dispatch`'s catch block (failed Supabase actions — RLS denials, network errors) in `TransitOS_web.jsx` both write to the `client_errors` table and notify admins in-app. Optionally, both also report to Sentry (`@sentry/react`) if `VITE_SENTRY_DSN` is set as a Vercel env var — inert otherwise. To enable it: sign up for Sentry's free tier, create a React project, and add its DSN as `VITE_SENTRY_DSN` in Vercel's project settings, then redeploy.

`AppErrorBoundary` specifically escalates further: it targets the in-app notification at real admin user ids (not a role broadcast) so it actually fires a push to admin devices, and also calls the `crash-alert` edge function to send an email via Resend — throttled per browser session per error message so a crash loop can't spam the inbox. `crash-alert` requires a matching `client_errors` row to already exist (anti-forgery, same pattern as `send-push-notification`) before it'll send anything, so it can't be triggered by an arbitrary direct POST.

## Things that aren't obvious from the code alone

- **Two separate "money" concepts, kept deliberately apart everywhere**: Trip Fee (billed to the client, per agent, by that agent's own outcome on the trip) and Driver Payment (paid to the driver, reference-only). Never conflate the two — see `agentFeeAmount`/`tripDriverPayment` in `TransitOS_web.jsx`.
- **The demo/fallback reducer and the real Supabase handler implement the same business rules twice** (offline/demo-mode support). This has been a real source of bugs when the two copies drift — if you change a rule in one, check the other.
- **RLS auth check pattern**: every policy uses `((select auth.jwt()) ->> 'app_user_id') is not null` — the `select` wrapper matters for query performance (unwrapped `auth.jwt()` calls re-evaluate per row).
