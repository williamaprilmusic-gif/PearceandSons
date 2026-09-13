// ai-dispatch-suggestion — Supabase Edge Function
//
// Smart dispatch suggestion, per explicit request — the second of three
// AI feature options originally scoped alongside ai-ops-assistant
// (2026-08-07) but not built until now. Given a specific unassigned trip
// and a short list of candidate drivers, asks Gemini for a plain-English
// recommendation to put next to the app's own numeric ranking.
//
// Deliberately NOT a second data-fetching assistant: unlike
// ai-ops-assistant (which pulls its own bounded DB snapshot), this
// function does no trip/driver lookups of its own at all. The client
// already computes the real ranking (scoreDriverForTrip — proximity,
// load, accept rate, prior declines on this exact agent) for the manual
// Dispatch screen; this endpoint is handed that SAME candidate list
// (capped, see below) and asked only to explain/summarize it in a
// sentence or two, plus flag anything worth a second look. It never
// invents a driver, a score, or a trip detail that wasn't in the payload
// it was given — same "answer only from provided data" principle
// ai-ops-assistant uses, just with the client (not a DB query) as the
// source of that data.
//
// Gated to Fleet Ops/Standard admins only, same as ai-ops-assistant (see
// that function's header comment for why Viewer/Financial are excluded).
// Shares that feature's per-user rate limit (ai_assistant_usage /
// check_and_record_ai_assistant_call) rather than a second table — a
// combined "don't hammer any AI feature" cooldown is proportionate here;
// this isn't a second, independently-tunable cost center.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const JWT_SECRET = Deno.env.get("PROJECT_JWT_SECRETS");
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
// Same alias as ai-ops-assistant, same reasoning — see that function's
// header comment on why a dated model id isn't used here.
const GEMINI_MODEL = "gemini-flash-latest";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

function base64urlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    b64url.length + (4 - (b64url.length % 4)) % 4, "="
  );
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

// Same implementation as ai-ops-assistant's verifySessionToken — kept
// duplicated, matching this project's established per-function
// self-contained convention (see check-late-start's header comment).
async function verifySessionToken(authHeader: string | null): Promise<number | null> {
  if (!authHeader?.startsWith("Bearer ") || !JWT_SECRET) return null;
  const token = authHeader.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encHeader, encPayload, encSig] = parts;
  try {
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC", key, base64urlToBytes(encSig), new TextEncoder().encode(`${encHeader}.${encPayload}`)
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(encPayload)));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload.app_user_id ?? null;
  } catch {
    return null;
  }
}

interface Candidate {
  name?: unknown;
  score?: unknown;
  dist_km?: unknown;
  load?: unknown;
  capacity?: unknown;
  accept_rate_pct?: unknown;
  prev_declined_this_agent?: unknown;
  vehicle?: unknown;
}

