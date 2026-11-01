// agent-trip-eta — Supabase Edge Function (agent-invoked, on demand)
//
// The cold-start companion to the client's useAgentShuttleStatus hook.
// That hook shows "your shuttle is ~N mins away" from the driver's live
// position broadcast, and (since the offline-ETA change) retains the last
// broadcast value when the stream stops. But if the driver's app was
// ALREADY closed before the agent opened their trip screen, no broadcast
// ever arrives this session, so the hook has nothing to show — and agents
// cannot read driver_positions directly (RLS scopes that table to admins
// and the driver themselves, by design: agents must never pull raw
// coordinates).
//
// This endpoint closes that gap WITHOUT exposing any coordinate. It runs
// with the service role, resolves the REQUESTING agent's own pickup point
// server-side from the trip (so an agent can never probe the driver's
// distance from an arbitrary point — which would let them trilaterate the
// driver's location), computes the same haversine × ROAD_FACTOR ÷ speed
// ETA the client and check-pickup-eta use, and returns ONLY
// { etaMin, distanceKm, updatedAt } — never lat/lng.
//
// POST { trip_id }  (Authorization: Bearer <app session JWT from session-login>)
// → 200 { available: true, etaMin, distanceKm, updatedAt }        last-known ETA
//   200 { available: true, tooStale: true, updatedAt }            fix too old to be useful
//   200 { available: false, reason }                              nothing to show (see reasons)
//   401 unauthorized · 400 bad request
//
// SCOPE: resolves the PICKUP ETA for an agent not yet picked up — the
// high-value cold-start case (an agent waiting for a ride who opens the
// app). A boarded agent is physically with the driver (and a closed driver
// app means no fresh GPS anyway), so for them it returns
// { available:false, reason:"boarded" } and the client keeps its live-only
// behaviour. The ref-point resolution deliberately mirrors the pickup half
// of agentTrackingRefPoint (TransitOS_web.jsx) and check-pickup-eta; keep
// them in sync.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// The project JWT secret session-login signs with (non-SUPABASE_ prefix
// because Supabase reserves that prefix for its own injected vars).
const JWT_SECRET = Deno.env.get("PROJECT_JWT_SECRETS")!;

