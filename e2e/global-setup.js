// Playwright global setup — mints an app session token from the project's own
// session-login edge function using credentials supplied in an uncommitted
// .env.e2e, and writes it as a Playwright storageState so authenticated specs
// start already-logged-in. No password is ever typed into the UI: the token is
// minted over HTTP exactly as the app's fetchSessionToken does, then dropped
// into the two localStorage keys the app reads on boot
// (transitos_session_token + transitos_active_user_id).
//
// With no E2E_AGENT_USERNAME/PASSWORD set, no auth state is written and the
// authenticated specs skip themselves; the unauthenticated smoke still runs.
import fs from "node:fs";
import path from "node:path";

const SESSION_LOGIN_URL = "https://kwkgiylwnafwimxqmjwk.supabase.co/functions/v1/session-login";
const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");

async function mint(role, username, password, origin) {
  const res = await fetch(SESSION_LOGIN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "login", username, password }),
  });
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.error || !data.token || !data.user?.id) {
    throw new Error(`[e2e] session-login failed for ${role}: ${data.error || res.status}`);
  }
  const state = {
    cookies: [],
    origins: [{
      origin,
      localStorage: [
        { name: "transitos_session_token", value: data.token },
        { name: "transitos_active_user_id", value: String(data.user.id) },
      ],
    }],
  };
  fs.writeFileSync(path.join(AUTH_DIR, `${role}.json`), JSON.stringify(state, null, 2));
  console.log(`[e2e] ${role}: authenticated as ${data.user.username} (role ${data.user.role}).`);
}

export default async function globalSetup() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const origin = process.env.E2E_BASE_URL || `http://localhost:${process.env.E2E_PORT || "4173"}`;
  const roles = [
    ["agent", process.env.E2E_AGENT_USERNAME, process.env.E2E_AGENT_PASSWORD],
    ["driver", process.env.E2E_DRIVER_USERNAME, process.env.E2E_DRIVER_PASSWORD],
  ];
  let any = false;
  for (const [role, u, p] of roles) {
    const stateFile = path.join(AUTH_DIR, `${role}.json`);
    if (!u || !p) { if (fs.existsSync(stateFile)) fs.rmSync(stateFile); continue; }
    await mint(role, u, p, origin);
    any = true;
  }
  if (!any) {
    console.warn("[e2e] No E2E_*_USERNAME/PASSWORD set — authenticated journeys will SKIP. Unauthenticated smoke still runs. See e2e/README.md.");
  }
}
