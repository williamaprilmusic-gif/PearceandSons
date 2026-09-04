// Unit tests for pure business-logic functions exported from
// TransitOS_web.jsx — first pass of real test coverage for this
// project (see README's "no automated test suite" note, now partially
// addressed). Deliberately scoped to functions that are deterministic
// and don't require rendering a component or mocking Supabase: the
// financial/billing math (found to have real bugs earlier this
// session), the trip state machine's fee/hours logic, company-scoping
// security rules, and a couple of small date/geo helpers.
//
// Importing the whole (very large) source file runs its module-scope
// code too, including `createClient(...)` for the Supabase client —
// that's synchronous/lazy (no network call happens until a query is
// actually issued), so it's safe to import in a test environment.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  agentFeeCategory,
  agentFeeAmount,
  tripTotalFeeAmount,
  tripDriverPayment,
  haversineKm,
  isMasterAdmin,
  getAdminCompanyIds,
  isCompanyScoped,
  scopeUsersToCompany,
  docExpiryStatus,
  computeDriverHoursToday,
  computeDriverHoursThisWeek,
  cropTrailToPickupWindow,
  earliestScheduledTime,
  companyPolicyDistanceCapKm,
  csvEscapeCell,
  tripRowToApp,
  userRowToApp,
  driverStatusRowToApp,
  TRIP_STATE,
  ROLE,
  ADMIN_LEVEL,
  DRIVER_CAPACITY,
} from "../TransitOS_web.jsx";
import {
  computeGroupSuggestions,
  computeOpsExceptions,
  cronIntervalMs,
  shiftDateStr,
  sastMidnightMs,
  sastTodayStr,
  sastTodaySlashStr,
  auditLogCategory,
  auditLogPeriodKey,
  groupAuditLogsByPeriod,
} from "../admin/AdminSection.jsx";

// 12:00 SAST (well clear of any midnight boundary) for a given SAST
// calendar date — shared by the auditLogPeriodKey/groupAuditLogsByPeriod
// describe blocks below.
const sastNoon = (y, m, d) => Date.UTC(y, m - 1, d, 10, 0, 0);

const feeRates = {
  normal_zar: 100,
  late_booking_zar: 150,
  late_cancellation_zar: 80,
  no_show_zar: 120,
  driver_pay_per_agent_zar: 40,
  driver_pay_per_extra_km_zar: 5,
};

describe("agentFeeCategory / agentFeeAmount — per-agent billing", () => {
  it("bills a completed, on-time, on-schedule trip at the Normal rate", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [] };
    expect(agentFeeCategory(trip, 1)).toBe("normal");
    expect(agentFeeAmount(trip, 1, feeRates)).toBe(100);
  });

  it("bills only the agent who actually no-showed at the No-Show rate — not the whole trip", () => {
    // Regression test for the exact bug fixed 2026-08-08: a shared trip
    // where one of two agents no-showed used to bill BOTH agents at the
    // No-Show rate.
    const trip = {
      state: TRIP_STATE.ARCHIVED_COMPLETED,
      no_shows: [{ agent_id: 2 }],
    };
    expect(agentFeeCategory(trip, 1)).toBe("normal");
    expect(agentFeeCategory(trip, 2)).toBe("no_show");
    expect(agentFeeAmount(trip, 1, feeRates)).toBe(100);
    expect(agentFeeAmount(trip, 2, feeRates)).toBe(120);
  });

  it("bills every agent on a late-booked trip at the Late Booking rate (whole-trip property)", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [], late_booking_flag: true };
    expect(agentFeeAmount(trip, 1, feeRates)).toBe(150);
    expect(agentFeeAmount(trip, 2, feeRates)).toBe(150);
  });

  it("bills a cancelled trip at the Late Cancellation rate regardless of no-show data", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_CANCELLED, no_shows: [{ agent_id: 1 }] };
    expect(agentFeeCategory(trip, 1)).toBe("late_cancellation");
  });

  it("treats an unresolved trip as pending — 0 fee, doesn't count toward totals", () => {
    const trip = { state: TRIP_STATE.IN_TRANSIT, no_shows: [] };
    expect(agentFeeCategory(trip, 1)).toBe("pending");
    expect(agentFeeAmount(trip, 1, feeRates)).toBe(0);
  });

  it("returns null (not 0) when feeRates isn't provided — caller-permission gate", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [] };
    expect(agentFeeAmount(trip, 1, null)).toBeNull();
  });
});

describe("tripTotalFeeAmount — full rate per agent, not divided", () => {
  it("sums the FULL category rate for each agent, not one flat fee split across them", () => {
    // Regression test: a 3-agent trip must bill 3x the rate, matching
    // how driver pay already scales with agent count — NOT one fee
    // divided into shares (the old, since-reversed behavior).
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [], agent_ids: [1, 2, 3] };
    expect(tripTotalFeeAmount(trip, feeRates)).toBe(300);
  });

  it("mixes rates correctly when agents on the same trip have different outcomes", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [{ agent_id: 2 }], agent_ids: [1, 2, 3] };
    // agent 1: normal (100), agent 2: no_show (120), agent 3: normal (100)
    expect(tripTotalFeeAmount(trip, feeRates)).toBe(320);
  });

  it("falls back to a single null-agent row for a trip with no agent_ids", () => {
    const trip = { state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [] };
    expect(tripTotalFeeAmount(trip, feeRates)).toBe(100);
  });
});

