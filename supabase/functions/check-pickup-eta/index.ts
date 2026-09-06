// check-pickup-eta — Supabase Edge Function (pg_cron, every 3 min)
//
// "Your ride is about N minutes away." The app already fires this from
// the client (useAgentShuttleStatus), but only while the agent has the
// tracking screen open — so an agent who closed the app never hears the
// driver is close. This is the server-side backstop: it reaches every
// waiting agent with an in-app notification + a real push regardless of
// whether any client is running.
//
// For each active trip (DRIVER_CONFIRMED / IN_TRANSIT) it takes the
// driver's latest recorded position and, per not-yet-picked-up agent,
// estimates ETA to that agent's pickup point (haversine × ROAD_FACTOR
// ÷ speed) — same math as the client hook. Two thresholds, each fired
// at most once per (trip, agent): FIVE_MIN ("make your way over") and
// ARRIVE_MIN ("arriving now"). Dedupe lives in trips.pickup_eta_notified
// ({ "<agent_id>": { five, arrive } }).
//
// The client hook (useAgentShuttleStatus) fires the same in-app alerts
// in real time WHILE the agent's app session is alive. To avoid a double
// for an agent who's actively tracking, a threshold whose DRIVER_ETA
// notification already landed in the last RECENT_CLIENT_NOTIF_MS is
// skipped for THIS cron run and left un-marked, so it's re-evaluated
// later once that window clears — the server still covers the agent who
// has since closed the app, just a cycle behind.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const ROAD_FACTOR = 1.35;            // straight-line → road, matches the app
const FALLBACK_SPEED_KMH = 25;       // when the position has no usable speed
const FIVE_MIN = 5;
const ARRIVE_MIN = 2;
const MAX_POSITION_AGE_MS = 5 * 60 * 1000;   // a staler fix gives a bogus ETA — skip
const HORIZON_MS = 3 * 60 * 60 * 1000;       // don't alert for a DRIVER_CONFIRMED trip whose slot is >3h out
// If a DRIVER_ETA notif for this agent+trip already landed within this
// window, another one THIS cycle is a dup — skipped, but NOT persisted
// as done, so the next threshold ("arriving now" after "5 min away") is
// still re-evaluated on a later cron run once the window clears. Kept
// well under one 3-min cron cycle so a genuine next-threshold alert to
// an app-closed agent is at most ~1 cycle late, never lost.
const RECENT_CLIENT_NOTIF_MS = 2.5 * 60 * 1000;

