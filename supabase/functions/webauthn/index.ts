/**
 * WebAuthn Edge Function for Pearce & Sons
 * POST /webauthn { action: 'registration-options' | 'register' | 'authentication-options' | 'authenticate' | 'has-credential', ... }
 */
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RP_ID = Deno.env.get('WEBAUTHN_RP_ID') ?? 'pearceand-sons.vercel.app';
const RP_NAME = 'Pearce & Sons Transport';
const ORIGIN = Deno.env.get('WEBAUTHN_ORIGIN') ?? 'https://pearceand-sons.vercel.app';
// NOTE: cannot be named with a SUPABASE_ prefix — Supabase reserves that
// prefix for its own auto-injected platform variables. Same secret used by
// supabase/functions/session-login for password-based logins — see that
// function's header comment for the full auth/RLS migration plan.
const JWT_SECRET = Deno.env.get('PROJECT_JWT_SECRETS')!;
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: cors });
const err = (msg: string, status = 400) => json({ error: msg }, status);

// ── Base64url helpers ──────────────────────────────────────────────────────
function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return btoa(String.fromCharCode(...u8))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64ToBuf(b64: string): Uint8Array {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
    b64.length + (4 - b64.length % 4) % 4, '='
  );
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function randomChallenge(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bufToB64(buf);
}

// ── CBOR COSE key parser ─────────────────────────────────────────────────
// Extracts the raw EC P-256 public key (x, y coordinates) from the
// CBOR-encoded COSE_Key structure in authenticatorData.
//
// CBOR encoding of negative integers (COSE negative key labels):
//   Major type 1 = 0x20. Value -N is encoded as 0x20 | (N-1).
//   So: -1 = 0x20, -2 = 0x21, -3 = 0x22
//   Decoded value = -(additional_info + 1) = -((byte & 0x1f) + 1)
//
// COSE_Key labels used here:
//   1  (kty)  = 2 (EC2)
//   3  (alg)  = -7 (ES256)
//   -1 (crv)  = 1 (P-256)
//   -2 (x)    = 32-byte x coordinate
//   -3 (y)    = 32-byte y coordinate
function extractPublicKey(authData: Uint8Array): { x: Uint8Array; y: Uint8Array } | null {
  // authData layout:
  //   [0..31]  rpIdHash (32 bytes)
  //   [32]     flags (1 byte) — bit 6 (0x40) = AT flag (attested credential data present)
  //   [33..36] signCount (4 bytes, big-endian)
  //   [37..52] AAGUID (16 bytes)
  //   [53..54] credIdLen (2 bytes, big-endian)
  //   [55..55+credIdLen-1] credentialId
  //   [55+credIdLen..]    COSE_Key (CBOR map)
  if (authData.length < 55) return null;
  const flags = authData[32];
  if (!(flags & 0x40)) return null; // no attested credential data

  const credIdLen = (authData[53] << 8) | authData[54];
  const coseStart = 55 + credIdLen;
  if (coseStart >= authData.length) return null;

  const coseKey = authData.slice(coseStart);

  // Parse the CBOR map — we only need x(-2) and y(-3) byte strings.
  // Skip the map header byte (first byte encodes map length).
  let i = 1;
  let x: Uint8Array | null = null;
  let y: Uint8Array | null = null;

  while (i < coseKey.length - 2 && !(x && y)) {
    // Read the key
    const keyByte = coseKey[i]; i++;
    let key: number;
    const majorType = keyByte >> 5;
    const addInfo   = keyByte & 0x1f;

    if (majorType === 0) {
      // Positive integer
      if (addInfo <= 23) { key = addInfo; }
      else if (addInfo === 24) { key = coseKey[i]; i++; }
      else break; // unsupported
    } else if (majorType === 1) {
      // Negative integer: value = -(addInfo + 1)
      // FIXED: was using wrong formula `0x20 - keyByte` which produced off-by-one
      if (addInfo <= 23) { key = -(addInfo + 1); }
      else if (addInfo === 24) { key = -(coseKey[i] + 1); i++; }
      else break;
    } else {
      break; // not a COSE map key type we handle
    }

    // Read the value
    if (i >= coseKey.length) break;
    const valByte = coseKey[i]; i++;
    const valMajor = valByte >> 5;
    const valInfo  = valByte & 0x1f;

    if (valMajor === 2) {
      // Byte string — this is what x and y are
      let len: number;
      if (valInfo <= 23) {
        len = valInfo;
      } else if (valInfo === 24) {
        len = coseKey[i]; i++;
      } else if (valInfo === 25) {
        len = (coseKey[i] << 8) | coseKey[i + 1]; i += 2;
      } else {
        break;
      }
      const val = coseKey.slice(i, i + len); i += len;
      if (key === -2) x = val; // x coordinate
      if (key === -3) y = val; // y coordinate
    } else if (valMajor === 0) {
      // Positive integer value — skip (kty, crv etc.)
      if (valInfo <= 23) { /* inline, no extra bytes */ }
      else if (valInfo === 24) { i++; }
      else if (valInfo === 25) { i += 2; }
      else if (valInfo === 26) { i += 4; }
      else break;
    } else if (valMajor === 1) {
      // Negative integer value — skip (alg = -7)
      if (valInfo <= 23) { /* inline */ }
      else if (valInfo === 24) { i++; }
      else break;
    } else {
      break; // unexpected value type
    }
  }

  if (!x || !y) return null;
  return { x, y };
}