describe("tripDriverPayment — paid to the driver, per successful agent + extra km", () => {
  it("pays nothing for a trip that hasn't completed yet", () => {
    const trip = { state: TRIP_STATE.IN_TRANSIT };
    expect(tripDriverPayment(trip, feeRates)).toEqual({ perAgent: 0, perExtraKm: 0, total: 0 });
  });

  it("pays only for successfully-dropped-off agents, excluding a no-show", () => {
    const trip = {
      state: TRIP_STATE.ARCHIVED_COMPLETED,
      agent_ids: [1, 2, 3],
      completed_dropoffs: [1, 3], // agent 2 was a no-show, not in this list
      est_distance_km: 20,
    };
    const result = tripDriverPayment(trip, feeRates);
    expect(result.perAgent).toBe(80); // 2 successful agents * 40
    expect(result.perExtraKm).toBe(0); // 20km * 1.35 = 27km, under the 40km threshold
  });

  it("pays nothing when every agent no-showed (completed_dropoffs explicitly empty, not absent) — regression for a real overpay bug found via audit", () => {
    // completed_dropoffs: [] (tracked, genuinely empty) must NOT be
    // treated the same as completed_dropoffs being absent/untracked —
    // the bug was `t.completed_dropoffs && t.completed_dropoffs.length > 0`
    // falling through to the raw agent_ids count for BOTH cases, silently
    // paying the driver's full per-agent rate on a trip where nobody was
    // actually dropped off.
    const trip = {
      state: TRIP_STATE.ARCHIVED_COMPLETED,
      agent_ids: [1, 2, 3],
      completed_dropoffs: [], // tracked, and the real answer is nobody succeeded
      est_distance_km: 20,
    };
    const result = tripDriverPayment(trip, feeRates);
    expect(result.perAgent).toBe(0);
  });

  it("falls back to the raw agent count only when completed_dropoffs was never tracked at all", () => {
    const trip = {
      state: TRIP_STATE.ARCHIVED_COMPLETED,
      agent_ids: [1, 2, 3],
      // no completed_dropoffs field at all — a legacy trip predating that column
      est_distance_km: 20,
    };
    const result = tripDriverPayment(trip, feeRates);
    expect(result.perAgent).toBe(120); // falls back to all 3 agents * 40
  });

  it("pays extra-km once the road-factored distance exceeds the 40km threshold", () => {
    const trip = {
      state: TRIP_STATE.ARCHIVED_COMPLETED,
      agent_ids: [1],
      completed_dropoffs: [1],
      est_distance_km: 40, // * ROAD_FACTOR (1.35) = 54km road distance
    };
    const result = tripDriverPayment(trip, feeRates);
    // 54 - 40 = 14km over threshold, at 5 ZAR/km = 70
    expect(result.perExtraKm).toBeCloseTo(70, 0);
    expect(result.total).toBeCloseTo(40 + 70, 0);
  });
});

describe("haversineKm — great-circle distance", () => {
  it("returns 0 for identical coordinates", () => {
    expect(haversineKm(-33.9249, 18.4241, -33.9249, 18.4241)).toBeCloseTo(0, 5);
  });

  it("returns Infinity when any coordinate is missing, so a caller's sort never treats it as \"nearest\"", () => {
    expect(haversineKm(null, 18.4241, -33.9249, 18.4241)).toBe(Infinity);
    expect(haversineKm(-33.9249, 18.4241, -33.9249, undefined)).toBe(Infinity);
  });

  it("computes a real known distance correctly (Cape Town CBD to Cape Town Airport, ~19km)", () => {
    const km = haversineKm(-33.9249, 18.4241, -33.9715, 18.6021);
    expect(km).toBeGreaterThan(15);
    expect(km).toBeLessThan(23);
  });
});

describe("isMasterAdmin / getAdminCompanyIds / isCompanyScoped — company scoping", () => {
  const companies = [{ id: 1, name: "Pearce & Sons" }, { id: 2, name: "Turas Hotel" }];

  it("grants master-admin to a FLEET_OPS admin explicitly scoped to the Pearce & Sons operator company", () => {
    const user = { role: ROLE.ADMIN, admin_level: ADMIN_LEVEL.FLEET_OPS, scoped_company_ids: [1] };
    expect(isMasterAdmin(user, companies)).toBe(true);
  });

  it("does not grant master-admin to a FLEET_OPS admin scoped only to a client company", () => {
    const user = { role: ROLE.ADMIN, admin_level: ADMIN_LEVEL.FLEET_OPS, scoped_company_ids: [2] };
    expect(isMasterAdmin(user, companies)).toBe(false);
  });

  it("never grants master-admin to a non-FLEET_OPS tier, even scoped to Pearce & Sons", () => {
    const user = { role: ROLE.ADMIN, admin_level: ADMIN_LEVEL.STANDARD, scoped_company_ids: [1] };
    expect(isMasterAdmin(user, companies)).toBe(false);
  });

  it("FLEET_OPS/STANDARD/FINANCIAL are always fleet-wide unrestricted ([])", () => {
    for (const level of [ADMIN_LEVEL.FLEET_OPS, ADMIN_LEVEL.STANDARD, ADMIN_LEVEL.FINANCIAL]) {
      const user = { role: ROLE.ADMIN, admin_level: level };
      expect(getAdminCompanyIds(user, companies)).toEqual([]);
      expect(isCompanyScoped(user, companies)).toBe(false);
    }
  });

  it("VIEWER with no configured scope sees nothing, not everything", () => {
    // Deliberately NOT [] (which would mean unrestricted) — a real
    // security-relevant distinction this function's own comment calls out.
    const user = { role: ROLE.ADMIN, admin_level: ADMIN_LEVEL.VIEWER };
    const ids = getAdminCompanyIds(user, companies);
    expect(ids).not.toEqual([]);
    expect(isCompanyScoped(user, companies)).toBe(true);
  });

  it("VIEWER scoped to a company only sees that company's ids", () => {
    const user = { role: ROLE.ADMIN, admin_level: ADMIN_LEVEL.VIEWER, scoped_company_ids: [2] };
    expect(getAdminCompanyIds(user, companies)).toEqual([2]);
  });
});

