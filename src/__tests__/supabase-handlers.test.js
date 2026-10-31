// Live Supabase-handler tests (handleSupabaseAction) — the production code
// path for trip actions (the in-memory appReducer in business-logic.test.js
// is its offline/demo twin). These cover the same duplicate / replayed
// confirmation no-op guarantees proven for the reducer, but against the real
// handler, which talks to Supabase.
//
// HARNESS: `@supabase/supabase-js` is mocked so createClient returns an
// in-memory fake client — a tiny chainable query-builder backed by a plain
// object store. The module under test creates its `supabase` singleton from
// that mocked createClient (SUPABASE_URL/KEY are hardcoded constants, so the
// client is non-null in tests), and exports it, so each test seeds and reads
// supabase.__store.tables directly. global.fetch is stubbed so the geocode /
// web-push / TomTom calls these handlers make are hermetic no-ops (all of
// them already fall back to null on failure).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Factory is hoisted above the imports — it must define everything it needs
// inline (it cannot close over module-scope test vars).
vi.mock("@supabase/supabase-js", () => {
  class QB {
    constructor(store, table) {
      this.store = store; this.table = table; this.filters = []; this.op = null;
    }
    _rows() { return (this.store.tables[this.table] ||= []); }
    _match() { return this._rows().filter(r => this.filters.every(f => f(r))); }
    select() { if (!this.op) this.op = { type: "select" }; return this; }
    eq(c, v) { this.filters.push(r => String(r[c]) === String(v)); return this; }
    neq(c, v) { this.filters.push(r => String(r[c]) !== String(v)); return this; }
    is(c, v) { this.filters.push(r => (r[c] ?? null) === v); return this; }
    in(c, arr) { const s = new Set((arr || []).map(String)); this.filters.push(r => s.has(String(r[c]))); return this; }
    or() { return this; }
    order() { return this; }
    limit() { return this; }
    update(payload) { this.op = { type: "update", payload }; return this; }
    insert(payload) { this.op = { type: "insert", payload }; return this; }
    _exec() {
      if (!this.op || this.op.type === "select") return { data: this._match(), error: null };
      if (this.op.type === "update") {
        const matched = this._match();
        for (const r of matched) Object.assign(r, this.op.payload);
        return { data: matched.map(r => ({ ...r })), error: null };
      }
      // insert
      const rows = this._rows();
      const payload = Array.isArray(this.op.payload) ? this.op.payload : [this.op.payload];
      const inserted = payload.map((r, i) => ({ id: r.id ?? `gen-${this.table}-${rows.length + i + 1}`, ...r }));
      rows.push(...inserted);
      return { data: inserted, error: null };
    }
    single() { const r = this._exec(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error }); }
    maybeSingle() { return this.single(); }
    then(resolve, reject) { try { resolve(this._exec()); } catch (e) { reject && reject(e); } }
  }
  const makeFakeClient = () => {
    const store = { tables: {} };
    return {
      __store: store,
      from: (t) => new QB(store, t),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => ({ on() { return this; }, subscribe() { return this; }, unsubscribe() { return this; } }),
      removeChannel() {},
      realtime: { setAuth() {} },
      auth: {
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
        getSession: () => Promise.resolve({ data: { session: null } }),
        setSession() {}, signOut() {},
      },
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    };
  };
  return { createClient: () => makeFakeClient() };
});

import { supabase, handleSupabaseAction, TRIP_STATE } from "../TransitOS_web.jsx";

const ref = { current: "d1" };
const refetch = vi.fn();

const notifCount = (type) =>
  (supabase.__store.tables.notifications || []).filter(n => n.type === type).length;

const seedTrip = (over = {}) => ({
  id: "t1", driverid: "d1", status: TRIP_STATE.DRIVER_CONFIRMED,
  agentid: "a1", extraagentids: ["a2"], completedpickups: [], completeddropoffs: [],
  noshows: [], pickuptimestamps: {}, pickuplocations: {}, dropofftimestamps: {}, dropofflocations: {},
  scheduleddate: "2026-10-31", updatedat: 1, ...over,
});
const seed = (trip) => {
  supabase.__store.tables = {
    trips: [trip],
    driver_status: [{ driverid: "d1", state: "BUSY", currenttripid: "t1", updatedat: 1 }],
    notifications: [],
    users: [{ id: "d1", fullname: "Dee" }, { id: "a1", fullname: "Ann" }, { id: "a2", fullname: "Ben" }],
    driver_position_log: [],
  };
};
const theTrip = () => supabase.__store.tables.trips[0];
const pickup = (agent_id, confirmed_at, driver_coord) =>
  handleSupabaseAction({ type: "TRIP/CONFIRM_AGENT_PICKUP", trip_id: "t1", agent_id, confirmed_at, driver_coord }, ref, refetch);
const dropoff = (agent_id, confirmed_at, driver_coord, dropoff_label) =>
  handleSupabaseAction({ type: "TRIP/CONFIRM_AGENT_DROPOFF", trip_id: "t1", agent_id, confirmed_at, driver_coord, dropoff_label }, ref, refetch);