// ── Signature verification ─────────────────────────────────────────────────
// WebAuthn ES256 assertion signatures come from the authenticator as
// ASN.1 DER (SEQUENCE of two INTEGERs, r and s) — but WebCrypto's ECDSA
// verify requires the raw fixed-length r‖s ("IEEE P1363") concatenation,
// the same format crypto.subtle.sign produces. Without this conversion,
// every real assertion fails verify() and authenticate() can never
// succeed, no matter how correct the credential/challenge is.
function derSignatureToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('Invalid DER signature: missing SEQUENCE tag');
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f); // long-form length

  if (der[offset] !== 0x02) throw new Error('Invalid DER signature: missing INTEGER tag (r)');
  offset++;
  const rLen = der[offset]; offset++;
  let r = der.slice(offset, offset + rLen); offset += rLen;

  if (der[offset] !== 0x02) throw new Error('Invalid DER signature: missing INTEGER tag (s)');
  offset++;
  const sLen = der[offset]; offset++;
  let s = der.slice(offset, offset + sLen);

  const trimLeadingZeros = (b: Uint8Array) => {
    let i = 0;
    while (b.length - i > 32 && b[i] === 0) i++;
    return b.slice(i);
  };
  r = trimLeadingZeros(r);
  s = trimLeadingZeros(s);

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length); // left-pad to 32 bytes each
  raw.set(s, 64 - s.length);
  return raw;
}

async function verifySignature(
  publicKeyB64: string,
  authData: Uint8Array,
  clientDataJSON: Uint8Array,
  sig: Uint8Array,
): Promise<boolean> {
  try {
    const pubRaw = b64ToBuf(publicKeyB64);
    const cryptoKey = await crypto.subtle.importKey(
      'raw', pubRaw,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    );
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', clientDataJSON)
    );
    const verifyData = new Uint8Array(authData.length + clientDataHash.length);
    verifyData.set(authData);
    verifyData.set(clientDataHash, authData.length);
    const rawSig = derSignatureToRaw(sig);
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey, rawSig, verifyData
    );
  } catch {
    return false;
  }
}