describe("scopeUsersToCompany — Viewer user-list filtering", () => {
  it("includes agents on the scoped company, drivers who've driven them, and all admins — excludes everyone else", () => {
    const users = [
      { id: 1, role: ROLE.AGENT, branch_id: 2 }, // scoped company
      { id: 2, role: ROLE.AGENT, branch_id: 3 }, // different company
      { id: 3, role: ROLE.DRIVER },
      { id: 4, role: ROLE.DRIVER },
      { id: 5, role: ROLE.ADMIN },
    ];
    const trips = [{ agent_ids: [1], driver_id: 3 }];
    const result = scopeUsersToCompany(users, trips, [2]);
    const ids = result.map(u => u.id).sort();
    expect(ids).toEqual([1, 3, 5]); // agent 1 (scoped), driver 3 (drove them), admin 5 — not agent 2 or driver 4
  });

  it("returns the full unfiltered list when companyIds is empty (unrestricted)", () => {
    const users = [{ id: 1, role: ROLE.AGENT, branch_id: 9 }];
    expect(scopeUsersToCompany(users, [], [])).toBe(users);
  });
});

describe("docExpiryStatus — expiry date math", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0)); // 15 Jan 2026, 10:00 local
  });
  afterEach(() => vi.useRealTimers());

  it("treats a document valid through 23:59:59 of its own expiry date, not midnight", () => {
    // Regression test for the exact bug this function's own comment
    // documents: `new Date("2026-01-15")` parses as UTC midnight, which
    // in SAST (UTC+2) read as already-expired hours before end of day.
    const result = docExpiryStatus("2026-01-15");
    expect(result.status).not.toBe("expired");
  });

  it("flags a document as expired once its own expiry date is clearly in the past", () => {
    // Two days back rather than one: Math.ceil() on a same-day-ish
    // negative difference can round to -0 (not < 0), so a document that
    // expired only a few hours ago can still legitimately read
    // "expiring" for the rest of that calendar day — that's the exact
    // "valid through 23:59:59 of its own day" behavior under test above,
    // not a bug. Two full days back removes that boundary ambiguity.
    const result = docExpiryStatus("2026-01-12");
    expect(result.status).toBe("expired");
  });

  it("flags a document expiring within the warning window as \"expiring\", not \"ok\"", () => {
    const result = docExpiryStatus("2026-01-30"); // 15 days out, DOC_WARN_DAYS is 30
    expect(result.status).toBe("expiring");
  });

  it("reports \"missing\" for a null/empty date rather than throwing", () => {
    expect(docExpiryStatus(null)).toEqual({ status: "missing", daysLeft: null });
    expect(docExpiryStatus("")).toEqual({ status: "missing", daysLeft: null });
  });
});

