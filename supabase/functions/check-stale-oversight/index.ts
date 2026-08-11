// check-stale-oversight — Supabase Edge Function
//
// Server-side twin of the app's own TICKET/CHECK_STALE + TRIP/CHECK_
// STALE_DISPUTES sweeps, same reasoning as check-document-expiry/check-
// hours-compliance: the client-side versions only run while an admin has
// the app open (polled every 10 minutes from AdminApp), so this ran the
// risk of silently pausing overnight/weekends. Runs both checks in ONE
// function/cron job rather than two — per an explicit lesson from this
// project's own consolidation pass (see check-trip-timing): this app
// already had 5 separate 10-min pg_cron jobs each independently hitting
// the DB before that consolidation, and every new sweep from here on
// should default to joining an existing job's query rather than spinning
// up its own, unless there's a real reason it can't.
//
// Mirrors the app's own TICKET/CHECK_STALE / TRIP/CHECK_STALE_DISPUTES
// cases closely — same 24h-open / 24h-re-fire thresholds, same
// stalenotifiedat / dispute.stale_notified_at flags — but is a SEPARATE
// implementation against the raw database (lowercase column names), not
// by importing app code, same reasoning as every other edge function
// here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CRON_AUTH_TOKEN = Deno.env.get("CRON_AUTH_TOKEN") ?? "";

const STALE_MS = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  try {
    if (!CRON_AUTH_TOKEN || req.headers.get("Authorization") !== `Bearer ${CRON_AUTH_TOKEN}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const nowMs = Date.now();

    // Tickets and disputed trips are independent reads — FOUND VIA AUDIT:
    // these were awaited one after another; Promise.all cuts this run's
    // DB-wait time to roughly the slowest single query instead of the sum
    // of both, same pattern as weekly-ops-digest's own fix.
    const [
      { data: openTickets, error: ticketErr },
      { data: disputedTrips, error: disputeErr },
    ] = await Promise.all([
      supabase.from("tickets").select("*").eq("status", "OPEN"),
      supabase.from("trips").select("id, dispute")
        .not("dispute", "is", null)
        .or("dispute->>state.eq.OPEN,dispute->>state.eq.DRIVER_RESPONDED"),
    ]);
    if (ticketErr) throw ticketErr;
    if (disputeErr) throw disputeErr;

    // ── Stale tickets ──────────────────────────────────────────────────
    let ticketsFlagged = 0;
    for (const t of openTickets || []) {
      const age = nowMs - t.createdat;
      if (age < STALE_MS) continue;
      const lastNotified = t.stalenotifiedat || 0;
      if (nowMs - lastNotified < STALE_MS) continue;
      ticketsFlagged++;
      await supabase.from("tickets").update({ stalenotifiedat: nowMs }).eq("id", t.id);
      await supabase.from("notifications").insert([{
        title: "TICKET STALE", type: "TICKET_STALE", forroles: ["ADMIN"], userid: null,
        message: `🎫 Ticket ${t.id} (${t.category}) has been open ${Math.round(age / 3600000)}h with no resolution.`,
        tripid: t.tripid, timestamp: nowMs, isread: false,
      }]);
    }

    // ── Stale disputes ────────────────────────────────────────────────
    let disputesFlagged = 0;
    for (const t of disputedTrips || []) {
      const age = nowMs - t.dispute.filed_at;
      if (age < STALE_MS) continue;
      const lastNotified = t.dispute.stale_notified_at || 0;
      if (nowMs - lastNotified < STALE_MS) continue;
      disputesFlagged++;
      await supabase.from("trips").update({ dispute: { ...t.dispute, stale_notified_at: nowMs } }).eq("id", t.id);
      await supabase.from("notifications").insert([{
        title: "DISPUTE STALE", type: "DISPUTE_STALE", forroles: ["ADMIN"], userid: null,
        message: `⚠ Dispute on trip ${t.id} (${t.dispute.category}) has been unresolved for ${Math.round(age / 3600000)}h.`,
        tripid: t.id, timestamp: nowMs, isread: false,
      }]);
    }

    return new Response(JSON.stringify({
      ok: true, ticketsChecked: (openTickets || []).length, ticketsFlagged,
      disputesChecked: (disputedTrips || []).length, disputesFlagged,
    }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("check-stale-oversight failed:", e.message);
    return new Response(JSON.stringify({ ok: false, error: "Internal error — please try again." }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