// ── Supabase client (service role — bypasses RLS) ──────────────────────────
const db = () => createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Self-contained HS256 JWT signer, same shape as session-login's — a
// biometric login is just as strong a proof of identity as a password
// login, so it mints the exact same kind of session token. Reuses this
// file's existing bufToB64() (already base64url, already handles
// Uint8Array) rather than a separate copy.
async function signSessionJwt(payload: Record<string, unknown>): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encHeader = bufToB64(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = bufToB64(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${bufToB64(new Uint8Array(sig))}`;
}

async function issueSessionToken(user: { id: number; role: string }): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return signSessionJwt({
    aud: 'authenticated', role: 'authenticated', sub: String(user.id),
    app_user_id: user.id, app_role: user.role,
    iat: nowSec, exp: nowSec + SESSION_TTL_SECONDS,
  });
}

// Matches the client's hashPassword() exactly (App.jsx) — SHA-256 of
// salt+password, hex-encoded. Deno's WebCrypto is the same API as the
// browser's, so this is a direct port, not a reimplementation.
async function hashPasswordServer(password: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
// Constant-time comparison — see session-login's identical helper for the
// full rationale (found via the same dedicated security audit).
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// CRITICAL — this is the fix for a confirmed account-takeover vulnerability:
// registrationOptions()/register() used to accept a client-supplied user_id
// with NO check that the caller actually is that user. Anyone who knew (or
// guessed — ids are small sequential integers) a victim's user_id and
// username could register their OWN fingerprint/security key against the
// victim's account and log in as them, including as an admin, without ever
// knowing the password. Every action that touches webauthn_credentials for
// a given userId must now re-verify that account's current password first —
// this is the only credential this app can check server-side that proves
// the caller is who they claim, since there is no separate session/JWT
// layer in front of this function (verify_jwt is deliberately off here, see
// deploy config). Mirrors handleSupabaseAction's AUTH/LOGIN verification
// (salted-hash compare, with legacy-plaintext fallback for not-yet-upgraded
// accounts) so behavior matches ordinary password login exactly.
// Brute-force protection — same login_attempts table/threshold as
// session-login (see that function's own comment for the full rationale;
// found missing here via the same dedicated security audit). Keyed by
// "webauthn:<userId>" rather than a username, since this endpoint already
// has a concrete numeric user_id at the point verifyPassword runs — a
// distinct key namespace from session-login's "login:<username>" so the
// two never collide or share a counter for what's really two separate
// guessing surfaces against the same account.
const MAX_FAILS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
async function verifyPassword(supabase: ReturnType<typeof createClient>, userId: number, password: string): Promise<boolean | 'locked'> {
  if (!password) return false;
  const attemptKey = `webauthn:${userId}`;
  const now = Date.now();
  const { data: attemptRow } = await supabase.from('login_attempts')
    .select('fail_count, locked_until').eq('attempt_key', attemptKey).maybeSingle();
  if (attemptRow?.locked_until && attemptRow.locked_until > now) return 'locked';

  const { data: user } = await supabase.from('users')
    .select('passwordhash, passwordsalt, status').eq('id', userId).maybeSingle();
  const valid = !!user && user.status === 'ACTIVE' && (
    user.passwordsalt
      ? timingSafeEqualHex(await hashPasswordServer(password, user.passwordsalt), user.passwordhash)
      // Legacy plaintext path — both sides hashed first purely to
      // normalize length before the constant-time compare.
      : timingSafeEqualHex(await sha256Hex(password), await sha256Hex(user.passwordhash))
  );
  if (valid) {
    await supabase.from('login_attempts').delete().eq('attempt_key', attemptKey);
    return true;
  }
  // Tracked even for a userId that doesn't resolve to a real/active
  // account — same "no new enumeration side channel" reasoning as
  // session-login. Atomic increment via RPC — see session-login's
  // recordFailure for the TOCTOU race this fixes (same shared DB function).
  const { error: incErr } = await supabase.rpc('increment_login_fail_count', {
    p_attempt_key: attemptKey, p_max_fails: MAX_FAILS, p_lockout_ms: LOCKOUT_MS, p_now_ms: now,
  });
  if (incErr) console.error('[webauthn] increment_login_fail_count failed:', incErr.message);
  return false;
}

// ── Action handlers ────────────────────────────────────────────────────────
async function registrationOptions(userId: number, username: string, password: string) {
  const supabase = db();
  const pwCheck = await verifyPassword(supabase, userId, password);
  if (pwCheck === 'locked') return err('Too many failed attempts. Please try again later.', 429);
  if (!pwCheck) return err('Incorrect password', 401);
  const challenge = randomChallenge();
  await supabase.from('webauthn_challenges')
    .delete().eq('user_id', userId).eq('type', 'registration');
  const { error } = await supabase.from('webauthn_challenges').insert({
    user_id: userId, challenge, type: 'registration',
  });
  if (error) return err('Failed to store challenge: ' + error.message);
  const { data: existing } = await supabase.from('webauthn_credentials')
    .select('credential_id_b64').eq('app_user_id', userId);
  const excludeCredentials = (existing || []).map((c: { credential_id_b64: string }) => ({
    id: c.credential_id_b64, type: 'public-key', transports: ['internal', 'hybrid'],
  }));
  return json({
    challenge,
    rp: { id: RP_ID, name: RP_NAME },
    user: {
      id: bufToB64(new TextEncoder().encode(String(userId))),
      name: username, displayName: username,
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
    timeout: 60000,
    attestation: 'none',
    excludeCredentials,
  });
}

async function register(userId: number, credential: {
  id: string;
  response: { clientDataJSON: string; attestationObject: string };
  friendlyName?: string;
}, password: string) {
  const supabase = db();
  // Re-verify password here too, independently of registrationOptions — see
  // the CRITICAL comment above verifyPassword. This endpoint is reachable
  // directly (a caller isn't required to have gone through
  // registration-options first), so it must not rely on that earlier call
  // having checked anything.
  const pwCheck = await verifyPassword(supabase, userId, password);
  if (pwCheck === 'locked') return err('Too many failed attempts. Please try again later.', 429);
  if (!pwCheck) return err('Incorrect password', 401);
  // Fetch and validate challenge
  const { data: challengeRow } = await supabase
    .from('webauthn_challenges').select('*')
    .eq('user_id', userId).eq('type', 'registration')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!challengeRow) return err('Challenge not found or expired — please try again');

  // Parse and verify clientDataJSON
  const clientDataJSON = b64ToBuf(credential.response.clientDataJSON);
  let clientData: { type: string; challenge: string; origin: string };
  try { clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)); }
  catch { return err('Invalid clientDataJSON'); }
  if (clientData.type !== 'webauthn.create') return err('Wrong ceremony type');
  if (clientData.challenge !== challengeRow.challenge) return err('Challenge mismatch');
  if (clientData.origin !== ORIGIN) return err(`Origin mismatch: got ${clientData.origin}`);

  // Parse attestationObject (minimal CBOR) to get authData
  const attObj = b64ToBuf(credential.response.attestationObject);
  const authData = extractAuthData(attObj);
  if (!authData) return err('Cannot parse attestationObject');

  // Verify rpIdHash
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID))
  );
  if (!expectedRpIdHash.every((b, i) => b === authData[i]))
    return err('RP ID hash mismatch');

  // Check flags
  const flags = authData[32];
  if (!(flags & 0x01)) return err('User presence not verified');
  if (!(flags & 0x04)) return err('User verification required — please use biometric');

  // Extract public key
  const pubKeyCoords = extractPublicKey(authData);
  if (!pubKeyCoords) return err('Cannot extract public key from authData — unsupported authenticator format');

  // Build raw 65-byte uncompressed EC point: 0x04 || x || y
  const rawPub = new Uint8Array(65);
  rawPub[0] = 0x04;
  rawPub.set(pubKeyCoords.x, 1);
  rawPub.set(pubKeyCoords.y, 33);
  const publicKeyB64 = bufToB64(rawPub);

  // Store credential
  const { error: insErr } = await supabase.from('webauthn_credentials').insert({
    app_user_id: userId,
    credential_id_b64: credential.id,
    public_key_b64: publicKeyB64,
    sign_count: 0,
    transports: ['internal'],
    friendly_name: credential.friendlyName ?? 'My Device',
  });
  if (insErr) {
    if (insErr.code === '23505') return err('This device is already registered');
    return err('Failed to save credential: ' + insErr.message);
  }
  await supabase.from('webauthn_challenges').delete().eq('id', challengeRow.id);
  return json({ success: true });
}

// Extract authData byte array from CBOR-encoded attestationObject.
// Looks for the CBOR text key "authData" then reads the following byte string.
function extractAuthData(attObj: Uint8Array): Uint8Array | null {
  // "authData" in CBOR: text string of length 8 = 0x68 followed by UTF-8 bytes
  const authDataKey = new TextEncoder().encode('authData');
  const keyHeader = new Uint8Array([0x60 | authDataKey.length, ...authDataKey]);
  for (let i = 0; i < attObj.length - keyHeader.length; i++) {
    if (!keyHeader.every((b, j) => attObj[i + j] === b)) continue;
    // Found the key — read the byte string value that follows
    let pos = i + keyHeader.length;
    if (pos >= attObj.length) break;
    const vByte = attObj[pos]; pos++;
    const vMajor = vByte >> 5;
    const vInfo  = vByte & 0x1f;
    if (vMajor !== 2) continue; // expect byte string
    let len: number;
    if (vInfo <= 23) { len = vInfo; }
    else if (vInfo === 24) { len = attObj[pos]; pos++; }
    else if (vInfo === 25) { len = (attObj[pos] << 8) | attObj[pos + 1]; pos += 2; }
    else if (vInfo === 26) {
      len = (attObj[pos] << 24) | (attObj[pos+1] << 16) | (attObj[pos+2] << 8) | attObj[pos+3];
      pos += 4;
    } else continue;
    return attObj.slice(pos, pos + len);
  }
  return null;
}

// Read-only check used by the login screen to decide whether to label the
// button "USE FINGERPRINT / FACE ID" vs "SIGN IN WITH BIOMETRICS" while the
// user is still typing their username. Deliberately does NOT touch
// webauthn_challenges — unlike authenticationOptions() below, which deletes
// and reissues the login challenge on every call. Polling that endpoint from
// a debounced effect could invalidate a challenge an in-flight fingerprint
// scan was about to submit, causing an intermittent "Challenge mismatch" /
// stale-challenge failure right after a successful scan.
async function hasCredential(username: string) {
  const supabase = db();
  const { data: user } = await supabase
    .from('users').select('id').eq('username', username).maybeSingle();
  if (!user) return json({ hasCredentials: false });
  const { data: creds } = await supabase
    .from('webauthn_credentials').select('credential_id_b64')
    .eq('app_user_id', user.id).limit(1);
  return json({ hasCredentials: !!creds?.length });
}

async function authenticationOptions(username: string) {
  const supabase = db();
  const { data: user } = await supabase
    .from('users').select('id').eq('username', username).maybeSingle();
  // Same response for "no such user" and "user has no credentials" —
  // returning a distinguishable error for the former lets a caller
  // enumerate valid usernames, which login() deliberately avoids.
  if (!user) return json({ hasCredentials: false });
  const { data: creds } = await supabase
    .from('webauthn_credentials').select('credential_id_b64, transports')
    .eq('app_user_id', user.id);
  if (!creds?.length) return json({ hasCredentials: false });
  const challenge = randomChallenge();
  await supabase.from('webauthn_challenges')
    .delete().eq('user_id', user.id).eq('type', 'authentication');
  await supabase.from('webauthn_challenges').insert({
    user_id: user.id, challenge, type: 'authentication',
  });
  return json({
    hasCredentials: true,
    challenge,
    rpId: RP_ID,
    timeout: 60000,
    userVerification: 'required',
    allowCredentials: creds.map((c: { credential_id_b64: string; transports: string[] }) => ({
      id: c.credential_id_b64, type: 'public-key',
      transports: c.transports ?? ['internal'],
    })),
  });
}

async function authenticate(username: string, credential: {
  id: string;
  response: { clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string };
}) {
  const supabase = db();
  const { data: user } = await supabase
    .from('users').select('id, username, fullname, role, adminlevel, scopedcompanyids, branchid, status')
    .eq('username', username).maybeSingle();
  if (!user) return err('User not found');
  const { data: cred } = await supabase
    .from('webauthn_credentials').select('*')
    .eq('app_user_id', user.id)
    .eq('credential_id_b64', credential.id).maybeSingle();
  if (!cred) return err('Credential not recognised on this account');
  if (user.status !== 'ACTIVE') return err('Account is not active');

  const { data: challengeRow } = await supabase
    .from('webauthn_challenges').select('*')
    .eq('user_id', user.id).eq('type', 'authentication')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!challengeRow) return err('Challenge expired — please try again');

  const clientDataJSON = b64ToBuf(credential.response.clientDataJSON);
  let clientData: { type: string; challenge: string; origin: string };
  try { clientData = JSON.parse(new TextDecoder().decode(clientDataJSON)); }
  catch { return err('Invalid clientDataJSON'); }
  if (clientData.type !== 'webauthn.get') return err('Wrong ceremony type');
  if (clientData.challenge !== challengeRow.challenge) return err('Challenge mismatch');
  if (clientData.origin !== ORIGIN) return err(`Origin mismatch: got ${clientData.origin}`);

  const authData = b64ToBuf(credential.response.authenticatorData);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(RP_ID))
  );
  if (!expectedRpIdHash.every((b, i) => b === authData[i]))
    return err('RP ID hash mismatch');
  const flags = authData[32];
  if (!(flags & 0x01)) return err('User presence not verified');
  if (!(flags & 0x04)) return err('User verification required');

  const sig = b64ToBuf(credential.response.signature);
  const valid = await verifySignature(cred.public_key_b64, authData, clientDataJSON, sig);
  if (!valid) return err('Signature verification failed');

  // Sign count replay attack prevention
  const signCount = (authData[33] << 24) | (authData[34] << 16) | (authData[35] << 8) | authData[36];
  if (signCount !== 0 && signCount <= cred.sign_count)
    return err('Sign count indicates a cloned authenticator — authentication rejected');

  await supabase.from('webauthn_credentials')
    .update({ sign_count: signCount, last_used_at: new Date().toISOString() })
    .eq('id', cred.id);
  await supabase.from('users').update({ isonline: true }).eq('id', user.id);
  if (user.role === 'DRIVER')
    await supabase.from('driver_status').update({ isonline: true }).eq('driverid', user.id);
  await supabase.from('webauthn_challenges').delete().eq('id', challengeRow.id);
  const sessionToken = await issueSessionToken(user);
  return json({ success: true, userId: user.id, sessionToken });
}

// ── Router ─────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return err('Method not allowed', 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return err('Invalid JSON body'); }
  try {
    switch (body.action as string) {
      case 'registration-options':
        return await registrationOptions(body.user_id as number, body.username as string, body.password as string);
      case 'register':
        return await register(body.user_id as number, body.credential as Parameters<typeof register>[1], body.password as string);
      case 'has-credential':
        return await hasCredential(body.username as string);
      case 'authentication-options':
        return await authenticationOptions(body.username as string);
      case 'authenticate':
        return await authenticate(body.username as string, body.credential as Parameters<typeof authenticate>[1]);
      default:
        return err(`Unknown action: ${body.action}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[webauthn]', body.action, msg);
    // Generic message to the client — reachable unauthenticated for
    // several actions here, real exception detail must stay server-side.
    return err('Internal error — please try again.', 500);
  }
});