// Coerces one candidate entry into the exact shape sent to Gemini,
// dropping anything unexpected rather than passing the client's object
// through verbatim — keeps the prompt small and typed, and means a
// malformed/oversized field can't inflate token spend.
function sanitizeCandidate(c: unknown): Record<string, unknown> | null {
  if (!c || typeof c !== "object") return null;
  const r = c as Candidate;
  const name = typeof r.name === "string" ? r.name.slice(0, 80) : null;
  if (!name) return null;
  return {
    name,
    score: typeof r.score === "number" ? Math.round(r.score) : null,
    distance_km: typeof r.dist_km === "number" ? Math.round(r.dist_km * 10) / 10 : null,
    load: typeof r.load === "number" ? r.load : null,
    capacity: typeof r.capacity === "number" ? r.capacity : null,
    accept_rate_pct: typeof r.accept_rate_pct === "number" ? Math.round(r.accept_rate_pct) : null,
    previously_declined_this_agent: r.prev_declined_this_agent === true,
    vehicle: typeof r.vehicle === "string" ? r.vehicle.slice(0, 60) : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const callerId = await verifySessionToken(req.headers.get("authorization"));
    if (!callerId) return json({ ok: false, error: "Unauthorized — a valid session token is required" }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Role/tier check, re-verified server-side — see header comment.
    const { data: caller } = await supabase.from("users").select("role, adminlevel, fullname").eq("id", callerId).maybeSingle();
    if (!caller || caller.role !== "ADMIN" || !["FLEET_OPS", "STANDARD"].includes(caller.adminlevel)) {
      return json({ ok: false, error: "This feature is only available to Fleet Ops/Standard admins." }, 403);
    }

    // Shared per-user cooldown with ai-ops-assistant — see header comment
    // for why this reuses that RPC/table rather than a second one.
    const { data: rateLimitRows, error: rateLimitErr } = await supabase.rpc("check_and_record_ai_assistant_call", {
      p_user_id: callerId, p_now_ms: Date.now(), p_min_gap_ms: 3000,
    });
    if (rateLimitErr) {
      console.error("[ai-dispatch-suggestion] rate-limit check failed:", rateLimitErr.message);
      // Fail OPEN — same reasoning as ai-ops-assistant.
    } else if (rateLimitRows?.[0] && !rateLimitRows[0].allowed) {
      const retrySec = Math.ceil((rateLimitRows[0].retry_after_ms ?? 0) / 1000);
      return json({ ok: false, error: `Please wait ${retrySec}s before asking again.` }, 429);
    }

    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured — add it as an edge function secret.");

    const body = await req.json();
    const trip = body?.trip;
    const candidatesRaw = Array.isArray(body?.candidates) ? body.candidates : [];
    // Capped to 5 — the manual Dispatch screen's own ranked list is what
    // this is summarizing, not a fresh ranking of the whole fleet; the
    // client sends its own top few, not everyone.
    const candidates = candidatesRaw.map(sanitizeCandidate).filter(Boolean).slice(0, 5);
    if (candidates.length === 0) {
      return json({ ok: false, error: "No candidate drivers were provided." }, 400);
    }
    const tripSummary = {
      direction: typeof trip?.direction === "string" ? trip.direction.slice(0, 20) : null,
      scheduled_date: typeof trip?.scheduled_date === "string" ? trip.scheduled_date.slice(0, 20) : null,
      scheduled_time: typeof trip?.scheduled_time === "string" ? trip.scheduled_time.slice(0, 20) : null,
      pickup_area: typeof trip?.pickup_area === "string" ? trip.pickup_area.slice(0, 80) : null,
      agent_count: typeof trip?.agent_count === "number" ? trip.agent_count : null,
    };

    const geminiRes = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: `You are helping ${caller.fullname}, a dispatch admin at Pearce & Sons (a staff transport company in Cape Town, South Africa), pick a driver for a trip.

You are given the trip's details and a short list of CANDIDATE DRIVERS already ranked by the app's own scoring system (proximity to pickup, current seat load vs. capacity, historical accept rate, and whether they've previously declined a trip with this exact agent on it — "score" is 0-100, higher is better). Do not invent any driver, number, or fact that isn't in the data you're given, and do not re-rank or recompute anything — the ranking is already done. In 2-3 short sentences: confirm or gently question the top-ranked candidate, and call out anything worth a second look (e.g. a low accept rate, a driver near full capacity, or one who previously declined this same agent). If the list looks fine as ranked, say so briefly — don't manufacture a concern that isn't there.` }],
        },
        contents: [
          { role: "user", parts: [{ text: `TRIP:\n${JSON.stringify(tripSummary)}\n\nRANKED CANDIDATES (best first):\n${JSON.stringify(candidates)}` }] },
        ],
        generationConfig: { maxOutputTokens: 300 },
      }),
      signal: AbortSignal.timeout(25000),
    });
    if (!geminiRes.ok) {
      const errBody = await geminiRes.text();
      throw new Error(`Gemini API error (${geminiRes.status}): ${errBody.slice(0, 500)}`);
    }
    const geminiData = await geminiRes.json();

    const blockReason = geminiData?.promptFeedback?.blockReason;
    const candidate = geminiData?.candidates?.[0];
    if (blockReason || (candidate && candidate.finishReason && candidate.finishReason !== "STOP" && candidate.finishReason !== "MAX_TOKENS")) {
      return json({ ok: false, error: "The assistant declined to answer that one." });
    }
    const recommendation = (candidate?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
    return json({ ok: true, recommendation });
  } catch (e) {
    console.error("[ai-dispatch-suggestion]", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "Internal error — please try again." }, 500);
  }
});