const ROAD_FACTOR = 1.35;                    // straight-line → road, matches the app
const FALLBACK_SPEED_KMH = 25;               // when the position has no usable speed
const MAX_RETAINED_ETA_MS = 5 * 60 * 1000;   // a staler fix gives a bogus ETA — report tooStale

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Verify the HS256 app-JWT exactly as session-login signs it, against the
// same project secret, and return its claims. Throws on any failure.
async function verifyAppJwt(token: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, sig] = parts;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error("bad signature");
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
  if (payload.exp && Math.floor(Date.now() / 1000) > Number(payload.exp)) throw new Error("expired");
  if (payload.app_user_id == null) throw new Error("no app_user_id");
  return payload;
}

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // ── Auth: verify the caller's app session token, get their user id ──
  const auth = req.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  let agentId: string;
  try {
    const claims = await verifyAppJwt(token);
    agentId = String(claims.app_user_id);
  } catch (e) {
    // Log the reason (never the token): a PROJECT_JWT_SECRETS rotation mismatch,
    // or a missing secret, would otherwise 401 every caller with no server
    // signal as to why the whole feature went dark.
    console.warn("agent-trip-eta auth failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const tripId = body?.trip_id;
  if (tripId == null || tripId === "") return json({ error: "trip_id is required" }, 400);

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: trip, error: tripErr } = await supabase.from("trips")
      .select("id, status, driverid, agentid, extraagentids, completedpickups, noshows, pickuplat, pickuplng, extrapickups")
      .eq("id", tripId).maybeSingle();
    if (tripErr) throw tripErr;
    if (!trip) return json({ available: false, reason: "trip_not_found" });

    // Membership: the caller must be an agent ON this trip. This is the
    // ONLY gate that lets them learn anything about the driver's distance,
    // and it's always to the caller's OWN pickup point.
    const memberIds = new Set<string>([String(trip.agentid), ...((trip.extraagentids || []).map(String))]);
    if (!memberIds.has(agentId)) return json({ available: false, reason: "not_on_trip" });

    if (!trip.driverid || !["DRIVER_CONFIRMED", "IN_TRANSIT"].includes(String(trip.status))) {
      return json({ available: false, reason: "inactive" });
    }

    // Boarded (picked up and not a no-show) → physically with the driver;
    // no pickup ETA applies. Client keeps its live-only behaviour.
    const pickedUp = new Set((trip.completedpickups || []).map(String));
    const noShow = new Set((Array.isArray(trip.noshows) ? trip.noshows : []).map((n: { agent_id?: unknown }) => String(n?.agent_id)));
    if (pickedUp.has(agentId) && !noShow.has(agentId)) return json({ available: false, reason: "boarded" });

    // Resolve THIS agent's pickup coordinate (primary vs extra), mirroring
    // the hydration in TransitOS_web.jsx (pickuplat/lng for the primary
    // agent; extrapickups[{agent_id,lat,lng}] for the rest).
    let refLat: number | null = null, refLng: number | null = null;
    if (agentId === String(trip.agentid)) {
      refLat = trip.pickuplat; refLng = trip.pickuplng;
    } else {
      const ex = (Array.isArray(trip.extrapickups) ? trip.extrapickups : [])
        .find((e: { agent_id?: unknown }) => String(e?.agent_id) === agentId);
      if (ex) { refLat = ex.lat; refLng = ex.lng; }
    }
    if (refLat == null || refLng == null) return json({ available: false, reason: "no_pickup_point" });

    const { data: pos, error: posErr } = await supabase.from("driver_positions")
      .select("lat, lng, speed_kmh, updatedat").eq("driverid", trip.driverid).maybeSingle();
    if (posErr) throw posErr; // a real DB fault must 500 (+log) via the catch, not masquerade as "no_position"
    if (!pos || pos.lat == null || pos.lng == null) return json({ available: false, reason: "no_position" });

    const updatedAtMs = Date.parse(pos.updatedat);
    // Reject an unparseable (NaN) timestamp, and a future one (clock skew / bad
    // write): a future fix makes `Date.now() - updatedAtMs` negative, so it
    // could never read as stale and would yield a bogus "never ages" ETA.
    if (!Number.isFinite(updatedAtMs)) {
      console.warn("agent-trip-eta: unparseable driver_positions.updatedat:", pos.updatedat);
      return json({ available: false, reason: "no_position" });
    }
    const ageMs = Date.now() - updatedAtMs;
    if (ageMs < -60_000) {
      console.warn("agent-trip-eta: future driver_positions.updatedat (clock skew?):", pos.updatedat);
      return json({ available: false, reason: "no_position" });
    }
    // Past the retention horizon the frozen ETA is meaningless — tell the
    // client so it shows "live tracking paused" without a stale number.
    if (ageMs > MAX_RETAINED_ETA_MS) {
      return json({ available: true, tooStale: true, updatedAt: updatedAtMs });
    }

    const speed = pos.speed_kmh != null && pos.speed_kmh > 5 ? pos.speed_kmh : FALLBACK_SPEED_KMH;
    const distanceKm = haversineKm(pos.lat, pos.lng, refLat, refLng) * ROAD_FACTOR;
    const etaMin = Math.max(1, Math.round((distanceKm / speed) * 60));
    // Only derived values leave the function — never the driver's coords.
    return json({ available: true, etaMin, distanceKm, updatedAt: updatedAtMs });
  } catch (e) {
    console.error("agent-trip-eta failed:", e instanceof Error ? e.message : String(e));
    return json({ available: false, error: "Internal error — please try again." }, 500);
  }
});
