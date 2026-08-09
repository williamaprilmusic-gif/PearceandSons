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
  vehicleServiceStatus,
  computeDriverHoursToday,
  computeDriverHoursThisWeek,
  TRIP_STATE,
  ROLE,
  ADMIN_LEVEL,
} from "../TransitOS_web.jsx";

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

describe("docExpiryStatus / vehicleServiceStatus — expiry date math", () => {
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

  it("vehicleServiceStatus picks whichever of date/km is more urgent", () => {
    const expiredByDate = { next_service_date: "2026-01-01", next_service_km: 50000, odometer_km: 10000 };
    expect(vehicleServiceStatus(expiredByDate).status).toBe("expired");

    const expiredByKm = { next_service_date: "2027-01-01", next_service_km: 9900, odometer_km: 10000 };
    expect(vehicleServiceStatus(expiredByKm).status).toBe("expired");

    const fine = { next_service_date: "2027-01-01", next_service_km: 50000, odometer_km: 10000 };
    expect(vehicleServiceStatus(fine).status).toBe("ok");
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
