/**
 * Session-issuing Edge Function for Pearce & Sons TransitOS.
 *
 * STAGE 1 of the auth/RLS migration (see project memory for full plan):
 * mints a real, Postgres-verifiable session token after independently
 * re-checking the account's password server-side. Does NOT yet change any
 * RLS policy — issuing a token the app doesn't use for anything yet is
 * intentionally a no-risk, additive step. The cutover (replacing the
 * "allow all" RLS policies with real per-table rules keyed off this
 * token's claims) is a deliberately separate, later step that needs its
 * own careful rollout and explicit sign-off.
 *
 * POST /session-login { username, password }
 * → { token, expires_in, user: { id, username, fullname, role, adminlevel, status } }
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// NOTE: cannot be named with a SUPABASE_ prefix — Supabase reserves that
// prefix for its own auto-injected platform variables and silently
// rejects/ignores user-defined secrets that use it. This is the actual
// project JWT secret (from Project Settings -> API -> JWT Settings), just
// stored under a non-reserved name.
const JWT_SECRET = Deno.env.get('PROJECT_JWT_SECRETS')!;
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h — matches this app's existing session-timeout expectations

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });
const err = (msg: string, status = 400) => json({ error: msg }, status);

const db = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Matches the client's hashPassword() exactly (App.jsx) — SHA-256 of
// salt+password, hex-encoded.
async function hashPasswordServer(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Self-contained HS256 JWT signer — no external JWT library. Signs with the
// project's real JWT secret so PostgREST's own JWT verification (used by
// every RLS policy that reads auth.jwt()/auth.uid()) accepts this token
// exactly like a GoTrue-issued one, once RLS policies are added to check it
// (that's the separate, later cutover step — see the header comment).
async function signSessionJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

async function login(username: string, password: string) {
  if (!username || !password) return err('Username and password are required');
  const supabase = db();
  const { data: user } = await supabase.from('users')
    .select('id, username, fullname, role, adminlevel, status, passwordhash, passwordsalt')
    .eq('username', username).maybeSingle();
  if (!user) return err('Invalid credentials');
  // Same verification as the client's AUTH/LOGIN (salted-hash compare, with
  // legacy-plaintext fallback for not-yet-upgraded accounts) — this function
  // does NOT perform the lazy hash-upgrade write; that stays exclusively in
  // the client's AUTH/LOGIN action so there's only one place that mutates
  // passwordhash/passwordsalt.
  let valid: boolean;
  if (user.passwordsalt) {
    valid = (await hashPasswordServer(password, user.passwordsalt)) === user.passwordhash;
  } else {
    valid = user.passwordhash === password;
  }
  if (!valid) return err('Invalid credentials');
  if (user.status !== 'ACTIVE') return err('Account is not active');
  return json(await issueSession(user));
}

// Shared by login() above and by a future biometric-login caller — kept as
// one function so both paths mint tokens with identical claims.
async function issueSession(user: { id: number; username: string; fullname: string; role: string; adminlevel: string | null; status: string }) {
  const nowSec = Math.floor(Date.now() / 1000);
  const token = await signSessionJwt({
    aud: 'authenticated',
    role: 'authenticated',
    sub: String(user.id),
    app_user_id: user.id,
    app_role: user.role,
    iat: nowSec,
    exp: nowSec + SESSION_TTL_SECONDS,
  });
  return {
    token,
    expires_in: SESSION_TTL_SECONDS,
    user: { id: user.id, username: user.username, fullname: user.fullname, role: user.role, adminlevel: user.adminlevel, status: user.status },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return err('Method not allowed', 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return err('Invalid JSON body'); }
  try {
    switch (body.action as string) {
      case 'login':
        return await login(body.username as string, body.password as string);
      default:
        return err(`Unknown action: ${body.action}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[session-login]', body.action, msg);
    return err('Internal error: ' + msg, 500);
  }
});