function haversineKm(la1: number, lo1: number, la2: number, lo2: number): number {
  const R = 6371, toRad = (d: number) => (d * Math.PI) / 180;
  const dLa = toRad(la2 - la1), dLo = toRad(lo2 - lo1);
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(toRad(la1)) * Math.cos(toRad(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const nowMs = Date.now();

    const { data: trips, error } = await supabase.from("trips").select("*")
      .in("status", ["DRIVER_CONFIRMED", "IN_TRANSIT"])
      .not("driverid", "is", null);
    if (error) throw error;
    if (!trips || trips.length === 0) {
      return new Response(JSON.stringify({ ok: true, checked: 0, fired: 0 }), { headers: { "Content-Type": "application/json" } });
    }

    const driverIds = [...new Set(trips.map(t => t.driverid).filter(Boolean))];
    const { data: positions } = await supabase.from("driver_positions")
      .select("driverid, lat, lng, speed_kmh, updatedat").in("driverid", driverIds);
    const posByDriver: Record<string, { lat: number; lng: number; speed_kmh: number | null; ageMs: number }> = {};
    for (const p of positions || []) {
      const ageMs = nowMs - Date.parse(p.updatedat);
      posByDriver[String(p.driverid)] = { lat: p.lat, lng: p.lng, speed_kmh: p.speed_kmh, ageMs };
    }

    let fired = 0;
    for (const t of trips) {
      const pos = posByDriver[String(t.driverid)];
      if (!pos || pos.lat == null || pos.lng == null || pos.ageMs > MAX_POSITION_AGE_MS) continue;

      // DRIVER_CONFIRMED trips scheduled well in the future: the driver
      // isn't heading there yet, so a chance proximity shouldn't alert.
      if (t.status === "DRIVER_CONFIRMED" && t.scheduledtime != null && t.scheduledtime - nowMs > HORIZON_MS) continue;

      const speed = pos.speed_kmh != null && pos.speed_kmh > 5 ? pos.speed_kmh : FALLBACK_SPEED_KMH;
      const done = new Set((t.completedpickups || []).map(String));
      const extras: Array<{ lat?: number; lng?: number; agent_id?: number | string }> = Array.isArray(t.extrapickups) ? t.extrapickups : [];

      // one { agent_id, lat, lng } per agent still to be collected
      const targets: Array<{ agentId: string; lat: number; lng: number }> = [];
      if (t.agentid && !done.has(String(t.agentid)) && t.pickuplat != null && t.pickuplng != null) {
        targets.push({ agentId: String(t.agentid), lat: t.pickuplat, lng: t.pickuplng });
      }
      for (const ex of extras) {
        if (ex.agent_id == null || done.has(String(ex.agent_id)) || ex.lat == null || ex.lng == null) continue;
        targets.push({ agentId: String(ex.agent_id), lat: ex.lat, lng: ex.lng });
      }
      if (targets.length === 0) continue;

      const notified: Record<string, { five?: boolean; arrive?: boolean }> =
        (t.pickup_eta_notified && typeof t.pickup_eta_notified === "object") ? { ...t.pickup_eta_notified } : {};
      // Compute what WOULD fire (cheap, no query), then filter.
      const pending: Array<{ agentIdStr: string; agentId: number; message: string; mark: { five?: boolean; arrive?: boolean } }> = [];
      for (const tgt of targets) {
        const km = haversineKm(pos.lat, pos.lng, tgt.lat, tgt.lng) * ROAD_FACTOR;
        const etaMin = Math.max(1, Math.round((km / speed) * 60));
        const seen = notified[tgt.agentId] || {};
        if (etaMin <= ARRIVE_MIN && !seen.arrive) {
          pending.push({ agentIdStr: tgt.agentId, agentId: Number(tgt.agentId), message: "🚗 Your driver is ARRIVING NOW — please be at the pickup point.", mark: { ...seen, five: true, arrive: true } });
        } else if (etaMin <= FIVE_MIN && !seen.five) {
          pending.push({ agentIdStr: tgt.agentId, agentId: Number(tgt.agentId), message: `🚗 Your driver is about ${etaMin} minute${etaMin !== 1 ? "s" : ""} away — please make your way to the pickup point.`, mark: { ...seen, five: true } });
        }
      }
      if (pending.length === 0) continue;

      // Skip agents the client hook already alerted for this trip recently.
      const { data: recentNotifs } = await supabase.from("notifications")
        .select("userid").eq("type", "DRIVER_ETA").eq("tripid", t.id)
        .gte("timestamp", nowMs - RECENT_CLIENT_NOTIF_MS);
      const recentlyAlerted = new Set((recentNotifs || []).map(n => String(n.userid)));

      const alerts: Array<{ agentId: number; message: string }> = [];
      for (const p of pending) {
        // Skip (and DON'T persist the mark) when the client just alerted
        // this agent — a later cron cycle re-checks once the window
        // clears, so an app-closed agent still gets the next threshold.
        if (recentlyAlerted.has(p.agentIdStr)) continue;
        notified[p.agentIdStr] = p.mark;
        alerts.push({ agentId: p.agentId, message: p.message });
      }

      if (alerts.length === 0) continue;
      await supabase.from("trips").update({ pickup_eta_notified: notified }).eq("id", t.id);
      await supabase.from("notifications").insert(alerts.map(a => ({
        title: "DRIVER ETA", type: "DRIVER_ETA", forroles: ["AGENT"], userid: a.agentId,
        message: a.message, tripid: t.id, timestamp: nowMs, isread: false,
      })));
      // One push per agent — send-push-notification matches on
      // userid + message + ts, and agents on the same trip can be at
      // different thresholds (one "5 min away", one "arriving now").
      for (const a of alerts) {
        await fetch(`${SUPABASE_URL}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CRON_AUTH_TOKEN}` },
          body: JSON.stringify({ user_ids: [a.agentId], title: "DRIVER ETA", message: a.message, type: "DRIVER_ETA", trip_id: t.id, ts: nowMs }),
          signal: AbortSignal.timeout(15000),
        }).catch(e => console.warn("[check-pickup-eta] push failed:", e.message));
      }
      fired += alerts.length;
    }

    return new Response(JSON.stringify({ ok: true, checked: trips.length, fired }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("check-pickup-eta failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
