// ai-ops-assistant — Supabase Edge Function
//
// AI-powered admin operations assistant, per explicit request ("implement
// AI into this app"). Answers natural-language questions about live
// operational data (active trips, driver status, open tickets, recent
// vehicle maintenance) using Claude.
//
// Deliberately READ-ONLY by design, not a text-to-SQL assistant: the model
// never executes a query or writes anything. It's handed a bounded,
// pre-fetched JSON snapshot of the relevant tables and told to answer
// strictly from that. This closes off the two real risks a "let the LLM
// query the database" design would carry on this schema — prompt
// injection turning into an arbitrary SQL/data-access hole, and the model
// hallucinating a plausible-looking but wrong number — at the cost of the
// assistant only knowing what's in the snapshot (current active trips +
// today's operational state, not full history).
//
// Gated to Fleet Ops/Standard admins only (both ROLE.ADMIN, fleet-wide
// unrestricted per this app's existing company-scoping rules — see
// getAdminCompanyIds in the main app). Deliberately excludes: Viewer
// (company-scoped everywhere else in the app; this snapshot is NOT
// company-scoped, so answering a Viewer would leak cross-company data —
// scoping it properly is a real follow-up, not done in this first cut) and
// Financial (a money-focused, not ops-focused, tier — out of scope here).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.70.1?target=deno";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
// Same shared secret as session-login/webauthn/send-push-notification —
// cannot use a SUPABASE_ prefix, Supabase reserves that for its own
// auto-injected platform variables.
const JWT_SECRET = Deno.env.get("PROJECT_JWT_SECRETS");
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

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