describe("computeDriverHoursToday / computeDriverHoursThisWeek — worked-time from trip activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday, 15:00 local — mid-week, mid-day, so both "today" and
    // "this week" windows have real room on both sides to test against.
    vi.setSystemTime(new Date(2026, 0, 14, 15, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("sums a single completed trip's duration", () => {
    const startOfDay = new Date(2026, 0, 14, 0, 0, 0).getTime();
    const trips = [{
      driver_id: 7,
      accepted_at_epoch: startOfDay + 2 * 3600000,
      completed_at_epoch: startOfDay + 4 * 3600000,
      state: TRIP_STATE.ARCHIVED_COMPLETED,
    }];
    expect(computeDriverHoursToday(7, trips)).toBeCloseTo(2, 5);
  });

  it("merges overlapping trip windows instead of double-counting them", () => {
    // A merged multi-passenger trip can appear as more than one row
    // with overlapping accept/complete windows for the same driver —
    // this must count the union of time, not the sum of both rows.
    const startOfDay = new Date(2026, 0, 14, 0, 0, 0).getTime();
    const trips = [
      { driver_id: 7, accepted_at_epoch: startOfDay + 1 * 3600000, completed_at_epoch: startOfDay + 3 * 3600000, state: TRIP_STATE.ARCHIVED_COMPLETED },
      { driver_id: 7, accepted_at_epoch: startOfDay + 2 * 3600000, completed_at_epoch: startOfDay + 5 * 3600000, state: TRIP_STATE.ARCHIVED_COMPLETED },
    ];
    // Union of [1h,3h] and [2h,5h] = [1h,5h] = 4 hours, NOT 2+3=5.
    expect(computeDriverHoursToday(7, trips)).toBeCloseTo(4, 5);
  });

  it("ignores a cancelled trip entirely — no real worked time", () => {
    const startOfDay = new Date(2026, 0, 14, 0, 0, 0).getTime();
    // Realistic shape: a cancelled trip never reaches TRIP/COMPLETE, so
    // it never gets a completed_at_epoch in real data — this function
    // relies on that invariant (see its own header comment) rather than
    // checking `state` directly, so the fixture must match real data
    // shape, not artificially set completed_at_epoch on a cancelled trip.
    const trips = [{
      driver_id: 7,
      accepted_at_epoch: startOfDay + 1 * 3600000,
      completed_at_epoch: null,
      state: TRIP_STATE.ARCHIVED_CANCELLED,
    }];
    // Cancelled trips don't reach ARCHIVED_COMPLETED or stay IN_TRANSIT,
    // so driverTripIntervalsMs's `end` resolution finds nothing usable.
    expect(computeDriverHoursToday(7, trips)).toBeCloseTo(0, 5);
  });

  it("computeDriverHoursThisWeek counts a trip from earlier in the same week", () => {
    // System time is Wednesday 14 Jan 2026 — Monday that week is the 12th.
    const monday = new Date(2026, 0, 12, 9, 0, 0).getTime();
    const trips = [{
      driver_id: 7,
      accepted_at_epoch: monday,
      completed_at_epoch: monday + 3 * 3600000,
      state: TRIP_STATE.ARCHIVED_COMPLETED,
    }];
    expect(computeDriverHoursThisWeek(7, trips)).toBeCloseTo(3, 5);
  });
});

describe("computeGroupSuggestions — dispatch pooling suggestions", () => {
  const mkUser = (id, branch_id, area) => ({
    id, role: ROLE.AGENT, branch_id, home_address: { area, lat: -33.93, lng: 18.45 },
  });
  const mkTrip = (trip_id, agent_ids, overrides = {}) => ({
    trip_id, agent_ids, direction: "INBOUND", scheduled_date: "2026/08/17", scheduled_time: "06:00",
    pickup_sequence_coords: [{ lat: -33.93, lng: 18.45 }],
    dropoff_sequence_coords: [{ lat: -33.92, lng: 18.42 }],
    ...overrides,
  });

  it("groups two same-date/direction/company/area bookings within the time window", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock")];
    const trips = [mkTrip("T1", [1]), mkTrip("T2", [2], { scheduled_time: "06:15" })];
    const suggestions = computeGroupSuggestions(trips, users, []);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].trips.map(t => t.trip_id).sort()).toEqual(["T1", "T2"]);
    expect(suggestions[0].area).toBe("Woodstock");
  });

  it("does not group bookings more than the time window apart", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock")];
    const trips = [mkTrip("T1", [1], { scheduled_time: "06:00" }), mkTrip("T2", [2], { scheduled_time: "07:00" })];
    expect(computeGroupSuggestions(trips, users, [])).toHaveLength(0);
  });

  it("does not group bookings from different companies, even with matching area/date/direction/time", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 2, "Woodstock")];
    const trips = [mkTrip("T1", [1]), mkTrip("T2", [2])];
    expect(computeGroupSuggestions(trips, users, [])).toHaveLength(0);
  });

  it("does not group bookings from different home areas, even with matching company/date/direction/time", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Observatory")];
    const trips = [mkTrip("T1", [1]), mkTrip("T2", [2])];
    expect(computeGroupSuggestions(trips, users, [])).toHaveLength(0);
  });

  it("reads area from the agent's home for OUTBOUND trips too, not the shared office pickup", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock")];
    const trips = [mkTrip("T1", [1], { direction: "OUTBOUND" }), mkTrip("T2", [2], { direction: "OUTBOUND" })];
    const suggestions = computeGroupSuggestions(trips, users, []);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].area).toBe("Woodstock");
  });

  it("caps a group at the max on-shift driver capacity when it exceeds the default of 4", () => {
    const users = [1, 2, 3, 4, 5].map(id => mkUser(id, 1, "Woodstock"));
    const trips = [1, 2, 3, 4, 5].map(id => mkTrip(`T${id}`, [id]));
    const driverStatus = [{ driver_id: "D1", capacity: 6 }];
    const suggestions = computeGroupSuggestions(trips, users, driverStatus);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].trips).toHaveLength(5); // all 5 fit under a cap of 6
  });

  it("falls back to DRIVER_CAPACITY when driverStatus is empty", () => {
    const users = [1, 2, 3, 4, 5].map(id => mkUser(id, 1, "Woodstock"));
    const trips = [1, 2, 3, 4, 5].map(id => mkTrip(`T${id}`, [id]));
    const suggestions = computeGroupSuggestions(trips, users, []);
    expect(suggestions[0].trips).toHaveLength(DRIVER_CAPACITY);
  });

  it("prefers the nearer of two eligible candidates over raw array order", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock"), mkUser(3, 1, "Woodstock")];
    const trips = [
      mkTrip("Anchor", [1], { pickup_sequence_coords: [{ lat: -33.930, lng: 18.450 }] }),
      mkTrip("Farther", [2], { pickup_sequence_coords: [{ lat: -33.960, lng: 18.500 }] }),
      mkTrip("Nearer", [3], { pickup_sequence_coords: [{ lat: -33.931, lng: 18.451 }] }),
    ];
    const driverStatus = [{ driver_id: "D1", capacity: 2 }]; // room for only 1 more
    const suggestions = computeGroupSuggestions(trips, users, driverStatus);
    expect(suggestions[0].trips.map(t => t.trip_id)).toEqual(["Anchor", "Nearer"]);
  });

  it("does not let a candidate overlap an already-added group member's agent (not just the anchor's)", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock"), mkUser(3, 1, "Woodstock")];
    const trips = [
      mkTrip("A", [1]),
      mkTrip("B", [2]),
      mkTrip("C", [3, 2]), // shares agent 2 with B, not with A directly
    ];
    const driverStatus = [{ driver_id: "D1", capacity: 10 }];
    const suggestions = computeGroupSuggestions(trips, users, driverStatus);
    expect(suggestions[0].trips.map(t => t.trip_id)).toEqual(["A", "B"]);
  });

  it("never groups a booking whose agent can't be resolved (missing company/area)", () => {
    const users = [mkUser(1, 1, "Woodstock")]; // agent 2 deliberately absent
    const trips = [mkTrip("A", [1]), mkTrip("B", [2])];
    expect(computeGroupSuggestions(trips, users, [])).toHaveLength(0);
  });

  it("REGRESSION: detects an agent overlap even when the two bookings carry the same id as different types (2 vs \"2\")", () => {
    const users = [mkUser(1, 1, "Woodstock"), mkUser(2, 1, "Woodstock"), mkUser(3, 1, "Woodstock")];
    const trips = [
      mkTrip("A", [1]),
      mkTrip("B", [2]),        // numeric agent id
      mkTrip("C", [3, "2"]),   // same agent, string id — a raw Set.has() would miss this
    ];
    const driverStatus = [{ driver_id: "D1", capacity: 10 }];
    const suggestions = computeGroupSuggestions(trips, users, driverStatus);
    // C must NOT be pulled in — it shares agent 2 with B
    expect(suggestions[0].trips.map(t => t.trip_id)).toEqual(["A", "B"]);
  });
});