beforeEach(() => {
  refetch.mockClear();
  // All network the handlers touch (geocode, web-push, TomTom) falls back to
  // null on a non-ok/failed response — keep tests hermetic.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => "" })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("handleSupabaseAction — duplicate confirmation is a no-op (live handler)", () => {
  it("a repeated partial pickup preserves the original time/GPS and does not re-notify", async () => {
    seed(seedTrip());
    await pickup("a1", 1000, { lat: 1, lng: 2 });
    let t = theTrip();
    expect(t.completedpickups).toEqual(["a1"]);
    expect(t.pickuptimestamps.a1).toBe(1000);
    expect(t.pickuplocations.a1.lat).toBe(1);
    expect(t.status).toBe(TRIP_STATE.DRIVER_CONFIRMED); // a2 still to board
    expect(notifCount("IN_TRANSIT")).toBe(0);

    // Re-tap a1 with DIFFERENT time + coord — must change nothing.
    await pickup("a1", 9999, { lat: 8, lng: 9 });
    t = theTrip();
    expect(t.completedpickups).toEqual(["a1"]);     // no duplicate
    expect(t.pickuptimestamps.a1).toBe(1000);        // preserved, not 9999
    expect(t.pickuplocations.a1.lat).toBe(1);        // preserved, not 8
    expect(notifCount("IN_TRANSIT")).toBe(0);
  });

  it("the final pickup notifies exactly once; a re-tap does not re-notify or re-stamp", async () => {
    seed(seedTrip({ completedpickups: ["a1"], pickuptimestamps: { a1: 1000 }, pickuplocations: { a1: { lat: 1, lng: 2 } } }));
    await pickup("a2", 2000, { lat: 3, lng: 4 });
    let t = theTrip();
    expect(t.status).toBe(TRIP_STATE.IN_TRANSIT);
    expect(t.completedpickups).toEqual(["a1", "a2"]);
    expect(notifCount("IN_TRANSIT")).toBe(1);

    // Re-tap the final agent — stays IN_TRANSIT, exactly one notification total.
    await pickup("a2", 7777, { lat: 5, lng: 6 });
    t = theTrip();
    expect(t.status).toBe(TRIP_STATE.IN_TRANSIT);
    expect(t.pickuptimestamps.a2).toBe(2000);        // preserved, not 7777
    expect(notifCount("IN_TRANSIT")).toBe(1);         // no second notification
  });

  it("a repeated partial drop-off preserves the original time/GPS and does not complete early", async () => {
    seed(seedTrip({ status: TRIP_STATE.IN_TRANSIT, completedpickups: ["a1", "a2"], pickuptimestamps: { a1: 1000, a2: 2000 } }));
    await dropoff("a1", 3000, { lat: 10, lng: 11 }, "Home A");
    let t = theTrip();
    expect(t.completeddropoffs).toEqual(["a1"]);
    expect(t.dropofftimestamps.a1).toBe(3000);
    expect(t.dropofflocations.a1).toMatchObject({ lat: 10, lng: 11, label: "Home A" });
    expect(t.status).toBe(TRIP_STATE.IN_TRANSIT);     // a2 still aboard

    // Re-tap a1 with DIFFERENT values — must change nothing.
    await dropoff("a1", 8888, { lat: 20, lng: 21 }, "WRONG");
    t = theTrip();
    expect(t.completeddropoffs).toEqual(["a1"]);       // no duplicate
    expect(t.dropofftimestamps.a1).toBe(3000);          // preserved
    expect(t.dropofflocations.a1).toMatchObject({ lat: 10, lng: 11, label: "Home A" }); // preserved
    expect(t.status).toBe(TRIP_STATE.IN_TRANSIT);
  });

  it("the final drop-off completes the trip; a replay after completion changes nothing", async () => {
    seed(seedTrip({
      status: TRIP_STATE.IN_TRANSIT, completedpickups: ["a1", "a2"], completeddropoffs: ["a1"],
      dropofftimestamps: { a1: 3000 }, dropofflocations: { a1: { lat: 10, lng: 11, label: "Home A" } },
      pickuptimestamps: { a1: 1000, a2: 2000 },
    }));
    await dropoff("a2", 4000, { lat: 12, lng: 13 }, "Home B");
    let t = theTrip();
    expect(t.status).toBe(TRIP_STATE.ARCHIVED_COMPLETED);
    expect(t.completeddropoffs).toEqual(["a1", "a2"]);
    const completedAt = t.completedat;
    expect(completedAt).toBeTruthy();
    // Driver freed once no active trips remain.
    expect(supabase.__store.tables.driver_status[0].state).toBe("AVAILABLE");

    // Replay a2 after completion — the already-completed guard returns early,
    // so completedat is not re-stamped.
    await dropoff("a2", 9999, { lat: 30, lng: 31 }, "AGAIN");
    t = theTrip();
    expect(t.status).toBe(TRIP_STATE.ARCHIVED_COMPLETED);
    expect(t.completedat).toBe(completedAt);
    expect(t.dropofftimestamps.a2).toBe(4000); // preserved, not 9999
  });
});