// Verifies a token minted by session-login/webauthn (same HS256 scheme,
// same shared secret) — checks the signature AND expiry, not just that it
// parses as JSON. Same implementation as send-push-notification's own
// verifySessionToken (kept duplicated rather than shared, matching how the
// other edge functions in this project are each self-contained — see
// check-late-start's header comment on that convention).
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  try {
    const callerId = await verifySessionToken(req.headers.get("authorization"));
    if (!callerId) return json({ ok: false, error: "Unauthorized — a valid session token is required" }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Role/tier check — see header comment for why Viewer/Financial are
    // excluded. Rechecked server-side on every call, not trusted from the
    // client (matches this project's established pattern everywhere else).
    // Deliberately checked BEFORE the ANTHROPIC_API_KEY presence check
    // below, so an unauthorized caller always gets a clean 403 regardless
    // of whether the key happens to be configured yet.
    const { data: caller } = await supabase.from("users").select("role, adminlevel, fullname").eq("id", callerId).maybeSingle();
    if (!caller || caller.role !== "ADMIN" || !["FLEET_OPS", "STANDARD"].includes(caller.adminlevel)) {
      return json({ ok: false, error: "This assistant is only available to Fleet Ops/Standard admins." }, 403);
    }
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not configured — add it as an edge function secret.");

    const { question, history } = await req.json();
    if (!question || typeof question !== "string" || !question.trim()) {
      return json({ ok: false, error: "A question is required" }, 400);
    }
    if (question.length > 2000) return json({ ok: false, error: "Question is too long (max 2000 characters)" }, 400);
    // Optional prior turns, for a follow-up question — capped so one long
    // client-side conversation can't balloon token spend unbounded.
    const safeHistory: { role: string; content: string }[] = Array.isArray(history)
      ? history.filter((m: unknown): m is { role: string; content: string } =>
          !!m && typeof (m as { content?: unknown }).content === "string" &&
          ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant")
        ).slice(-6)
      : [];

    // ── Bounded, read-only operational snapshot ─────────────────────────
    // See header comment — the model only ever sees this, never runs SQL
    // itself. Scoped to ACTIVE trips only (not archived/history), open
    // tickets, and current driver/vehicle state — capped row counts so a
    // busy fleet day can't balloon the prompt size or cost.
    const nowMs = Date.now();
    const [tripsRes, driverStatusRes, ticketsRes, maintRes, usersRes] = await Promise.all([
      supabase.from("trips")
        .select("id, status, scheduleddate, scheduledtimestr, direction, agentid, extraagentids, driverid, latebookingflag, longdistanceflag, driverrouteexceedspolicy, noshows, dispute")
        .not("status", "in", "(ARCHIVED_COMPLETED,ARCHIVED_CANCELLED)")
        .order("scheduleddate", { ascending: true })
        .limit(150),
      supabase.from("driver_status").select("driverid, isonline, isaway, capacity, vehicle").limit(100),
      supabase.from("tickets").select("agentid, category, status, createdat").eq("status", "OPEN").order("createdat", { ascending: false }).limit(50),
      supabase.from("vehicle_maintenance_log").select("vehicleid, servicedate, servicetype").order("servicedate", { ascending: false }).limit(20),
      supabase.from("users").select("id, fullname").limit(300),
    ]);
    const userName = (id: unknown) => (usersRes.data || []).find((u: { id: unknown }) => String(u.id) === String(id))?.fullname || String(id ?? "");
    const sast = (ms: number | null | undefined) => ms ? new Date(ms).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }) : null;

    const snapshot = {
      generated_at_sast: sast(nowMs),
      active_trips: (tripsRes.data || []).map((t: Record<string, unknown>) => ({
        trip_id: t.id, status: t.status, date: t.scheduleddate, time: t.scheduledtimestr, direction: t.direction,
        agent: userName(t.agentid), extra_agents: ((t.extraagentids as unknown[]) || []).map(userName),
        driver: t.driverid ? userName(t.driverid) : null,
        late_booking: !!t.latebookingflag, long_distance: !!t.longdistanceflag, route_exceeds_policy: !!t.driverrouteexceedspolicy,
        no_shows: ((t.noshows as unknown[]) || []).length,
        has_open_dispute: !!(t.dispute && (t.dispute as { state?: string }).state === "OPEN"),
      })),
      drivers: (driverStatusRes.data || []).map((d: Record<string, unknown>) => ({
        name: userName(d.driverid), online: !!d.isonline, away: !!d.isaway, capacity: d.capacity, vehicle: d.vehicle || null,
      })),
      open_tickets: (ticketsRes.data || []).map((t: Record<string, unknown>) => ({
        agent: userName(t.agentid), category: t.category, opened: sast(t.createdat as number),
      })),
      recent_vehicle_maintenance: (maintRes.data || []).map((m: Record<string, unknown>) => ({
        vehicle_id: m.vehicleid, date: m.servicedate, type: m.servicetype,
      })),
    };

    const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 1024,
      output_config: { effort: "medium" },
      system: `You are the internal operations assistant for Pearce & Sons, a staff transport dispatch company in Cape Town, South Africa. You are answering ${caller.fullname}, a Fleet Ops/Standard admin.

Answer ONLY using the JSON data snapshot in the user's message — never invent trips, drivers, tickets, or numbers that aren't in it. If the snapshot doesn't contain what's needed to answer, say so plainly instead of guessing. Times are SAST (UTC+2). Currency is South African Rand (R) where relevant. Keep answers concise — a sentence or short paragraph, not a report. The snapshot covers only ACTIVE (not yet completed/cancelled) trips, currently OPEN tickets, and current driver/vehicle state — it has no historical/archived data.`,
      messages: [
        ...safeHistory.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user", content: `DATA SNAPSHOT:\n${JSON.stringify(snapshot)}\n\nQUESTION: ${question}` },
      ],
    });

    // Claude Opus 5 runs elevated cybersecurity safeguards and can decline
    // a request with a normal 200 + stop_reason: "refusal" rather than an
    // error — must be checked before reading response.content.
    if (response.stop_reason === "refusal") {
      return json({ ok: false, error: "The assistant declined to answer that question." });
    }
    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return json({ ok: true, answer: textBlock?.text || "" });
  } catch (e) {
    console.error("[ai-ops-assistant]", e instanceof Error ? e.message : String(e));
    return json({ ok: false, error: "Internal error: " + (e instanceof Error ? e.message : String(e)) }, 500);
  }
});