describe("cropTrailToPickupWindow — GPS trail crop (temporal + spatial)", () => {
  const PICKUP = { lat: -33.891199, lng: 18.484883 };

  it("returns the trail unchanged when no timestamps exist yet, even if a point happens to sit near pickup", () => {
    // Regression test for a real bug: the spatial snap used to run even
    // with no pickup confirmed yet, risking discarding legitimate
    // in-progress-trip trail data on a coincidental near-pickup point.
    const trail = [
      { lat: -33.9, lng: 18.4, recorded_at: 1000 },
      { lat: PICKUP.lat, lng: PICKUP.lng, recorded_at: 2000 },
      { lat: -34.0, lng: 18.6, recorded_at: 3000 },
    ];
    expect(cropTrailToPickupWindow(trail, {}, {}, PICKUP)).toEqual(trail);
  });

  it("crops the trail to the pickup->dropoff time window", () => {
    const trail = [100, 200, 300, 400].map(recorded_at => ({ lat: 0, lng: 0, recorded_at }));
    const result = cropTrailToPickupWindow(trail, { a: 200 }, { a: 300 }, null);
    expect(result.map(p => p.recorded_at)).toEqual([200, 300]);
  });

  it("falls back to the full trail (lenient) or null (strict) when the time window catches zero points", () => {
    const trail = [{ lat: 0, lng: 0, recorded_at: 100 }];
    expect(cropTrailToPickupWindow(trail, { a: 500 }, { a: 600 }, null)).toEqual(trail);
    expect(cropTrailToPickupWindow(trail, { a: 500 }, { a: 600 }, null, { strict: true })).toBeNull();
  });

  it("snaps the crop start to the first point near ANY of several pickup coordinates", () => {
    // A multi-agent INBOUND trip has one pickup per agent, and the
    // driver doesn't necessarily visit the primary agent's first.
    const trail = [
      { lat: -30, lng: 20, recorded_at: 100 }, // far from every pickup
      { lat: PICKUP.lat, lng: PICKUP.lng, recorded_at: 200 }, // near the 2nd coord
      { lat: -34, lng: 18.5, recorded_at: 300 },
    ];
    const result = cropTrailToPickupWindow(trail, { a: 100 }, {}, [{ lat: -20, lng: 10 }, PICKUP]);
    expect(result.map(p => p.recorded_at)).toEqual([200, 300]);
  });

  it("leaves the trail unchanged (lenient) or returns null (strict) when no point is ever near the pickup", () => {
    const trail = [
      { lat: -30, lng: 20, recorded_at: 100 },
      { lat: -31, lng: 21, recorded_at: 200 },
    ];
    expect(cropTrailToPickupWindow(trail, { a: 100 }, {}, PICKUP)).toEqual(trail);
    expect(cropTrailToPickupWindow(trail, { a: 100 }, {}, PICKUP, { strict: true })).toBeNull();
  });

  it("returns null (strict) or an empty trail (lenient) when the raw trail itself is empty", () => {
    expect(cropTrailToPickupWindow([], {}, {}, null, { strict: true })).toBeNull();
    expect(cropTrailToPickupWindow([], {}, {}, null)).toEqual([]);
  });
});

// Added per explicit request to cover the highest-value pure helpers that
// weren't yet tested — several of these were the actual source of real
// bugs found via manual /code-review earlier this session (most notably
// shiftDateStr's month-rollover bug), so these are regression tests for
// bugs that already happened once, not speculative coverage.

describe("shiftDateStr — calendar-month-safe date-string arithmetic", () => {
  it("shifts by days, including a year rollover", () => {
    expect(shiftDateStr("2026-08-20", { days: -7 })).toBe("2026-08-13");
    expect(shiftDateStr("2026-01-01", { days: -1 })).toBe("2025-12-31");
  });

  it("shifts by a calendar month in the ordinary case", () => {
    expect(shiftDateStr("2026-08-20", { months: -1 })).toBe("2026-07-20");
  });

  it("REGRESSION: clamps to the target month's real last day instead of overflowing forward (Oct 31 - 1mo = Sep 30, not Oct 1)", () => {
    // The exact bug found via /code-review this session: `setMonth` on a
    // day that doesn't exist in the target month rolls FORWARD into the
    // following month (Oct 31 -> "Sep 31" -> normalizes to Oct 1),
    // silently collapsing a "PAST MONTH" quick-range button to 1 day.
    expect(shiftDateStr("2026-10-31", { months: -1 })).toBe("2026-09-30");
  });

  it("REGRESSION: clamps correctly into a non-leap February", () => {
    expect(shiftDateStr("2026-03-31", { months: -1 })).toBe("2026-02-28"); // 2026 is not a leap year
  });
});

