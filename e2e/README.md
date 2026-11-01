# End-to-end tests (Playwright)

Browser journeys that drive the real built app. Complements the Vitest unit
suite (`npm test`), which covers logic but renders nothing.

## One-time setup

```bash
npm install                 # installs @playwright/test (added to devDependencies)
```

The config uses your installed Google Chrome (`channel: "chrome"`), so no
browser download is needed. To use Playwright's bundled Chromium instead,
remove `channel: "chrome"` from `playwright.config.js` and run
`npx playwright install chromium`.

## Running

```bash
npm run test:e2e            # builds, serves on :4173, runs all specs
npm run test:e2e -- --headed   # watch it drive the browser
```

`webServer` runs `npm run build && npm run preview` automatically. If a dev
server is already on the port it is reused.

## Authentication (for the authenticated journeys)

The authenticated specs (`agent-journey.spec.js`, future `driver-journey`)
**skip themselves** until you provide test credentials. No password is ever
typed into the UI — `global-setup.js` mints a session token straight from the
app's own `session-login` endpoint and seeds it into `localStorage`.

Create an **uncommitted** `.env.e2e` in the repo root:

```
E2E_AGENT_USERNAME=some-test-agent
E2E_AGENT_PASSWORD=...
# optional, for driver journeys:
E2E_DRIVER_USERNAME=some-test-driver
E2E_DRIVER_PASSWORD=...
```

> Use throwaway **test accounts**, not real staff logins — `session-login`
> runs against the production Supabase project, so these are real users.
> `.env.e2e` and `e2e/.auth/` are git-ignored.

## Layout

| File | Purpose |
|------|---------|
| `../playwright.config.js` | runner config, `.env.e2e` loader, web server |
| `global-setup.js` | mints + stores auth state per role (skips if no creds) |
| `smoke.spec.js` | unauthenticated: login renders, no console errors |
| `agent-journey.spec.js` | authenticated agent; offline-ETA UI template |
| `.auth/*.json` | generated storage states (git-ignored) |
