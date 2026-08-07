/**
 * Session-issuing Edge Function for Pearce & Sons.
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

// Matches the client's makeSalt() exactly (App.jsx) — 16 random bytes, hex.
function makeSalt(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
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

// Brute-force protection — found missing entirely via a dedicated security
// audit. A single-round SHA-256 password compare (hashPasswordServer
// above) is cheap to run at scale, and this endpoint had no attempt
// counting, lockout, or backoff of any kind: unlimited password guesses
// against any known/guessed username. Tracked uniformly whether or not
// the identifier resolves to a real account (see the login_attempts
// migration's comment) so the lockout itself can never become a new
// username-enumeration side channel — a bogus username locks out on the
// exact same schedule as a real one.
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
async function checkAndTrackAttempt(supabase: ReturnType<typeof db>, key: string): Promise<{ locked: boolean; retryAfterMs?: number }> {
  const { data: row } = await supabase.from('login_attempts').select('fail_count, locked_until').eq('attempt_key', key).maybeSingle();
  const now = Date.now();
  if (row?.locked_until && row.locked_until > now) {
    return { locked: true, retryAfterMs: row.locked_until - now };
  }
  return { locked: false };
}
async function recordFailure(supabase: ReturnType<typeof db>, key: string): Promise<void> {
  const now = Date.now();
  const { data: row } = await supabase.from('login_attempts').select('fail_count, locked_until').eq('attempt_key', key).maybeSingle();
  // By the time this runs, checkAndTrackAttempt (called first, above) has
  // already confirmed any existing lockout has expired or never existed —
  // so any prior fail_count here is from an already-ended window, safe to
  // just increment rather than needing to re-derive whether it's "still
  // live."
  const newCount = (row?.fail_count || 0) + 1;
  const lockedUntil = newCount >= MAX_FAILS ? now + LOCKOUT_MS : null;
  await supabase.from('login_attempts').upsert({ attempt_key: key, fail_count: newCount, locked_until: lockedUntil, updated_at: now }, { onConflict: 'attempt_key' });
}
async function clearAttempts(supabase: ReturnType<typeof db>, key: string): Promise<void> {
  await supabase.from('login_attempts').delete().eq('attempt_key', key);
}

async function login(username: string, password: string) {
  if (!username || !password) return err('Username and password are required');
  const supabase = db();
  const attemptKey = `login:${username}`;
  const attemptStatus = await checkAndTrackAttempt(supabase, attemptKey);
  if (attemptStatus.locked) {
    return err(`Too many failed attempts. Try again in ${Math.ceil((attemptStatus.retryAfterMs || 0) / 60000)} minute(s).`, 429);
  }
  const { data: user } = await supabase.from('users')
    .select('id, username, fullname, role, adminlevel, status, passwordhash, passwordsalt')
    .eq('username', username).maybeSingle();
  if (!user) { await recordFailure(supabase, attemptKey); return err('Invalid credentials'); }
  // Same verification the client's AUTH/LOGIN used to do (salted-hash
  // compare, with legacy-plaintext fallback for not-yet-upgraded accounts)
  // — now done here EXCLUSIVELY. Per a 2026-08-07 security audit: the
  // client-side version required selecting passwordhash/passwordsalt
  // through the public anon key, and since those columns had anon SELECT
  // granted with no RLS restricting rows, anyone holding the (necessarily
  // public) anon key could read any/every account's hash directly via
  // PostgREST, without ever needing to log in. This service-role client
  // bypasses grants/RLS entirely, so it's the only place that still needs
  // — or is still able — to read these two columns; a DB migration
  // (revoke_anon_select_on_password_columns_v2, Supabase migration
  // history) revoked anon/authenticated SELECT on them outright.
  let valid: boolean;
  if (user.passwordsalt) {
    valid = (await hashPasswordServer(password, user.passwordsalt)) === user.passwordhash;
  } else {
    valid = user.passwordhash === password;
  }
  if (!valid) { await recordFailure(supabase, attemptKey); return err('Invalid credentials'); }
  // Reaching here required the correct password — clear any accumulated
  // failure count regardless of whether the account turns out to be
  // active, since the credential itself has now been proven correct and
  // this was never actually a guessing attempt.
  await clearAttempts(supabase, attemptKey);
  if (user.status !== 'ACTIVE') return err('Account is not active');
  // Lazy upgrade — moved here from the client's AUTH/LOGIN action (which
  // no longer has any path that reads/writes these columns at all). Same
  // best-effort semantics: a failed upgrade never blocks the login itself,
  // the account just stays plaintext until next time.
  if (!user.passwordsalt) {
    try {
      const upSalt = makeSalt();
      const upHash = await hashPasswordServer(password, upSalt);
      await supabase.from('users').update({ passwordsalt: upSalt, passwordhash: upHash }).eq('id', user.id);
    } catch (e) {
      console.warn('[session-login] lazy hash upgrade failed (login still ok):', e instanceof Error ? e.message : String(e));
    }
  }
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