describe("sastMidnightMs / sastTodayStr / sastTodaySlashStr — SAST-pinned date helpers", () => {
  it("sastMidnightMs returns the UTC epoch of SAST midnight (UTC+2) for a given date string", () => {
    // 2026-08-20 00:00 SAST == 2026-08-19 22:00 UTC.
    expect(sastMidnightMs("2026-08-20")).toBe(Date.UTC(2026, 7, 19, 22, 0, 0, 0));
  });

  it("sastTodayStr/sastTodaySlashStr agree on the same calendar day, just dash- vs slash-separated", () => {
    vi.useFakeTimers();
    try {
      // 2026-08-20 10:00 UTC = 12:00 SAST, well clear of any midnight boundary.
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 20, 10, 0, 0)));
      expect(sastTodayStr()).toBe("2026-08-20");
      expect(sastTodaySlashStr()).toBe("2026/08/20");
    } finally {
      vi.useRealTimers();
    }
  });

  it("REGRESSION: sastTodayStr reads the SAST day, not the UTC day, right after SAST midnight", () => {
    // 2026-08-19 23:00 UTC = 2026-08-20 01:00 SAST — the exact window
    // (00:00-01:59 SAST) where a naive `new Date().toISOString()` UTC
    // read would wrongly still show 2026-08-19.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 7, 19, 23, 0, 0)));
      expect(sastTodayStr()).toBe("2026-08-20");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("earliestScheduledTime — earliest scheduledtime among raw DB-shaped rows", () => {
  it("returns the smallest scheduledtime, ignoring null/missing", () => {
    expect(earliestScheduledTime([{ scheduledtime: 300 }, { scheduledtime: 100 }, { scheduledtime: 200 }])).toBe(100);
    expect(earliestScheduledTime([{ scheduledtime: null }, { scheduledtime: 500 }])).toBe(500);
  });

  it("returns null when no row has a real scheduledtime", () => {
    expect(earliestScheduledTime([])).toBeNull();
    expect(earliestScheduledTime([{ scheduledtime: null }, {}])).toBeNull();
  });
});

describe("companyPolicyDistanceCapKm — driver route distance cap scales with passenger count", () => {
  it("is 40km per agent, minimum 1 agent", () => {
    expect(companyPolicyDistanceCapKm(1)).toBe(40);
    expect(companyPolicyDistanceCapKm(3)).toBe(120);
    expect(companyPolicyDistanceCapKm(0)).toBe(40); // never below the 1-agent floor
  });
});

describe("csvEscapeCell — CSV quoting + formula-injection guard", () => {
  it("passes plain values through unchanged", () => {
    expect(csvEscapeCell("plain text")).toBe("plain text");
    expect(csvEscapeCell(42)).toBe("42");
    expect(csvEscapeCell(null)).toBe("");
    expect(csvEscapeCell(undefined)).toBe("");
  });

  it("quotes values containing a comma, quote, or CRLF, doubling any embedded quotes", () => {
    expect(csvEscapeCell("a,b")).toBe('"a,b"');
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscapeCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    expect(csvEscapeCell("line1\rline2")).toBe('"line1\rline2"'); // lone \r, not just \r\n
  });

  it("REGRESSION: neutralizes formula-injection prefixes (=, +, -, @) without mangling ordinary negative numbers visually", () => {
    expect(csvEscapeCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvEscapeCell("+1234")).toBe("'+1234");
    expect(csvEscapeCell("@mention")).toBe("'@mention");
    expect(csvEscapeCell("-5")).toBe("'-5"); // a leading "-" is guarded too, even on an otherwise-plain number
  });
});

describe("auditLogCategory — action-type category prefix", () => {
  it("takes the part before the first slash", () => {
    expect(auditLogCategory("TRIP/ASSIGN_DRIVER")).toBe("TRIP");
    expect(auditLogCategory("ADMIN/CREATE_USER")).toBe("ADMIN");
    expect(auditLogCategory("DM/SEND")).toBe("DM");
  });

  it("falls back to OTHER for anything without a recognizable category", () => {
    expect(auditLogCategory("")).toBe("OTHER");
    expect(auditLogCategory(null)).toBe("OTHER");
    expect(auditLogCategory(undefined)).toBe("OTHER");
  });
});

describe("auditLogPeriodKey — SAST-pinned day/week/month bucketing", () => {
  // 2026-08-17 is a Monday, 2026-08-20 a Thursday, 2026-08-23 a Sunday
  // (same ISO week), 2026-08-24 the following Monday.

  it("day granularity returns the SAST calendar date", () => {
    expect(auditLogPeriodKey(sastNoon(2026, 8, 20), "day")).toBe("2026-08-20");
  });

  it("month granularity returns YYYY-MM", () => {
    expect(auditLogPeriodKey(sastNoon(2026, 8, 20), "month")).toBe("2026-08");
  });

  it("week granularity buckets Monday through Sunday under that Monday's date (ISO week)", () => {
    const monday = auditLogPeriodKey(sastNoon(2026, 8, 17), "week");
    expect(monday).toBe("2026-08-17");
    expect(auditLogPeriodKey(sastNoon(2026, 8, 20), "week")).toBe(monday); // Thursday, same week
    expect(auditLogPeriodKey(sastNoon(2026, 8, 23), "week")).toBe(monday); // Sunday, still same week
    // The following Monday must land in a DIFFERENT bucket, not the same one.
    expect(auditLogPeriodKey(sastNoon(2026, 8, 24), "week")).toBe("2026-08-24");
  });
});

describe("groupAuditLogsByPeriod — buckets + per-category counts, newest-first", () => {

  it("groups entries into day buckets and tallies each bucket's category breakdown", () => {
    const logs = [
      { id: 1, actionType: "TRIP/ASSIGN_DRIVER", timestamp: sastNoon(2026, 8, 20) },
      { id: 2, actionType: "TRIP/ADD_AGENT", timestamp: sastNoon(2026, 8, 20) },
      { id: 3, actionType: "ADMIN/CREATE_USER", timestamp: sastNoon(2026, 8, 19) },
    ];
    const grouped = groupAuditLogsByPeriod(logs, "day");
    expect(grouped.map(b => b.key)).toEqual(["2026-08-20", "2026-08-19"]); // newest first
    const day20 = grouped.find(b => b.key === "2026-08-20");
    expect(day20.count).toBe(2);
    expect(day20.byCategory).toEqual({ TRIP: 2 });
    expect(day20.entries.map(e => e.id)).toEqual([1, 2]);
  });

  it("returns an empty array for an empty log list", () => {
    expect(groupAuditLogsByPeriod([], "day")).toEqual([]);
  });
});

describe("row mappers — hydration-boundary id normalization", () => {
  it("tripRowToApp stringifies every id-shaped field, keeps null null", () => {
    const t = tripRowToApp({
      id: 42, agentid: 7, extraagentids: [8, 9], driverid: 3, status: "ASSIGNED",
      pickuplat: -33.9, pickuplng: 18.4, pickuplabel: "X", phone: "021",
      completedpickups: [7, 8], completeddropoffs: [], noshows: [{ agent_id: 9, reason: "x" }],
      pickupcompanyid: 2, dropoffcompanyid: null, weekgroupid: 100,
      declinedby: [3, 4], rejectiondriverid: 5,
    }, {});
    expect(t.trip_id).toBe("42");
    expect(t.agent_ids).toEqual(["7", "8", "9"]);
    expect(t.driver_id).toBe("3");
    expect(t.completed_pickups).toEqual(["7", "8"]);
    expect(t.no_shows[0].agent_id).toBe("9");
    expect(t.pickup_company_id).toBe("2");
    expect(t.dropoff_company_id).toBe(null); // null passes through, not "null"
    expect(t.week_group_id).toBe("100");
    expect(t.declinedBy).toEqual(["3", "4"]);
    expect(t.rejection_driver_id).toBe("5");
    expect(t.pickup_sequence_coords[0].agent_id).toBe("7");
  });

  it("tripRowToApp leaves an unassigned booking's driver_id null", () => {
    expect(tripRowToApp({ id: 1, agentid: 2, driverid: null, status: "UNASSIGNED_BOOKING" }, {}).driver_id).toBe(null);
  });

  it("userRowToApp / driverStatusRowToApp stringify ids", () => {
    const u = userRowToApp({ id: 5, role: ROLE.AGENT, fullname: "A", branchid: 2, campaignid: 9 });
    expect(u.id).toBe("5");
    expect(u.branch_id).toBe("2");
    expect(u.campaign_id).toBe("9");
    const ds = driverStatusRowToApp({ driverid: 5, currenttripid: 42, state: "AVAILABLE" });
    expect(ds.driver_id).toBe("5");
    expect(ds.current_trip_id).toBe("42");
    expect(driverStatusRowToApp({ driverid: 6, currenttripid: null }).current_trip_id).toBe(null);
  });

  it("scopeUsersToCompany matches a numeric branch_id against a string companyId (post-hydration shape)", () => {
    const users = [
      { id: "1", role: ROLE.AGENT, branch_id: 2 },       // number branch_id
      { id: "2", role: ROLE.AGENT, branch_id: "2" },     // string branch_id
      { id: "3", role: ROLE.AGENT, branch_id: 9 },
    ];
    const scoped = scopeUsersToCompany(users, [], ["2"]); // string companyId
    expect(scoped.map(u => u.id).sort()).toEqual(["1", "2"]);
  });
});

describe("computeOpsExceptions — live exceptions board sweep", () => {
  // 13:00 local — late enough in the day that >12h can fall within
  // "today" for the driver-hours case (computeDriverHoursToday reads the
  // real wall clock, so the system time is faked to match NOW here).
  const NOW = new Date(2026, 8, 15, 13, 0, 0).getTime();
  const MIN = 60 * 1000, HR = 60 * MIN;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(NOW)); });
  afterEach(() => vi.useRealTimers());
  const users = [
    { id: 1, role: ROLE.AGENT, name: "Agent One" },
    { id: 2, role: ROLE.AGENT, name: "Agent Two" },
    { id: 9, role: ROLE.DRIVER, name: "Driver Nine" },
  ];
  const baseTrip = (over) => ({
    trip_id: "T1", driver_id: 9, agent_ids: [1], scheduled_time: "06:00",
    scheduled_time_epoch: NOW - 45 * MIN, no_shows: [], ...over,
  });
  const call = (state) => computeOpsExceptions({ users, driver_status: [], trips: [], ...state }, { now: NOW });

  it("returns [] when nothing is wrong", () => {
    expect(call({})).toEqual([]);
  });

  it("flags a confirmed trip 45 min past its start as a high-severity late_start", () => {
    const out = call({ trips: [baseTrip({ state: TRIP_STATE.DRIVER_CONFIRMED })] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "late_start", severity: "high", trip_id: "T1" });
  });

  it("does NOT flag a confirmed trip only 10 min late", () => {
    const out = call({ trips: [baseTrip({ state: TRIP_STATE.DRIVER_CONFIRMED, scheduled_time_epoch: NOW - 10 * MIN })] });
    expect(out).toEqual([]);
  });

  it("flags an unassigned booking inside the 2h window (med) and an overdue one (high)", () => {
    const soon = call({ trips: [baseTrip({ trip_id: "S", state: TRIP_STATE.UNASSIGNED_BOOKING, scheduled_time_epoch: NOW + 30 * MIN })] });
    expect(soon[0]).toMatchObject({ kind: "unassigned", severity: "med" });
    const overdue = call({ trips: [baseTrip({ trip_id: "O", state: TRIP_STATE.UNASSIGNED_BOOKING, scheduled_time_epoch: NOW - 20 * MIN })] });
    expect(overdue[0]).toMatchObject({ kind: "unassigned", severity: "high" });
    const farOff = call({ trips: [baseTrip({ trip_id: "F", state: TRIP_STATE.UNASSIGNED_BOOKING, scheduled_time_epoch: NOW + 5 * HR })] });
    expect(farOff).toEqual([]);
  });

  it("flags a trip in transit for 4h as stuck, but not one only 1h in", () => {
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.IN_TRANSIT, in_transit_at_epoch: NOW - 4 * HR })] })[0])
      .toMatchObject({ kind: "stuck", severity: "high" });
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.IN_TRANSIT, in_transit_at_epoch: NOW - 1 * HR })] })).toEqual([]);
  });

  it("stops flagging late_start / stuck once the trip is stale (>12h / >24h) so old records don't sit as permanent 'high' rows", () => {
    // Confirmed 15h past its start — never happened, not today's problem.
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.DRIVER_CONFIRMED, scheduled_time_epoch: NOW - 15 * HR })] })).toEqual([]);
    // "In transit" for 30h — a long-finished trip nobody closed out.
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.IN_TRANSIT, in_transit_at_epoch: NOW - 30 * HR })] })).toEqual([]);
  });

  it("de-dupes by driver_id — a duplicated driver_status row yields ONE doc row, not colliding keys", () => {
    const out = call({
      driver_status: [
        { driver_id: 9, documents: { prdp: "2020-01-01" } },
        { driver_id: 9, documents: { prdp: "2020-01-01" } }, // dupe hydrated row
      ],
    });
    const docRows = out.filter(e => e.kind === "doc");
    expect(docRows).toHaveLength(1);
    expect(new Set(out.map(e => e.id)).size).toBe(out.length); // all ids unique
  });

  it("flags a no-show on a completed trip, but ignores no_shows on a cancelled trip", () => {
    const completed = call({ trips: [baseTrip({ state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [{ agent_id: 2 }], completed_at_epoch: NOW - HR })] });
    expect(completed[0]).toMatchObject({ kind: "no_show", severity: "med" });
    expect(completed[0].detail).toContain("Agent Two");
    const cancelled = call({ trips: [baseTrip({ state: TRIP_STATE.ARCHIVED_CANCELLED, no_shows: [{ agent_id: 2 }] })] });
    expect(cancelled).toEqual([]);
  });

  it("stops showing a no-show once it is more than ~a day old", () => {
    const stale = call({ trips: [baseTrip({ state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [{ agent_id: 2 }], completed_at_epoch: NOW - 25 * HR })] });
    expect(stale).toEqual([]);
  });

  it("ignores an unassigned booking that is hours past its start (stale, not actionable)", () => {
    const stale = call({ trips: [baseTrip({ trip_id: "STALE", state: TRIP_STATE.UNASSIGNED_BOOKING, scheduled_time_epoch: NOW - 8 * HR })] });
    expect(stale).toEqual([]);
  });

  it("flags an OPEN / DRIVER_RESPONDED dispute but not a resolved one", () => {
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.ARCHIVED_COMPLETED, dispute: { state: "OPEN", category: "Route", filed_at: NOW - HR } })] })[0])
      .toMatchObject({ kind: "dispute", severity: "high" });
    expect(call({ trips: [baseTrip({ state: TRIP_STATE.ARCHIVED_COMPLETED, dispute: { state: "RESOLVED_UPHELD" } })] })).toEqual([]);
  });

  it("flags an expired required document as high, a non-required one as low", () => {
    const prdp = call({ driver_status: [{ driver_id: 9, documents: { prdp: "2020-01-01" } }] });
    expect(prdp[0]).toMatchObject({ kind: "doc", severity: "high", driver_id: 9 });
    const rw = call({ driver_status: [{ driver_id: 9, documents: { roadworthy: "2020-01-01" } }] });
    expect(rw[0]).toMatchObject({ kind: "doc", severity: "low" });
  });

  it("ranks a required document that is merely EXPIRING as med (not low, not high)", () => {
    // 5 days out from the faked NOW (2026-09-15) → within docExpiryStatus's 30-day warn window.
    const soon = call({ driver_status: [{ driver_id: 9, documents: { prdp: "2026-09-20" } }] });
    expect(soon[0]).toMatchObject({ kind: "doc", severity: "med" });
    const rwSoon = call({ driver_status: [{ driver_id: 9, documents: { roadworthy: "2026-09-20" } }] });
    expect(rwSoon[0]).toMatchObject({ kind: "doc", severity: "low" });
  });

  it("flags a driver over the daily hours advisory", () => {
    // One completed trip spanning 13h of "today" (00:00–13:00 with the
    // clock faked to 13:00) — over MAX_DRIVER_HOURS_PER_DAY = 12.
    const out = call({
      driver_status: [{ driver_id: 9, documents: {} }],
      trips: [{ trip_id: "H", driver_id: 9, state: TRIP_STATE.ARCHIVED_COMPLETED, accepted_at_epoch: NOW - 13 * HR, completed_at_epoch: NOW }],
    });
    const hoursRows = out.filter(e => e.kind === "hours");
    expect(hoursRows).toHaveLength(1);
    expect(hoursRows[0]).toMatchObject({ severity: "med", driver_id: 9 });
  });

  it("sorts high-severity items ahead of lower ones", () => {
    const out = call({
      trips: [
        baseTrip({ trip_id: "LATE", state: TRIP_STATE.DRIVER_CONFIRMED }),                       // high
        baseTrip({ trip_id: "NS", state: TRIP_STATE.ARCHIVED_COMPLETED, no_shows: [{ agent_id: 1 }] }), // med
      ],
    });
    expect(out.map(e => e.severity)).toEqual(["high", "med"]);
  });
});

describe("cronIntervalMs — expected interval from a 5-field cron expr (Status page)", () => {
  const MIN = 60000, HR = 60 * MIN, DAY = 24 * HR;
  it("handles */N minute and hour steps", () => {
    expect(cronIntervalMs("*/10 * * * *")).toBe(10 * MIN);
    expect(cronIntervalMs("*/30 * * * *")).toBe(30 * MIN);
    expect(cronIntervalMs("*/2 * * * *")).toBe(2 * MIN);
  });
  it("treats a fixed hour with wildcard day as daily", () => {
    expect(cronIntervalMs("0 5 * * *")).toBe(DAY);
    expect(cronIntervalMs("45 3 * * *")).toBe(DAY);
  });
  it("widens to weekly / monthly when a day-of-week / day-of-month is pinned", () => {
    expect(cronIntervalMs("0 4 * * 1")).toBe(7 * DAY);      // weekly digest
    expect(cronIntervalMs("0 4 1 * *")).toBe(31 * DAY);     // monthly export
  });
  it("uses the smallest gap for a comma-list minute field", () => {
    expect(cronIntervalMs("0,30 * * * *")).toBe(30 * MIN);
    expect(cronIntervalMs("0,15,30,45 * * * *")).toBe(15 * MIN);
  });
  it("treats hour '*' with a fixed minute as hourly", () => {
    expect(cronIntervalMs("17 * * * *")).toBe(HR);
  });
  it("uses the smallest gap for a comma-list / range / step hour field", () => {
    expect(cronIntervalMs("0 6,18 * * *")).toBe(12 * HR);   // twice daily
    expect(cronIntervalMs("0 9-17 * * *")).toBe(HR);        // hourly within a window
    expect(cronIntervalMs("0 */4 * * *")).toBe(4 * HR);
  });
  it("returns null for empty, non-string, non-5-field, or pg_cron interval syntax", () => {
    expect(cronIntervalMs("")).toBeNull();
    expect(cronIntervalMs(null)).toBeNull();
    expect(cronIntervalMs("30 seconds")).toBeNull();        // pg_cron interval form
    expect(cronIntervalMs("0 4 * * * *")).toBeNull();       // 6 fields
  });
});
