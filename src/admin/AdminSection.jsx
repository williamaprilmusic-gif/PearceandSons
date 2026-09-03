import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ADMIN_ADVISORY_WINDOW_HOURS,
  ADMIN_LEVEL,
  ADMIN_PERMISSIONS,
  AlertSoundToggle,
  BiometricEnrollButton,
  Button,
  CALL_STATE,
  COLORS,
  CPT_BOUNDS,
  CallOverlay,
  CapacityBar,
  Card,
  ClientPortalApp,
  DISPUTE_STATE,
  DOC_TYPES,
  DRIVER_CAPACITY,
  DRIVER_STATE,
  DriverAvatar,
  Empty,
  FONTS,
  LOGO_DATA_URI,
  MAX_DRIVER_HOURS_PER_DAY,
  MAX_DRIVER_HOURS_PER_WEEK,
  ROAD_FACTOR,
  ROLE,
  RoleBadge,
  SUPABASE_URL,
  SectionHeader,
  SlaReportPanel,
  StateBadge,
  TOMTOM_API_KEY,
  TRAFFIC_INCIDENT_ICON,
  TRIP_STATE,
  TextField,
  _cachedSessionToken,
  actualDropOrderFor,
  actualDropoffCoordOrder,
  actualPickupOrderFor,
  buildWazeLink,
  companyById,
  computeDriverHoursThisWeek,
  computeDriverHoursToday,
  computeDriverStats,
  computeFleetUtilization,
  copyShareLink,
  csvEscapeCell,
  defaultCompanyAnchor,
  docExpiryStatus,
  driverAvgRating,
  driverPositionChannelName,
  epochToDisplay,
  exceptionLabel,
  exportGpsTrailToCsv,
  exportTripsToCsv,
  fetchDelaysForTrips,
  fetchDirectMessages,
  fetchDriverSafetyHistory,
  fetchGpsTrailForTrip,
  fetchMyConversations,
  fetchTripDelays,
  fetchTripHistory,
  fmtSastDateTime,
  getAdminCompanyIds,
  getDriverLoad,
  haversineKm,
  cropTrailToPickupWindow,
  isCompanyScoped,
  isMasterAdmin,
  notifySessionExpired,
  now,
  printWaybill,
  scopeUsersToCompany,
  sortDropoffCoordsByProximity,
  sortDropoffsByProximity,
  staticSearch,
  supabase,
  tomtomTrafficIncidents,
  tripDriverPayment,
  tripTotalFeeAmount,
  tripNoShowRisk,
  tripNoun,
  tripNounCap,
  unifiedAddressSearch,
  usePersistedTab,
  useSortedDropoffs,
  useWebRTCCall
} from "../TransitOS_web.jsx";

function hasAdminPermission(user, permission) {
  if (!user || user.role !== ROLE.ADMIN) return false;
  const level = ADMIN_PERMISSIONS[user.admin_level] ? user.admin_level : ADMIN_LEVEL.VIEWER;
  return !!ADMIN_PERMISSIONS[level][permission];
}

// All id membership tests below are String-normalized — Supabase bigint
// ids (company/branch, user, driver, trip) can surface as number or
// string depending on hydration path, and a raw Set.has() mismatch here
// would silently drop a company-scoped admin's trips/tickets/
// notifications/drivers from their dashboard (same id-comparison class
// fixed in computeGroupSuggestions / fetchMyConversations).
function scopeTripsToCompany(trips, users, companyIds) {
  if (!companyIds?.length) return trips;
  const idSet = new Set(companyIds.map(String));
  const scopedAgentIds = new Set(users.filter(u => u.role === ROLE.AGENT && idSet.has(String(u.branch_id))).map(u => String(u.id)));
  return trips.filter(t => t.agent_ids?.some(id => scopedAgentIds.has(String(id))));
}

function scopeTicketsToCompany(tickets, users, trips, companyIds) {
  if (!companyIds?.length) return tickets;
  const idSet = new Set(companyIds.map(String));
  const scopedAgentIds = new Set(users.filter(u => u.role === ROLE.AGENT && idSet.has(String(u.branch_id))).map(u => String(u.id)));
  const relevantDriverIds = new Set(
    (trips || []).filter(t => t.agent_ids?.some(id => scopedAgentIds.has(String(id)))).map(t => t.driver_id).filter(Boolean).map(String)
  );
  return tickets.filter(t => scopedAgentIds.has(String(t.agent_id)) || relevantDriverIds.has(String(t.agent_id)));
}

function scopeNotificationsToCompany(notifications, trips, users, companyIds) {
  if (!companyIds?.length) return notifications;
  const idSet = new Set(companyIds.map(String));
  const scopedAgentIds = new Set(users.filter(u => u.role === ROLE.AGENT && idSet.has(String(u.branch_id))).map(u => String(u.id)));
  const scopedTripIds = new Set(trips.filter(t => t.agent_ids?.some(id => scopedAgentIds.has(String(id)))).map(t => String(t.trip_id)));
  return notifications.filter(n => !n.trip_id || scopedTripIds.has(String(n.trip_id)));
}

function scopeDriverStatusToCompany(driverStatus, trips, users, companyIds) {
  if (!companyIds?.length) return driverStatus;
  const idSet = new Set(companyIds.map(String));
  const scopedAgentIds = new Set(users.filter(u => u.role === ROLE.AGENT && idSet.has(String(u.branch_id))).map(u => String(u.id)));
  const relevantDriverIds = new Set(
    (trips || []).filter(t => t.agent_ids?.some(id => scopedAgentIds.has(String(id)))).map(t => t.driver_id).filter(Boolean).map(String)
  );
  return driverStatus.filter(ds => relevantDriverIds.has(String(ds.driver_id)));
}

function useIsNarrowScreen(breakpointPx = 768) {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia(`(max-width: ${breakpointPx}px)`).matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [breakpointPx]);
  return isNarrow;
}

// Forces a periodic re-render by ticking a timestamp every `intervalMs` —
// for any `useMemo` that reads wall-clock time (Date.now()/new Date())
// internally without it being part of the memo's own logic. Wall-clock
// time can never be a real useMemo dependency (it's not a prop/state
// value the memo receives), so a memoized computation that reads it
// silently freezes at whatever time it happened to first run, until some
// UNRELATED dependency forces a recompute. FOUND VIA /code-review, first
// on AdminDispatch's 30s driver-position-staleness check (a real
// dispatch-decision-affecting bug — memoizing that derivation without
// this ticker meant a driver's position could keep scoring as "live"
// well past the 30s cutoff), then found to be the identical pre-existing
// gap in computeSchedulingRecommendations/computeWeeklySummary's own
// memos below (7-day windows, so a coarser interval here is enough to
// keep those from drifting stale across a midnight rollover without
// adding meaningful re-render overhead).
function useTicker(intervalMs) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);
  return tick;
}

function distinctWeekDays(trips) {
  return new Set(trips.map(t => t.scheduled_date)).size;
}

function getDriverTripCountForDate(state, driver_id, scheduledDate) {
  return state.trips.filter(t => String(t.driver_id) === String(driver_id) && t.scheduled_date === scheduledDate).length;
}

function openWaze(lat, lng, label = "") {
  window.open(buildWazeLink(lat, lng, label), "_blank", "noopener,noreferrer");
}

function buildWazeAddressLink(address) {
  const params = new URLSearchParams({ q: address, navigate: "yes" });
  return `https://www.waze.com/ul?${params}`;
}

function openWazeByAddress(address) {
  window.open(buildWazeAddressLink(address), "_blank", "noopener,noreferrer");
}

function smartOpenWaze(lat, lng, label, isManual) {
  if (isManual && label) { openWazeByAddress(label); return; }
  if (lat != null && lng != null) openWaze(lat, lng, label);
}

function DisputeAdminPanel({ trip, dispatch, users }) {
  const dispute = trip.dispute;
  const [resolution, setResolution] = React.useState("");
  const [resolving, setResolving] = React.useState(false);
  if (!dispute) return null;
  const filer = users.find(u => u.id?.toString() === dispute.agent_id?.toString());

  const resolve = async (outcome) => {
    if (!resolution.trim()) return;
    setResolving(true);
    await dispatch({ type: "TRIP/RESOLVE_DISPUTE", trip_id: trip.trip_id, outcome, resolution_note: resolution.trim() }).catch(() => {});
    setResolving(false);
  };

  const stateColor = { OPEN: COLORS.red, DRIVER_RESPONDED: COLORS.amber, RESOLVED_UPHELD: COLORS.green, RESOLVED_DISMISSED: COLORS.ghost }[dispute.state] || COLORS.ghost;

  return (
    <div style={{ background: "rgba(220,53,69,0.05)", border: "1px solid rgba(220,53,69,0.25)", borderRadius: 6, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.red }}>⚠ DISPUTE</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: stateColor }}>{dispute.state?.replace(/_/g, " ")}</span>
      </div>
      <div style={{ fontSize: 10, color: COLORS.chalk, fontWeight: 700 }}>{dispute.category}</div>
      <div style={{ fontSize: 10, color: COLORS.ghost }}>{dispute.description}</div>
      <div style={{ fontSize: 9, color: COLORS.ghost }}>Filed by {filer?.name || dispute.agent_id} · {new Date(dispute.filed_at).toLocaleString("en-ZA")}</div>
      {dispute.state === DISPUTE_STATE.OPEN && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          <textarea value={resolution} onChange={e => setResolution(e.target.value)}
            placeholder="Resolution note (required before closing)…" rows={2}
            style={{ fontFamily: "inherit", fontSize: 11, background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: 8, color: COLORS.chalk, resize: "vertical", boxSizing: "border-box", width: "100%" }} />
          <div style={{ display: "flex", gap: 6 }}>
            <Button title="✓ UPHOLD" variant="green" size="sm" style={{ flex: 1 }} onClick={() => resolve("RESOLVED_UPHELD")} disabled={resolving || !resolution.trim()} />
            <Button title="✗ DISMISS" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => resolve("RESOLVED_DISMISSED")} disabled={resolving || !resolution.trim()} />
          </div>
        </div>
      )}
      {dispute.resolution_note && (
        <div style={{ fontSize: 9, color: COLORS.ghost, borderTop: `1px solid ${COLORS.wire}`, paddingTop: 6 }}>
          Resolution: {dispute.resolution_note}
        </div>
      )}
    </div>
  );
}

function forecastDemand(allTrips, targetDateStr, targetTimeStr) {
  if (!targetDateStr || !targetTimeStr) return null;
  const parts = targetDateStr.split("/").map(Number);
  const targetDate = new Date(parts[0], parts[1] - 1, parts[2]);
  const targetDow = targetDate.getDay();
  const [th] = targetTimeStr.split(":").map(Number);
  // Find historical completed trips on same day-of-week within ±1 hour
  const historical = allTrips.filter(t => {
    if (t.state !== TRIP_STATE.ARCHIVED_COMPLETED) return false;
    if (!t.scheduled_date || !t.scheduled_time) return false;
    const p = t.scheduled_date.split("/").map(Number);
    const d = new Date(p[0], p[1] - 1, p[2]);
    if (d.getDay() !== targetDow) return false;
    const rawTime = t.scheduled_time_str || t.scheduled_time || "";
    const rawStr = String(rawTime);
    // If it looks like an epoch (all digits, > 4 chars), convert to HH:MM
    const timeVal = /^\d{10,}$/.test(rawStr.trim())
      ? new Date(Number(rawStr)).toTimeString().slice(0, 5)
      : rawStr;
    const h = parseInt(timeVal.split(":")[0], 10);
    return !isNaN(h) && Math.abs(h - th) <= 1;
  });
  if (historical.length === 0) return { predicted: null, confidence: "LOW", sampleSize: 0 };
  const totalPax = historical.reduce((n, t) => n + (t.agent_ids?.length || 1), 0);
  const predicted = Math.round(totalPax / historical.length);
  const confidence = historical.length >= 8 ? "HIGH" : historical.length >= 4 ? "MEDIUM" : "LOW";
  return { predicted, confidence, sampleSize: historical.length };
}

function CapacityForecastPanel({ state }) {
  // Show forecast for the next 7 days at common time slots
  const slots = [];
  const now = new Date();
  for (let d = 1; d <= 7; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,"0")}/${String(date.getDate()).padStart(2,"0")}`;
    const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][date.getDay()];
    for (const time of ["06:00","07:00","17:00","18:00","21:00"]) {
      const f = forecastDemand(state.trips || [], dateStr, time);
      if (f?.predicted > 0) {
        const driversNeeded = Math.ceil(f.predicted / DRIVER_CAPACITY);
        slots.push({ dateStr, dayName, time, ...f, driversNeeded });
      }
    }
  }
  if (slots.length === 0) return (
    <div style={{ fontSize: 10, color: COLORS.ghost }}>Not enough historical data yet — forecasts appear after 4+ completed trips per time slot.</div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {slots.map((s, i) => {
        const confColor = s.confidence === "HIGH" ? COLORS.green : s.confidence === "MEDIUM" ? COLORS.amber : COLORS.ghost;
        return (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4 }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.chalk }}>{s.dayName} {s.dateStr} @ {s.time}</span>
              <span style={{ fontSize: 9, color: confColor, marginLeft: 8 }}>{s.confidence} confidence ({s.sampleSize} historical runs)</span>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: COLORS.amber, fontFamily: FONTS.head }}>{s.predicted} pax</div>
              <div style={{ fontSize: 9, color: COLORS.ghost }}>{s.driversNeeded} driver{s.driversNeeded !== 1 ? "s" : ""} needed</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isDriverOnShift(ds, scheduledDateStr, scheduledTimeStr) {
  const schedule = ds.availability_schedule;
  if (!schedule || schedule.length === 0) return true; // no schedule = always available
  if (!scheduledDateStr || !scheduledTimeStr) return true; // no trip time = show driver
  // Parse scheduled date into a JS Date to get day-of-week
  const parts = scheduledDateStr.split("/").map(Number); // YYYY/MM/DD
  const tripDate = new Date(parts[0], parts[1] - 1, parts[2]);
  const tripDow = tripDate.getDay(); // 0=Sun
  // Parse trip time "HH:MM"
  const [tripH, tripM] = scheduledTimeStr.split(":").map(Number);
  const tripMins = tripH * 60 + tripM;
  return schedule.some(slot => {
    const [sh, sm] = slot.start.split(":").map(Number);
    const [eh, em] = slot.end.split(":").map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    if (endMins >= startMins) {
      // Normal same-day shift.
      return slot.day === tripDow && tripMins >= startMins && tripMins <= endMins;
    }
    // Shift crosses midnight (e.g. start:"22:00", end:"02:00" — a
    // perfectly normal night shift). endMins < startMins used to make
    // `tripMins >= startMins && tripMins <= endMins` impossible to
    // satisfy for ANY minute of the day, so a night-shift driver was
    // silently treated as off-shift for their entire actual shift,
    // including hours they explicitly configured as available —
    // excluded from real dispatch candidate lists and undercounted in
    // staffing-gap forecasts. A midnight-crossing shift actually covers
    // two segments: the late-night portion on slot.day itself, and the
    // early-morning portion on the calendar day AFTER slot.day.
    const nextDow = (slot.day + 1) % 7;
    return (slot.day === tripDow && tripMins >= startMins)
        || (nextDow === tripDow && tripMins <= endMins);
  });
}

const DAYS_OF_WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function DriverShiftEditor({ ds, dispatch, onClose }) {
  const existing = ds.availability_schedule || [];
  const [slots, setSlots] = React.useState(existing.length > 0 ? existing : []);
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState(null);

  const addSlot = () => setSlots(s => [...s, { day: 1, start: "06:00", end: "22:00" }]);
  const removeSlot = (i) => setSlots(s => s.filter((_, idx) => idx !== i));
  const updateSlot = (i, key, val) => setSlots(s => s.map((sl, idx) => idx === i ? { ...sl, [key]: val } : sl));

  const save = async () => {
    setSaving(true);
    try {
      await dispatch({ type: "DRIVER/SET_SHIFT_SCHEDULE", driver_id: ds.driver_id, schedule: slots });
      onClose();
    } catch (e) {
      setErr(e.message || "Failed to save shift schedule");
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 480, background: COLORS.panel, borderTopLeftRadius: 12, borderTopRightRadius: 12, border: `1px solid ${COLORS.wire}`, borderBottom: "none", padding: 20, display: "flex", flexDirection: "column", gap: 12, maxHeight: "80vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.amber, letterSpacing: 1 }}>⏱ SHIFT SCHEDULE</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.ghost, fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ fontSize: 10, color: COLORS.ghost }}>
          Leave empty = always available. Add blocks for specific days and hours.
        </div>
        {slots.map((sl, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: 8 }}>
            <select value={sl.day} onChange={e => updateSlot(i, "day", +e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "4px 6px", fontSize: 11 }}>
              {DAYS_OF_WEEK.map((d, idx) => <option key={idx} value={idx}>{d}</option>)}
            </select>
            <input type="time" value={sl.start} onChange={e => updateSlot(i, "start", e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "4px 6px", fontSize: 11, flex: 1 }} />
            <span style={{ fontSize: 10, color: COLORS.ghost }}>to</span>
            <input type="time" value={sl.end} onChange={e => updateSlot(i, "end", e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "4px 6px", fontSize: 11, flex: 1 }} />
            <button onClick={() => removeSlot(i)} style={{ background: "none", border: "none", color: COLORS.red, fontSize: 14, cursor: "pointer", flexShrink: 0 }}>✕</button>
          </div>
        ))}
        <Button title="+ ADD SHIFT BLOCK" variant="ghost" onClick={addSlot} full />
        {err && <div style={{ fontSize: 10, color: COLORS.red }}>{err}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving} />
          <Button title={saving ? "SAVING…" : "✓ SAVE SCHEDULE"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={saving} />
        </div>
      </div>
    </div>
  );
}

const BACKUP_VERIFY_KEY = "transitos_last_backup_verify";

async function verifyDatabaseConnection() {
  const start = Date.now();
  try {
    if (!supabase) throw new Error("Supabase not configured");
    const { data, error } = await supabase
      .from("trips")
      .select("id")
      .limit(1);
    if (error) throw error;
    const ms = Date.now() - start;
    const result = { ok: true, ms, checkedAt: Date.now(), tripCount: null };
    // Also get a count to verify read access is real
    const { count } = await supabase.from("trips").select("*", { count: "exact", head: true });
    result.tripCount = count;
    try { localStorage.setItem(BACKUP_VERIFY_KEY, JSON.stringify(result)); } catch {}
    return result;
  } catch (e) {
    const result = { ok: false, error: e.message, checkedAt: Date.now() };
    try { localStorage.setItem(BACKUP_VERIFY_KEY, JSON.stringify(result)); } catch {}
    return result;
  }
}

function BackupVerifyPanel() {
  const [last, setLast] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(BACKUP_VERIFY_KEY) || "null"); } catch { return null; }
  });
  const [checking, setChecking] = React.useState(false);

  const check = async () => {
    setChecking(true);
    const result = await verifyDatabaseConnection();
    setLast(result);
    setChecking(false);
  };

  const age = last ? Math.round((Date.now() - last.checkedAt) / 60000) : null;
  const ageStr = age == null ? "Never checked" : age < 60 ? `${age}m ago` : age < 1440 ? `${Math.round(age/60)}h ago` : `${Math.round(age/1440)}d ago`;

  return (
    <div style={{ background: "rgba(29,185,84,0.05)", border: `1px solid ${last?.ok === false ? "rgba(220,53,69,0.4)" : "rgba(29,185,84,0.2)"}`, borderRadius: 6, padding: "10px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green }}>🛡 DATABASE HEALTH CHECK</div>
          <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>
            {last == null && "Not yet verified this session."}
            {last?.ok === true && `✓ Connected — ${last.tripCount != null ? last.tripCount + " trips" : ""} — ${last.ms}ms — ${ageStr}`}
            {last?.ok === false && `✗ Error: ${last.error} — ${ageStr}`}
          </div>
          <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>
            Physical backups managed by Supabase. Check your project dashboard → Settings → Backups for schedule.
          </div>
        </div>
        <Button title={checking ? "CHECKING…" : "▶ RUN CHECK"} variant="ghost" size="sm"
          style={{ borderColor: COLORS.green, color: COLORS.green, flexShrink: 0 }}
          onClick={check} disabled={checking} />
      </div>
    </div>
  );
}

function DriverHoursSummary({ driverId, trips }) {
  const hoursToday = computeDriverHoursToday(driverId, trips);
  const hoursWeek = computeDriverHoursThisWeek(driverId, trips);
  const overDay = hoursToday >= MAX_DRIVER_HOURS_PER_DAY;
  const overWeek = hoursWeek >= MAX_DRIVER_HOURS_PER_WEEK;
  const nearDay = !overDay && hoursToday >= MAX_DRIVER_HOURS_PER_DAY * 0.8;
  const nearWeek = !overWeek && hoursWeek >= MAX_DRIVER_HOURS_PER_WEEK * 0.8;
  const color = (over, near) => over ? COLORS.red : near ? COLORS.amber : COLORS.ghost;
  return (
    <div style={{ fontSize: 8, marginTop: 2, display: "flex", gap: 10 }}>
      <span style={{ color: color(overDay, nearDay), fontWeight: overDay ? 700 : 400 }}>
        {overDay ? "⚠ " : ""}Hours today: {hoursToday.toFixed(1)}h / {MAX_DRIVER_HOURS_PER_DAY}h
      </span>
      <span style={{ color: color(overWeek, nearWeek), fontWeight: overWeek ? 700 : 400 }}>
        {overWeek ? "⚠ " : ""}This week: {hoursWeek.toFixed(1)}h / {MAX_DRIVER_HOURS_PER_WEEK}h
      </span>
    </div>
  );
}

function DriverDocSummary({ ds }) {
  const docs = ds.documents || {};
  const issues = DOC_TYPES.map(d => ({ ...d, ...docExpiryStatus(docs[d.key]), date: docs[d.key] }))
    .filter(d => d.status !== "ok");
  if (issues.length === 0) return (
    <span style={{ fontSize: 8, color: COLORS.green, fontWeight: 700 }}>✓ DOCS OK</span>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {issues.map(d => (
        <span key={d.key} style={{ fontSize: 8, fontWeight: 700, color: d.status === "expired" ? COLORS.red : COLORS.amber }}>
          {d.status === "expired" ? "✗" : "⚠"} {d.label}: {d.status === "missing" ? "NOT SET" : d.status === "expired" ? `EXPIRED ${Math.abs(d.daysLeft)}d ago` : `expires in ${d.daysLeft}d`}
        </span>
      ))}
    </div>
  );
}

function DriverDocEditor({ ds, dispatch, onClose }) {
  const existing = ds.documents || {};
  const [docs, setDocs] = React.useState({ prdp: existing.prdp || "", licence: existing.licence || "", roadworthy: existing.roadworthy || "" });
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await dispatch({ type: "DRIVER/SET_DOCUMENTS", driver_id: ds.driver_id, documents: docs });
      onClose();
    } catch(e) { setSaving(false); }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 480, background: COLORS.panel, borderTopLeftRadius: 12, borderTopRightRadius: 12, border: `1px solid ${COLORS.wire}`, borderBottom: "none", padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.amber, letterSpacing: 1 }}>📄 DRIVER DOCUMENTS</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.ghost, fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>
        {DOC_TYPES.map(d => (
          <div key={d.key}>
            <label style={{ fontSize: 9, fontWeight: 700, color: COLORS.chalk, letterSpacing: 0.5, display: "block", marginBottom: 4 }}>
              {d.label} EXPIRY {d.required ? "*" : ""}
            </label>
            <input type="date" value={docs[d.key]} onChange={e => setDocs(v => ({ ...v, [d.key]: e.target.value }))}
              style={{ width: "100%", background: COLORS.card, border: `1px solid ${docExpiryStatus(docs[d.key]).status === "expired" ? COLORS.red : docExpiryStatus(docs[d.key]).status === "expiring" ? COLORS.amber : COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "7px 10px", fontSize: 12, boxSizing: "border-box" }} />
            {docs[d.key] && (() => { const s = docExpiryStatus(docs[d.key]); return s.status !== "ok" ? (
              <div style={{ fontSize: 9, color: s.status === "expired" ? COLORS.red : COLORS.amber, marginTop: 2 }}>
                {s.status === "expired" ? "Expired " + Math.abs(s.daysLeft) + " days ago" : "Expires in " + s.daysLeft + " days"}
              </div>
            ) : null; })()}
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} disabled={saving} />
          <Button title={saving ? "SAVING…" : "✓ SAVE"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={saving} />
        </div>
      </div>
    </div>
  );
}

async function exportComplianceAudit(trips, users, auditLogs, fromDateStr, toDateStr, delaysByTrip = {}) {
  const headers = [
    "Trip ID","Date","Time","Direction","Driver","Agent(s)","Status",
    "Exception","Booked At","Driver Assigned At","Driver Accepted At",
    "Trip Started At","Completed At","Rejection Reason","Rejection Note",
    // "Actual Distance", not "Route km" — FOUND VIA /code-review: this
    // column used to show the planned/estimated route (available before
    // completion), now shows only the real post-trip GPS distance (blank
    // for anything not yet completed), so the old header name was left
    // describing the wrong thing on a document used for regulatory
    // submissions.
    "No-Show Count","Delay Reports","Actual Distance (km)","Audit Actions",
  ];

  // Type-safe ID comparison — bigint vs string vs number all normalised to string
  const idEq = (a, b) => String(a) === String(b);

  const agentNames = (t) => (t.agent_ids || [])
    .map(id => users.find(u => idEq(u.id, id))?.name || String(id)).join(" | ");
  const driverName = (t) => {
    if (!t.driver_id) return "";
    return users.find(u => idEq(u.id, t.driver_id))?.name || String(t.driver_id);
  };
  const fmtEpoch = (ep) => {
    if (!ep) return "";
    // timeZone pinned explicitly — "en-ZA" only controls the DD/MM/YYYY
    // string FORMAT, not which timezone the epoch is converted through,
    // which otherwise silently follows the exporting device's own OS
    // clock. This export is for regulatory/compliance submissions, so a
    // misconfigured or traveling admin's device must never silently shift
    // every timestamp in the file. Africa/Johannesburg = SAST (UTC+2,
    // no DST), matching Cape Town year-round.
    try { return new Date(Number(ep)).toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" }); } catch { return String(ep); }
  };

  const inRange = trips.filter(t => {
    const d = (t.scheduled_date || "").replace(/\//g, "-");
    const f = fromDateStr.replace(/\//g, "-");
    const to2 = toDateStr.replace(/\//g, "-");
    return d >= f && d <= to2;
  });

  if (inRange.length === 0) {
    alert("No trips found in the selected date range.");
    return;
  }

  // auditLogs from fetchAuditLogsForTrips is a { [tripId]: entries[] } object
  // Normalise to handle both object and array inputs defensively
  const getAuditForTrip = (tripId) => {
    if (!auditLogs) return [];
    if (Array.isArray(auditLogs)) {
      return auditLogs.filter(a => idEq(a.trip_id ?? a.tripid, tripId));
    }
    // Object keyed by tripid (the normal case from fetchAuditLogsForTrips)
    return auditLogs[tripId] || auditLogs[String(tripId)] || [];
  };

  const rows = inRange.map(t => {
    const tripAuditEntries = getAuditForTrip(t.trip_id);
    const auditSummary = tripAuditEntries.map(a =>
      `[${fmtEpoch(a.timestamp)}] ${a.username || a.actor_name || ""}: ${a.actionType || a.action_type || ""}${a.details ? " - " + a.details : ""}`
    ).join(" | ");

    // Trips never carry a `delays` field — real delay/detour reports live
    // in the trip_delays table and must be fetched separately (see
    // fetchDelaysForTrips, already used the same way by the main trip CSV
    // export). This read `t.delays` directly, which is undefined on every
    // trip object in this codebase, so the "Delay Reports" column always
    // silently showed nothing — on a document whose own UI copy explicitly
    // promises delay reports for regulatory submissions.
    const tripDelays = delaysByTrip[t.trip_id] || [];
    const delaySummary = tripDelays.map(d =>
      `${d.reason}${d.note ? ` (${d.note})` : ""} @ ${fmtEpoch(d.reported_at)}`
    ).join(" | ");

    return [
      t.trip_id,
      t.scheduled_date || "",
      t.scheduled_time || "",
      t.direction || "",
      driverName(t),
      agentNames(t),
      t.state || "",
      exceptionLabel(t) || "",
      t.booked_at || "",
      t.confirmed_at || "",
      t.acceptedAt || "",
      t.in_transit_at || "",
      t.completed_at || "",
      t.rejection_reason || "",
      t.rejection_note || "",
      (t.no_shows || []).length,
      delaySummary,
      // Only the real, post-trip GPS-measured distance — per explicit
      // request, no pre-trip route figure at all (not even the real
      // TomTom-computed one) shown in this column anymore.
      t.actual_distance_km ?? "",
      auditSummary,
    ].map(csvEscapeCell);
  });

  // Pinned to SAST — see fmtEpoch above for why this document's timestamps
  // can't be allowed to silently follow the exporting device's own clock.
  const now = new Date().toLocaleString("en-ZA", { timeZone: "Africa/Johannesburg" });
  const csvLines = [
    csvEscapeCell(`# Pearce & Sons Compliance Audit Export — Generated: ${now}`),
    csvEscapeCell(`# Period: ${fromDateStr} to ${toDateStr} — Trips: ${inRange.length}`),
    "# This document constitutes a complete operational audit trail.",
    "",
    headers.join(","),
    ...rows.map(r => r.join(",")),
  ];
  const csv = csvLines.join("\r\n"); // CRLF for Excel compatibility

  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }); // BOM for Excel
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", `compliance_audit_${fromDateStr.replace(/\//g, "-")}_to_${toDateStr.replace(/\//g, "-")}.csv`);
  document.body.appendChild(a); // required for Firefox
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AuditExportPanel({ state }) {
  const [from, setFrom] = React.useState(() => shiftDateStr(sastTodayStr(), { days: -30 }));
  const [to, setTo] = React.useState(sastTodayStr);
  const [exporting, setExporting] = React.useState(false);

  const doExport = async () => {
    setExporting(true);
    try {
      // Fetch audit logs for all trips in range
      const inRange = state.trips.filter(t => {
        const d = (t.scheduled_date || "").replace(/\//g, "-");
        return d >= from && d <= to;
      });
      const tripIds = inRange.map(t => t.trip_id).filter(Boolean);
      const auditLogs = tripIds.length > 0 ? await fetchAuditLogsForTrips(tripIds) : [];
      const delaysByTrip = tripIds.length > 0 ? await fetchDelaysForTrips(tripIds) : {};
      await exportComplianceAudit(state.trips, state.users, auditLogs, from.replace(/-/g,"/"), to.replace(/-/g,"/"), delaysByTrip);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ background: "rgba(29,185,84,0.05)", border: "1px solid rgba(29,185,84,0.2)", borderRadius: 6, padding: "10px 14px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green, marginBottom: 8 }}>📋 COMPLIANCE AUDIT EXPORT</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "5px 8px", fontSize: 11 }} />
        <span style={{ fontSize: 10, color: COLORS.ghost }}>to</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "5px 8px", fontSize: 11 }} />
        <Button title={exporting ? "EXPORTING…" : "⬇ EXPORT CSV"} variant="ghost" size="sm"
          style={{ borderColor: COLORS.green, color: COLORS.green }} onClick={doExport} disabled={exporting} />
      </div>
      <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 6 }}>
        Includes all trip actions, GPS timestamps, exceptions, rejections, and delay reports. Suitable for regulatory submissions.
      </div>
    </div>
  );
}

function computeSchedulingRecommendations(trips, driverStatus, companies, now = new Date()) {
  const gaps = [];

  // For each of the next 7 days
  for (let d = 1; d <= 7; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dow = date.getDay(); // 0=Sun
    const dateStr = `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,"0")}/${String(date.getDate()).padStart(2,"0")}`;
    const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dow];

    // Check common time slots
    for (const timeStr of ["06:00","07:00","17:00","18:00","21:00","22:00"]) {
      const [th] = timeStr.split(":").map(Number);
      // Historical demand: completed trips on this dow ± 1h
      const historical = trips.filter(t => {
        if (t.state !== TRIP_STATE.ARCHIVED_COMPLETED) return false;
        if (!t.scheduled_date) return false;
        const p = t.scheduled_date.split("/").map(Number);
        const td = new Date(p[0], p[1]-1, p[2]);
        if (td.getDay() !== dow) return false;
        const rawTimeSched = t.scheduled_time_str || t.scheduled_time || "00:00";
        const rawStrSched = String(rawTimeSched);
        const timeValSched = /^\d{10,}$/.test(rawStrSched.trim())
          ? new Date(Number(rawStrSched)).toTimeString().slice(0, 5) : rawStrSched;
        const h = parseInt(timeValSched.split(":")[0], 10);
        return !isNaN(h) && Math.abs(h - th) <= 1;
      });
      if (historical.length < 3) continue; // need at least 3 data points

      const avgPax = historical.reduce((n, t) => n + (t.agent_ids?.length || 1), 0) / historical.length;
      const driversNeeded = Math.ceil(avgPax / DRIVER_CAPACITY);

      // Count drivers rostered for this slot
      const rosteredCount = (driverStatus || []).filter(ds =>
        isDriverOnShift(ds, dateStr, timeStr) && !ds.is_unavailable
      ).length;

      if (rosteredCount < driversNeeded) {
        gaps.push({
          date: dateStr, dayName, time: timeStr,
          driversNeeded, rosteredCount,
          shortfall: driversNeeded - rosteredCount,
          avgPax: Math.round(avgPax),
          sampleSize: historical.length,
        });
      }
    }
  }
  return gaps.sort((a, b) => a.date.localeCompare(b.date));
}

function SmartSchedulingPanel({ state }) {
  // Only the calendar DAY matters here (which of the next 7 days each gap
  // falls on) — a 30-minute tick is more than enough to keep this from
  // drifting stale across a midnight rollover. See useTicker's own header
  // comment for why a memo reading wall-clock time needs this at all.
  const nowTick = useTicker(30 * 60 * 1000);
  const gaps = React.useMemo(() =>
    computeSchedulingRecommendations(state.trips || [], state.driver_status || [], state.companies || [], new Date(nowTick)),
    [state.trips, state.driver_status, state.companies, nowTick]
  );
  if (gaps.length === 0) return (
    <div style={{ fontSize: 10, color: COLORS.ghost }}>
      ✓ No staffing gaps detected in the next 7 days — or not enough historical data yet (need 3+ trips per time slot).
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {gaps.map((gap, i) => (
        <div key={i} style={{ background: "rgba(245,166,35,0.06)", border: "1px solid rgba(245,166,35,0.25)", borderRadius: 4, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.amber }}>
              {gap.dayName} {gap.date} @ {gap.time}
            </div>
            <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>
              Avg {gap.avgPax} passengers ({gap.sampleSize} historical runs) · {gap.rosteredCount}/{gap.driversNeeded} drivers rostered
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: COLORS.red, fontFamily: FONTS.head }}>
              -{gap.shortfall}
            </div>
            <div style={{ fontSize: 8, color: COLORS.ghost }}>driver{gap.shortfall !== 1 ? "s" : ""} short</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function computeWeeklySummary(trips, users, driverStatus, now = Date.now()) {
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const lastWeek = trips.filter(t => {
    // Use raw epoch fields — booked_at and in_transit_at are display strings
    const d = t.booked_at_epoch || t.in_transit_at_epoch || 0;
    return Number(d) >= sevenDaysAgo;
  });

  const completed = lastWeek.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED);
  const cancelled = lastWeek.filter(t => t.state === TRIP_STATE.ARCHIVED_CANCELLED);
  const exceptions = lastWeek.filter(t => t.is_exception);
  const rejections = lastWeek.filter(t => t.rejection_reason);
  const noShows = lastWeek.filter(t => (t.no_shows || []).length > 0);
  const totalPax = completed.reduce((n, t) => n + (t.agent_ids?.length || 1), 0);
  // Real distance only, per explicit request — no estimate fallback in
  // this DISPLAY total (unlike driver pay, which deliberately keeps one
  // internally). `!= null` rather than `||`, so a genuine 0 doesn't get
  // treated as missing.
  const routeKmFor = (t) => t.actual_distance_km != null ? t.actual_distance_km : 0;
  const totalKm = completed.reduce((n, t) => n + routeKmFor(t), 0);

  // Per-driver stats for the week
  const driverStats = {};
  for (const t of completed) {
    if (!t.driver_id) continue;
    if (!driverStats[t.driver_id]) {
      const u = users.find(u => String(u.id) === String(t.driver_id));
      driverStats[t.driver_id] = { name: u?.name || t.driver_id, trips: 0, pax: 0, km: 0, rejections: 0 };
    }
    driverStats[t.driver_id].trips++;
    driverStats[t.driver_id].pax += (t.agent_ids?.length || 1);
    driverStats[t.driver_id].km += routeKmFor(t);
  }
  for (const t of rejections) {
    if (!t.rejection_driver_id) continue;
    if (!driverStats[t.rejection_driver_id]) {
      const u = users.find(u => String(u.id) === String(t.rejection_driver_id));
      driverStats[t.rejection_driver_id] = { name: u?.name || t.rejection_driver_id, trips: 0, pax: 0, km: 0, rejections: 0 };
    }
    driverStats[t.rejection_driver_id].rejections++;
  }

  const driverRows = Object.values(driverStats).sort((a, b) => b.trips - a.trips);
  const topDriver = driverRows[0] || null;
  const worstRejector = [...driverRows].sort((a, b) => b.rejections - a.rejections).find(d => d.rejections > 0);

  // Compliance flags
  const onlineDrivers = (driverStatus || []).filter(d => d.is_online).length;
  const expiredDocs = (driverStatus || []).filter(d => {
    const docs = d.documents || {};
    return DOC_TYPES.some(dt => docExpiryStatus(docs[dt.key]).status === "expired");
  }).length;

  return {
    period: "Last 7 days",
    completedTrips: completed.length,
    cancelledTrips: cancelled.length,
    totalPax,
    totalKm: Math.round(totalKm),
    exceptions: exceptions.length,
    rejections: rejections.length,
    noShows: noShows.length,
    topDriver,
    worstRejector,
    expiredDocs,
    onlineDrivers,
    driverRows,
  };
}

function formatWeeklySummaryText(s) {
  const lines = [
    `Pearce & Sons — Weekly Ops Summary (${s.period})`,
    `========================================`,
    `Trips completed:   ${s.completedTrips}`,
    `Trips cancelled:   ${s.cancelledTrips}`,
    `Passengers moved:  ${s.totalPax}`,
    `Total km driven:   ${s.totalKm} km`,
    ``,
    `Exceptions:        ${s.exceptions}`,
    `Driver rejections: ${s.rejections}`,
    `No-shows:          ${s.noShows}`,
    ``,
    `Top driver:        ${s.topDriver ? s.topDriver.name + " — " + s.topDriver.trips + " trips, " + s.topDriver.pax + " pax" : "N/A"}`,
    s.worstRejector ? `⚠ Rejections:     ${s.worstRejector.name} (${s.worstRejector.rejections} rejection${s.worstRejector.rejections !== 1 ? "s" : ""} this week)` : "",
    s.expiredDocs > 0 ? `🚨 Expired docs:  ${s.expiredDocs} driver${s.expiredDocs !== 1 ? "s" : ""} with expired documents` : "",
    ``,
    `Generated by Pearce & Sons on ${new Date().toLocaleDateString("en-ZA")}`,
  ].filter(l => l !== undefined);
  return lines.join("\n");
}

function WeeklyOpsSummaryPanel({ state }) {
  const [copied, setCopied] = React.useState(false);
  // Only the rolling 7-day WINDOW BOUNDARY matters here — a 30-minute
  // tick is more than enough to keep "last 7 days" from drifting stale.
  // See useTicker's own header comment for why a memo reading wall-clock
  // time needs this at all.
  const nowTick = useTicker(30 * 60 * 1000);
  const s = React.useMemo(() =>
    computeWeeklySummary(state.trips || [], state.users || [], state.driver_status || [], nowTick),
    [state.trips, state.users, state.driver_status, nowTick]
  );
  const text = formatWeeklySummaryText(s);
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 3000); });
  };

  return (
    <div style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, borderRadius: 6, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: COLORS.chalk, letterSpacing: 0.5 }}>📊 WEEKLY OPS SUMMARY</span>
        <div style={{ display: "flex", gap: 6 }}>
          <Button title={copied ? "✓ COPIED" : "📋 COPY FOR EMAIL"} variant="ghost" size="sm"
            style={{ borderColor: copied ? COLORS.green : COLORS.wire, color: copied ? COLORS.green : COLORS.ghost }}
            onClick={copy} />
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {[
          ["TRIPS DONE", s.completedTrips, COLORS.green],
          ["PASSENGERS", s.totalPax, COLORS.chalk],
          ["KM DRIVEN", s.totalKm, COLORS.chalk],
          ["EXCEPTIONS", s.exceptions, s.exceptions > 0 ? COLORS.amber : COLORS.ghost],
          ["REJECTIONS", s.rejections, s.rejections > 0 ? COLORS.red : COLORS.ghost],
          ["NO-SHOWS", s.noShows, s.noShows > 0 ? COLORS.amber : COLORS.ghost],
        ].map(([label, val, color]) => (
          <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: "5px 10px", minWidth: 80 }}>
            <div style={{ fontSize: 8, color: COLORS.ghost, letterSpacing: 0.8 }}>{label}</div>
            <div style={{ fontSize: 15, fontWeight: 800, color, fontFamily: FONTS.head }}>{val}</div>
          </div>
        ))}
      </div>
      {s.topDriver && (
        <div style={{ fontSize: 10, color: COLORS.ghost }}>
          🏆 Top driver: <span style={{ color: COLORS.green, fontWeight: 700 }}>{s.topDriver.name}</span> — {s.topDriver.trips} trips, {s.topDriver.pax} passengers, {Math.round(s.topDriver.km)} km
        </div>
      )}
      {s.worstRejector && (
        <div style={{ fontSize: 10, color: COLORS.amber }}>
          ⚠ Most rejections: {s.worstRejector.name} ({s.worstRejector.rejections} this week)
        </div>
      )}
      {s.expiredDocs > 0 && (
        <div style={{ fontSize: 10, color: COLORS.red, fontWeight: 700 }}>
          🚨 {s.expiredDocs} driver{s.expiredDocs !== 1 ? "s" : ""} with expired documents — check Drivers tab
        </div>
      )}
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        To automate Monday morning emails, deploy the Pearce & Sons weekly-summary Edge Function (see docs).
      </div>
    </div>
  );
}

// Time: candidate bookings' scheduled_time must be within this many
// minutes of the anchor booking's scheduled_time. A booking missing
// scheduled_time is treated as compatible (mirrors isDriverOnShift's
// "no trip time = always available" tolerance, AdminSection.jsx:288).
const GROUP_SUGGESTION_TIME_WINDOW_MIN = 25;

function scheduledTimeToMinutes(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// Shared by computeGroupSuggestions and AdminTrips' search — both need an
// O(1) id → user lookup over the same users list. FOUND VIA /code-review
// (4th pass): AdminTrips had re-inlined this exact Map-building line
// rather than reusing this one.
export function usersByIdMap(users) {
  return new Map(users.map(u => [String(u.id), u]));
}

// Resolves the ONE company a booking belongs to via its first agent's
// branch_id — same field scopeTripsToCompany (AdminSection.jsx:95-100)
// reads. Bookings pre-dispatch normally carry exactly one agent, so
// agent_ids[0] is a safe anchor.
function bookingCompanyId(usersById, trip) {
  const agentId = trip.agent_ids?.[0];
  if (agentId == null) return null;
  return usersById.get(String(agentId))?.branch_id ?? null;
}

// Resolves the agent's home AREA — direction-agnostic, since home is the
// pickup point for INBOUND and the drop-off point for OUTBOUND, so "same
// home area" is the right grouping signal either way without branching
// on trip.direction here. FOUND VIA explicit correction: raw distance
// (the old `haversineKm(...) <= 8` gate) was replaced with this — same
// field the existing manual area filter already relies on.
function bookingHomeArea(usersById, trip) {
  const agentId = trip.agent_ids?.[0];
  if (agentId == null) return null;
  return usersById.get(String(agentId))?.home_address?.area || null;
}

// Distance used only as a secondary ranking signal (not a gate) among
// candidates that already passed the area/company/time checks — pickup
// coord for INBOUND, drop-off coord for OUTBOUND, matching whichever leg
// actually varies per agent in that direction.
function bookingRankCoord(trip) {
  return trip.direction === "OUTBOUND" ? trip.dropoff_sequence_coords?.[0] : trip.pickup_sequence_coords?.[0];
}

export function computeGroupSuggestions(unassigned, users = [], driverStatus = []) {
  const usersById = usersByIdMap(users);
  const suggestions = [];
  const used = new Set();

  for (let i = 0; i < unassigned.length; i++) {
    if (used.has(i)) continue;
    const a = unassigned[i];
    const aArea = bookingHomeArea(usersById, a);
    if (!aArea) continue; // can't safely group without a resolved home area
    const aCompanyId = bookingCompanyId(usersById, a);
    if (aCompanyId == null) continue;
    const aTimeMin = scheduledTimeToMinutes(a.scheduled_time);
    const aRankCoord = bookingRankCoord(a);

    // Dynamic capacity cap — replaces the old hard-coded 4. Prefers the
    // largest vehicle among drivers on shift for THIS booking's
    // date/time (isDriverOnShift, AdminSection.jsx:285), falls back to
    // the largest vehicle in the whole fleet, falls back to
    // DRIVER_CAPACITY if driver_status is empty.
    const onShiftCaps = driverStatus
      .filter(ds => isDriverOnShift(ds, a.scheduled_date, a.scheduled_time))
      .map(ds => ds.capacity || DRIVER_CAPACITY);
    const fleetCaps = driverStatus.map(ds => ds.capacity || DRIVER_CAPACITY);
    const groupCap = onShiftCaps.length ? Math.max(...onShiftCaps)
      : (fleetCaps.length ? Math.max(...fleetCaps) : DRIVER_CAPACITY);

    // Collect every valid candidate, then sort by distance — the old
    // version grabbed whichever match appeared first in raw array
    // order, which could skip a genuinely closer booking sitting a few
    // slots further down the unassigned list.
    const candidates = [];
    for (let j = i + 1; j < unassigned.length; j++) {
      if (used.has(j)) continue;
      const b = unassigned[j];
      if (b.scheduled_date !== a.scheduled_date) continue;
      if (b.direction !== a.direction) continue;
      const bTimeMin = scheduledTimeToMinutes(b.scheduled_time);
      if (aTimeMin != null && bTimeMin != null && Math.abs(aTimeMin - bTimeMin) > GROUP_SUGGESTION_TIME_WINDOW_MIN) continue;
      const bCompanyId = bookingCompanyId(usersById, b);
      if (bCompanyId == null || bCompanyId !== aCompanyId) continue;
      const bArea = bookingHomeArea(usersById, b);
      if (!bArea || bArea !== aArea) continue;
      const bRankCoord = bookingRankCoord(b);
      const distKm = (aRankCoord?.lat != null && bRankCoord?.lat != null)
        ? haversineKm(aRankCoord.lat, aRankCoord.lng, bRankCoord.lat, bRankCoord.lng)
        : Infinity; // no coord = ranked last, but still eligible on area/company/time
      candidates.push({ idx: j, trip: b, distKm });
    }
    candidates.sort((x, y) => x.distKm - y.distKm);

    const group = [a];
    const groupIdxs = [i];
    // String-normalized ids — Supabase bigint agent ids can surface as
    // either number or string across hydration paths; a raw Set.has()
    // would silently miss a 123 vs "123" overlap and merge two bookings
    // that share an agent (same id-comparison class as fetchMyConversations).
    const groupAgentIds = new Set((a.agent_ids || []).map(String));
    for (const c of candidates) {
      if (group.length >= groupCap) break;
      // Tracked cumulatively against every agent already in the group,
      // not just the anchor's agents, so a booking sharing an agent
      // with an already-added 2nd/3rd member can't slip in either.
      const hasOverlap = (c.trip.agent_ids || []).some(id => groupAgentIds.has(String(id)));
      if (hasOverlap) continue;
      group.push(c.trip);
      groupIdxs.push(c.idx);
      (c.trip.agent_ids || []).forEach(id => groupAgentIds.add(String(id)));
    }

    if (group.length >= 2) {
      groupIdxs.forEach(idx => used.add(idx));
      const totalPax = group.reduce((n, t) => n + (t.agent_ids?.length || 1), 0);
      const timeLabels = group.map(t => t.scheduled_time).filter(Boolean).sort();
      suggestions.push({
        trips: group, totalPax, date: a.scheduled_date, direction: a.direction,
        companyId: aCompanyId, area: aArea,
        earliestTime: timeLabels[0] || null, latestTime: timeLabels[timeLabels.length - 1] || null,
      });
    }
  }
  return suggestions;
}

function scoreDriverForTrip(ds, u, distKm, tripAgentIds, trips) {
  let score = 0;
  const proxScore = distKm != null ? Math.max(0, 40 - (distKm / 30) * 40) : 0;
  score += proxScore;
  const cap = ds.capacity || DRIVER_CAPACITY;
  const load = trips.filter(t =>
    String(t.driver_id) === String(ds.driver_id) &&
    [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)
  ).reduce((n, t) => n + Math.max(1, t.agent_ids?.length || 0), 0);
  score += Math.max(0, 30 - (load / cap) * 30);
  const driverTrips = trips.filter(t => String(t.driver_id) === String(ds.driver_id) || (t.declinedBy || []).some(id => String(id) === String(ds.driver_id)));
  const completed = driverTrips.filter(t => String(t.driver_id) === String(ds.driver_id) && t.state === TRIP_STATE.ARCHIVED_COMPLETED).length;
  const declined = driverTrips.filter(t => (t.declinedBy || []).some(id => String(id) === String(ds.driver_id))).length;
  const total = completed + declined;
  const acceptRate = total > 0 ? completed / total : 1;
  score += acceptRate * 20;
  const agentSet = new Set((tripAgentIds || []).map(String));
  const prevDeclinedThisAgent = trips.some(t =>
    (t.declinedBy || []).some(id => String(id) === String(ds.driver_id)) &&
    (t.agent_ids || []).some(aid => agentSet.has(String(aid)))
  );
  if (prevDeclinedThisAgent) score -= 10;
  return { score: Math.round(Math.max(0, Math.min(100, score))), proxScore: Math.round(proxScore), load, acceptRate, prevDeclinedThisAgent };
}

async function tomtomGeocodeAddress(address) {
  if (!TOMTOM_API_KEY || !address?.trim()) return null;
  try {
    const url = `https://api.tomtom.com/search/2/geocode/${encodeURIComponent(address)}.json` +
      `?key=${TOMTOM_API_KEY}&countrySet=ZA&limit=1`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TomTom geocode returned ${res.status}`);
    const data = await res.json();
    const r = data.results?.[0];
    if (!r) return null;
    return {
      label: r.address?.freeformAddress || address,
      area: r.address?.municipalitySubdivision || r.address?.municipality || "Cape Town",
      lat: r.position?.lat, lng: r.position?.lon,
      source: "tomtom-geocoding",
    };
  } catch (e) {
    console.warn("[TomTom] geocoding failed:", e.message);
    return null;
  }
}

async function streetNameSearch(query) {
  if (!supabase || !query || query.trim().length < 2) return [];
  const q = query.trim().toUpperCase();
  try {
    const { data, error } = await supabase
      .from("cape_town_street_names")
      .select("street_name")
      .like("street_name_upper", `${q}%`)
      .order("street_name")
      .limit(8);
    if (error) {
      console.warn("[StreetNames] query failed:", error.message);
      return [];
    }
    return (data || []).map(r => r.street_name);
  } catch (e) {
    console.warn("[StreetNames] query failed:", e.message);
    return [];
  }
}

async function fetchAuditLogsForTrips(tripIds) {
  if (!tripIds.length) return {};
  const { data, error } = await supabase.from("audit_logs").select("*").in("tripid", tripIds).order("timestamp", { ascending: true });
  if (error) return {};
  const byTrip = {};
  (data || []).forEach(a => {
    (byTrip[a.tripid] ||= []).push({ actionType: a.actiontype, username: a.username, details: a.details, timestamp: a.timestamp });
  });
  return byTrip;
}

// Fetches EVERY audit_logs entry in a date range, not just trip-linked
// ones — powers AdminActivityLog. Distinct from fetchAuditLogsForTrips
// above (which only ever surfaces entries with a tripid via `.in("tripid",
// ...)`), so the 17+ non-trip action types this app already logs — user
// CRUD, company/fee-rate edits, DMs, announcements, driver docs/shifts —
// were being recorded but were permanently unreachable in the app; the
// only UI surface that ever read audit_logs was the trip-scoped one.
// Capped at 1000 rows, same resource-conscious pattern as
// fetchTripHistory's 500-row cap — this is an on-demand, admin-triggered
// query (Run Search button), never polled.
async function fetchAuditLogsRange({ fromMs, toMs, limit = 1000 } = {}) {
  let q = supabase.from("audit_logs").select("*").order("timestamp", { ascending: false }).limit(limit);
  if (fromMs != null) q = q.gte("timestamp", fromMs);
  if (toMs != null) q = q.lte("timestamp", toMs);
  const { data, error } = await q;
  if (error) throw error;
  // issuccess isn't included — every logAuditAction call site (src/
  // TransitOS_web.jsx) unconditionally writes true, so it can never
  // actually be false today; surfacing it here would imply failure
  // detection this app doesn't have yet.
  return (data || []).map(a => ({
    id: a.id, actionType: a.actiontype || "UNKNOWN", username: a.username, actorId: a.actordetails,
    details: a.details, timestamp: a.timestamp, tripId: a.tripid, targetUserId: a.targetuserid,
  }));
}

// The part before "/" in actionType (e.g. "TRIP", "ADMIN", "DM") — used to
// group/filter the activity log by category without a hardcoded list of
// every action type, so a newly-added logAuditAction call site is
// automatically grouped correctly with no changes needed here.
export function auditLogCategory(actionType) {
  return (actionType || "").split("/")[0] || "OTHER";
}

// SAST midnight (00:00) of a "YYYY-MM-DD" date string, as a UTC epoch ms —
// same fixed +2h SAST offset every edge function in this project already
// applies (see e.g. monthly-billing-export's identical -2*3600000
// correction). Used by AdminActivityLog's date-range search so the fetch
// window agrees with auditLogPeriodKey's own SAST-pinned bucketing below.
export function sastMidnightMs(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 2 * 3600000;
}

// Today's date in SAST, as "YYYY-MM-DD" — used for AdminActivityLog's
// default range and quick-range buttons so they agree with sastMidnightMs/
// auditLogPeriodKey's own SAST-pinned day boundary, instead of
// `new Date().toISOString()`'s UTC calendar day (which is a different,
// wrong day for up to 2 hours after SAST midnight).
// Reused across sastTodayStr and auditLogPeriodKey instead of
// constructing a new Intl.DateTimeFormat per call — auditLogPeriodKey
// runs once per log entry (up to the 1000-row fetch cap) on every
// grouping recompute, and Intl.DateTimeFormat construction isn't free.
const SAST_YMD_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg", year: "numeric", month: "2-digit", day: "2-digit" });

export function sastTodayStr() {
  const p = Object.fromEntries(SAST_YMD_FORMAT.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// Same as sastTodayStr but slash-separated ("YYYY/MM/DD"), matching
// trip.scheduled_date's own format — used to compare "today" against
// scheduled_date. Previously two separate call sites each computed this
// from `new Date().getFullYear()/getMonth()/getDate()` (local device
// time, not SAST), which could misjudge "is this driver full TODAY" for
// an admin browsing from outside SAST — a real capacity-decision bug at
// one of the two sites, not just a display mismatch.
export function sastTodaySlashStr() {
  const p = Object.fromEntries(SAST_YMD_FORMAT.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}/${p.month}/${p.day}`;
}

// Shifts a "YYYY-MM-DD" date string by N days and/or N calendar months —
// treats the string as a plain calendar date (UTC midnight, no further
// timezone conversion needed since it's already the target SAST date).
export function shiftDateStr(dateStr, { days = 0, months = 0 } = {}) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (days) dt.setUTCDate(dt.getUTCDate() + days);
  if (months) {
    // setUTCMonth on a day that doesn't exist in the target month rolls
    // FORWARD into the following month instead of clamping (e.g. Oct 31
    // minus 1 month lands on "Sep 31", which JS normalizes to Oct 1) —
    // shift against day 1 first, then clamp back to the target month's
    // real last day.
    const day = dt.getUTCDate();
    dt.setUTCDate(1);
    dt.setUTCMonth(dt.getUTCMonth() + months);
    const lastDayOfTargetMonth = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    dt.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  }
  return dt.toISOString().slice(0, 10);
}

// Calendar bucket key for a timestamp, pinned to SAST (not the viewing
// device's local time) — same reasoning as sastSameDayAfter15h elsewhere
// in this app: an admin reviewing "today's" activity from a non-SAST
// device must see the same boundary everyone else does. Week buckets are
// Monday-start (ISO), keyed by that Monday's date.
export function auditLogPeriodKey(timestamp, granularity) {
  const p = Object.fromEntries(SAST_YMD_FORMAT.formatToParts(new Date(timestamp)).map(x => [x.type, x.value]));
  if (granularity === "month") return `${p.year}-${p.month}`;
  if (granularity === "week") {
    const monday = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
    const dow = monday.getUTCDay(); // 0=Sun..6=Sat
    monday.setUTCDate(monday.getUTCDate() - ((dow + 6) % 7));
    return monday.toISOString().slice(0, 10);
  }
  return `${p.year}-${p.month}-${p.day}`;
}

export function groupAuditLogsByPeriod(logs, granularity) {
  const buckets = new Map();
  for (const log of logs) {
    const key = auditLogPeriodKey(log.timestamp, granularity);
    if (!buckets.has(key)) buckets.set(key, { key, count: 0, byCategory: {}, entries: [] });
    const bucket = buckets.get(key);
    bucket.count++;
    const cat = auditLogCategory(log.actionType);
    bucket.byCategory[cat] = (bucket.byCategory[cat] || 0) + 1;
    bucket.entries.push(log);
  }
  return [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key));
}

function auditLogsToCsv(logs) {
  const headers = ["Timestamp", "Category", "Action Type", "Actor", "Details", "Trip ID", "Target User ID"];
  const rows = logs.map(l => [
    fmtSastDateTime(l.timestamp), auditLogCategory(l.actionType), l.actionType, l.username || "",
    l.details || "", l.tripId ?? "", l.targetUserId ?? "",
  ]);
  const csv = [headers, ...rows].map(r => r.map(csvEscapeCell).join(",")).join("\r\n");
  return "﻿" + csv;
}

function computeDriverSafetyScorecard(trips, notifications) {
  const tripsInWindow = trips.length;
  const noShows = trips.reduce((n, t) => n + (t.no_shows?.length || 0), 0);
  const speedingAlerts = notifications.filter(n => n.type === "SPEED_ANOMALY").length;
  const routeDeviations = notifications.filter(n => n.type === "ROUTE_DEVIATION").length;
  let ratingSum = 0, ratingCount = 0;
  for (const t of trips) {
    for (const r of Object.values(t.agent_ratings || {})) {
      if (r?.stars) { ratingSum += r.stars; ratingCount++; }
    }
  }
  const avgRating = ratingCount > 0 ? ratingSum / ratingCount : null;
  return { speedingAlerts, routeDeviations, noShows, avgRating, ratingCount, tripsInWindow };
}

export function ViewerPortal({ state, dispatch, user }) {
  // Search Profiles is its own top-level tab here (not folded into
  // ClientPortalApp) deliberately — ClientPortalApp is also used
  // as-is by real external client-company users, who must never get an
  // internal "search any agent's full profile + trip history" tool.
  // AdminProfileSearch already correctly restricts itself for Viewer
  // (agent profiles only, no driver profiles, no CSV export — all via
  // the same hasAdminPermission checks used everywhere else), it just
  // was never actually reachable from here before.
  const [viewerTab, setViewerTab] = React.useState("portal");
  // Scope state to this viewer's companies via the SAME shared
  // getAdminCompanyIds() AdminApp's scopedState uses — previously this was
  // a separate, duplicate re-derivation (`user.scoped_company_ids || []`)
  // that diverged from it in a real, exploitable way, not just a stale
  // comment: getAdminCompanyIds deliberately fails CLOSED for a Viewer
  // with no scoped_company_ids configured (returns the "__NONE__" sentinel
  // — see all — nothing matches it), but this component's own copy failed
  // OPEN in that exact case ("no scope = see all"). The admin-creation form
  // has no required-selection validation on the company checklist, so
  // creating (or editing) a Viewer admin with zero companies checked is a
  // completely ordinary, unexotic path — and VIEWER admins are routed
  // straight to THIS component, never to AdminApp, so that fail-open
  // fallback was live and reachable: an under-configured Viewer account
  // got full unrestricted fleet-wide agent/trip/ticket/driver-status
  // access, the opposite of what the VIEWER tier means. Sharing the one
  // real implementation instead of re-deriving it here closes this for
  // good — no second copy left to drift out of sync again.
  const scopedState = React.useMemo(() => {
    const companyIds = getAdminCompanyIds(user, state.companies);
    if (!companyIds.length) return state; // FLEET_OPS/STANDARD/FINANCIAL only — VIEWER always gets a restricting (possibly "__NONE__") array
    return {
      ...state,
      companies: (state.companies || []).filter(c => companyIds.some(id => String(id) === String(c.id))),
      users: scopeUsersToCompany(state.users, state.trips, companyIds),
      trips: scopeTripsToCompany(state.trips, state.users, companyIds),
      tickets: scopeTicketsToCompany(state.tickets, state.users, state.trips, companyIds),
      notifications: scopeNotificationsToCompany(state.notifications, state.trips, state.users, companyIds),
      driver_status: scopeDriverStatusToCompany(state.driver_status, state.trips, state.users, companyIds),
    };
  }, [state, user]);

  // Determine which company name to show in the header — same
  // getAdminCompanyIds fail-closed semantics as scopedState above, so an
  // under-configured Viewer's header is now honest ("Client Portal", the
  // existing neutral fallback) instead of claiming "All Companies" access
  // it no longer actually has post-fix.
  const companyName = React.useMemo(() => {
    const ids = getAdminCompanyIds(user, state.companies);
    if (!ids.length) return "All Companies";
    const co = state.companies.find(c => ids.some(id => String(id) === String(c.id)));
    return co?.name || "Client Portal";
  }, [state.companies, user]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: COLORS.bg }}>
      {/* Minimal header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px", paddingTop: "calc(10px + env(safe-area-inset-top, 0px))",
        background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`, flexShrink: 0,
      }}>
        <div style={{ width: 32, height: 32, borderRadius: 16, background: COLORS.amber, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.head, fontSize: 13, fontWeight: 800, color: "#000", flexShrink: 0 }}>
          {(user.name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FONTS.head, fontSize: 12, fontWeight: 800, color: COLORS.chalk }}>{companyName}</div>
          <div style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: 0.5 }}>{user.name}</div>
        </div>
        <button
          onClick={() => dispatch({ type: "AUTH/LOGOUT" }).catch(() => {})}
          style={{ background: "none", border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: "5px 10px", color: COLORS.ghost, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, cursor: "pointer", fontFamily: FONTS.head }}
        >
          LOG OUT
        </button>
      </div>
      {/* Top-level tab bar — Portal (trips/SLA/exceptions) vs Search Profiles */}
      <div style={{ display: "flex", borderBottom: `1px solid ${COLORS.wire}`, background: COLORS.panel, flexShrink: 0 }}>
        {[["portal", "◈", "Portal"], ["profiles", "🔍", "Search Profiles"]].map(([id, icon, label]) => (
          <button key={id} onClick={() => setViewerTab(id)}
            style={{ flex: 1, padding: "10px 4px", background: "none", border: "none", borderBottom: viewerTab === id ? `2px solid ${COLORS.amber}` : "2px solid transparent", color: viewerTab === id ? COLORS.amber : COLORS.ghost, fontSize: 9, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5 }}>
            {icon} {label}
          </button>
        ))}
      </div>
      {/* Full-height portal — no sidebar, no further tabs chrome */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {viewerTab === "portal" ? (
          <ClientPortalApp
            state={scopedState}
            dispatch={dispatch}
            user={{ ...user, is_master_client: true }}
            hideHeader={true}
          />
        ) : (
          <AdminProfileSearch state={scopedState} user={user} dispatch={dispatch} />
        )}
      </div>
    </div>
  );
}

export function FinancialPortal({ state, dispatch, user }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: COLORS.bg }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "10px 16px", paddingTop: "calc(10px + env(safe-area-inset-top, 0px))",
        background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`, flexShrink: 0,
      }}>
        <div style={{ width: 32, height: 32, borderRadius: 16, background: COLORS.amber, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.head, fontSize: 13, fontWeight: 800, color: "#000", flexShrink: 0 }}>
          {(user.name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: FONTS.head, fontSize: 12, fontWeight: 800, color: COLORS.chalk }}>Financial Administrator</div>
          <div style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: 0.5 }}>{user.name}</div>
        </div>
        <button
          onClick={() => dispatch({ type: "AUTH/LOGOUT" }).catch(() => {})}
          style={{ background: "none", border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: "5px 10px", color: COLORS.ghost, fontSize: 10, fontWeight: 700, letterSpacing: 0.5, cursor: "pointer", fontFamily: FONTS.head }}
        >
          LOG OUT
        </button>
      </div>
      {/* Full-height, single scrollable view — no tab bar, no sidebar. */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <AdminProfileSearch state={state} user={user} dispatch={dispatch} />
        <AdminHistory state={state} user={user} dispatch={dispatch} />
      </div>
    </div>
  );
}

function StreetInput({ value, onChange, placeholder, error, preConfirmed }) {
  const [query, setQuery] = useState(value || "");
  const [results, setResults] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [selected, setSelected] = useState(preConfirmed && value ? preConfirmed : null);
  const [isLive, setIsLive] = useState(false);
  const [resultSource, setResultSource] = useState("offline"); // "tomtom" | "nominatim" | "offline"
  const [streetSuggestions, setStreetSuggestions] = useState([]);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

  // Resync when the parent externally resets/changes value+preConfirmed —
  // e.g. a "create new" form (CompanyManagerPanel) clearing back to an
  // empty form after a successful submit, while this
  // same StreetInput instance stays mounted (unlike the *edit*-row
  // instances, which naturally remount per-row via conditional
  // rendering). query/selected were only ever initialized from
  // value/preConfirmed at MOUNT time (useState's initializer runs once)
  // and never resynced afterward — the address field kept showing the
  // old "✅ [confirmed address]" state with stale coordinates even after
  // the parent's actual value had been reset to null, visually lying to
  // the admin about what's currently entered. (Submission itself was
  // still safe — the null-coord guard at each call site caught the
  // mismatch before anything wrong got saved — this was a confusing-UX
  // bug, not a data-corruption one.) Depends on preConfirmed's lat/lng
  // specifically, not the object reference itself, since callers
  // construct a brand-new preConfirmed object literal every render even
  // when the underlying coordinate hasn't changed.
  useEffect(() => {
    setQuery(value || "");
    setSelected(preConfirmed && value ? preConfirmed : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, preConfirmed?.lat, preConfirmed?.lng]);

  useEffect(() => {
    if (selected) return;
    // Reset the live badge the instant the query changes, so it never shows
    // the previous keystroke's live/offline result while a new lookup is
    // still in flight (was: only reset on clear, causing stale flicker).
    setIsLive(false);
    if (query.trim().length < 2) { setResults([]); setShowDrop(false); setStreetSuggestions([]); return; }
    const instant = staticSearch(query);
    setResults(instant);
    setShowDrop(instant.length > 0);
    setResultSource("offline");

    // Instant street-name suggestions from the bulk street-name table —
    // runs in parallel with the debounced live search below, not blocked
    // by it, since it's meant to show up before the debounce even fires.
    let nameCancelled = false;
    streetNameSearch(query).then(names => {
      if (!nameCancelled) setStreetSuggestions(names);
    });

    // Debounce the live search call — without this, every keystroke fired
    // its own network request with no cancellation of the in-flight ones,
    // which both wastes quota and can trigger rate limiting on fast typing.
    let cancelled = false;
    const timer = setTimeout(() => {
      unifiedAddressSearch(query).then(({ results: hits, liveOk, source }) => {
        if (cancelled) return;
        setResults(hits);
        setShowDrop(hits.length > 0);
        setIsLive(liveOk);
        setResultSource(source);
      });
    }, 300);
    return () => { cancelled = true; nameCancelled = true; clearTimeout(timer); };
  }, [query]);

  // Tapping a street-name suggestion re-runs the search scoped to that
  // exact name, so Nominatim gets a clean, unambiguous query instead of
  // whatever partial text the person had typed — much more likely to
  // resolve to a real coordinate.
  const pickStreetSuggestion = (name) => {
    setStreetSuggestions([]);
    setQuery(name);
  };

  useEffect(() => {
    function onDocClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowDrop(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const handleInput = (v) => {
    setQuery(v);
    setSelected(null);
    setIsLive(false);
    onChange({ street: v, area: "", coord: null, label: v, confirmed: false });
    if (v.trim().length < 2) { setResults([]); setShowDrop(false); }
  };

  const selectResult = (r) => {
    setQuery(r.label);
    setSelected(r);
    setShowDrop(false);
    setResults([]);
    setStreetSuggestions([]);
    onChange({ street: r.label, area: r.area, coord: { lat: r.lat, lng: r.lng, label: r.label }, label: r.label, confirmed: true });
    inputRef.current?.blur();
  };

  const clearInput = () => {
    setQuery(""); setSelected(null); setResults([]); setShowDrop(false); setIsLive(false); setStreetSuggestions([]);
    onChange({ street: "", area: "", coord: null, label: "", confirmed: false });
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ position: "relative" }}>
        <span style={{ position: "absolute", left: 12, top: 11, fontSize: 15, color: selected ? COLORS.green : COLORS.ghost, pointerEvents: "none" }}>
          {selected ? "✅" : "📍"}
        </span>
        <input
          ref={inputRef}
          className={`inp${error ? " err" : ""}`}
          style={{ paddingLeft: 38, paddingRight: query ? 34 : 12, width: "100%" }}
          value={query}
          onChange={e => handleInput(e.target.value)}
          onFocus={() => { if (results.length > 0 && !selected) setShowDrop(true); }}
          placeholder={placeholder || "Start typing a street or suburb…"}
          autoComplete="off"
        />
        {query ? (
          <button onClick={clearInput} style={{ position: "absolute", right: 9, top: 9, background: "none", border: "none", color: COLORS.ghost, fontSize: 14, cursor: "pointer" }}>✕</button>
        ) : null}
      </div>

      {!selected && streetSuggestions.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 5 }}>
          {streetSuggestions.map(name => (
            <button
              key={name}
              onMouseDown={() => pickStreetSuggestion(name)}
              style={{ fontSize: 10, padding: "4px 9px", borderRadius: 12, border: `1px solid ${COLORS.wire}`, background: COLORS.surface, color: COLORS.chalk, cursor: "pointer" }}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {query.length >= 2 && !selected && results.length === 0 && (
        <div style={{ fontSize: 10, color: COLORS.ghost, background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: 10, marginTop: 4 }}>
          No address matched "<span style={{ color: COLORS.chalk }}>{query}</span>". Check the spelling, try just the street name, or try the suburb.
        </div>
      )}

      {showDrop && results.length > 0 && (
        <div style={{ position: "absolute", top: 46, left: 0, right: 0, zIndex: 100, background: COLORS.card, border: `1px solid ${COLORS.wire}`, borderRadius: 6, boxShadow: "0 8px 32px rgba(0,0,0,.45)", maxHeight: 280, overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${COLORS.wire}`, background: COLORS.surface }}>
            <span style={{ fontSize: 10, color: COLORS.ghost }}>
              {`${results.length} address${results.length !== 1 ? "es" : ""} found`}
            </span>
            <span style={{ fontSize: 8, fontWeight: 700, color: isLive ? COLORS.green : COLORS.dim }}>
              {isLive ? (resultSource === "tomtom" ? "● TOMTOM" : "● LIVE") : "○ OFFLINE DB"}
            </span>
          </div>
          {results.map((r, i) => {
            const comma = r.label.indexOf(",");
            const street = comma > 0 ? r.label.slice(0, comma) : r.label;
            const suburb = comma > 0 ? r.label.slice(comma + 1).trim() : r.area;
            return (
              <div key={`${r.lat?.toFixed(4)}-${r.lng?.toFixed(4)}-${i}`}
                onMouseDown={() => selectResult(r)}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 12px", borderBottom: "1px solid rgba(255,255,255,.04)", cursor: "pointer" }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(245,166,35,.08)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <span style={{ fontSize: 13 }}>📍</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: COLORS.chalk }}>{street}</div>
                  <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>{suburb}</div>
                </div>
                <span style={{ color: COLORS.ghost }}>›</span>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: "rgba(29,185,84,.08)", border: "1px solid rgba(29,185,84,.3)", borderRadius: 6, padding: 10, marginTop: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, background: COLORS.green }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.green }}>{selected.label}</div>
            <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 1 }}>{selected.lat?.toFixed(5)}, {selected.lng?.toFixed(5)}</div>
          </div>
          <button onClick={clearInput} style={{ background: "none", border: "none", color: COLORS.ghost, fontSize: 13, cursor: "pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}

function LocationSelector({ mode, setMode, companyId, setCompanyId, state, streetValue, streetCoord, onStreetChange, error, errMsg }) {
  // BUGFIX (2026-07-31): this component used to take manualAddress/
  // onManualAddressChange as props, but no caller anywhere in the app ever
  // provided them — every real usage only wires up onStreetChange. That
  // meant clicking "Type Address" and typing crashed immediately
  // (calling onManualAddressChange, which was always undefined). Made
  // manual-entry self-contained instead: manages its own text state here
  // and reuses the SAME onStreetChange callback every caller already
  // supplies, geocoding in the background via tomtomGeocodeAddress
  // (previously written but never actually called anywhere) exactly as
  // this mode's own help text always claimed it would.
  const [manualAddress, setManualAddress] = useState(mode === "manual" ? (streetValue || "") : "");
  const [manualGeocoding, setManualGeocoding] = useState(false);
  React.useEffect(() => {
    if (mode !== "manual") return;
    const trimmed = manualAddress.trim();
    if (trimmed.length < 8) {
      onStreetChange({ street: trimmed, area: null, coord: null, confirmed: false });
      return;
    }
    // Usable immediately once it looks like a real address — Waze can
    // search the raw typed text even without a resolved coordinate (per
    // the help text below), so typing shouldn't block the user from
    // proceeding while geocoding is still in flight.
    onStreetChange({ street: trimmed, area: null, coord: null, confirmed: true });
    let cancelled = false;
    setManualGeocoding(true);
    const handle = setTimeout(() => {
      tomtomGeocodeAddress(trimmed).then(result => {
        if (cancelled || !result) return;
        // Upgrade with a precise pin once found — same street text, now
        // with real coordinates attached.
        onStreetChange({ street: trimmed, area: result.area, coord: { lat: result.lat, lng: result.lng }, confirmed: true });
      }).finally(() => { if (!cancelled) setManualGeocoding(false); });
    }, 600); // debounce — avoid geocoding on every keystroke
    return () => { cancelled = true; clearTimeout(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualAddress, mode]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <Button title="🏠 Home / Street" variant={mode === "street" ? "amber" : "ghost"} size="sm" full onClick={() => setMode("street")} style={{ flex: 1 }} />
        <Button title="🏢 Company" variant={mode === "company" ? "amber" : "ghost"} size="sm" full onClick={() => setMode("company")} style={{ flex: 1 }} />
        <Button title="✏️ Type Address" variant={mode === "manual" ? "amber" : "ghost"} size="sm" full onClick={() => setMode("manual")} style={{ flex: 1 }} />
      </div>
      {mode === "street" && (
        <>
          <StreetInput
            value={streetValue} error={!!error} placeholder="e.g. 14 Main Road" onChange={onStreetChange}
            preConfirmed={streetCoord ? { label: streetValue, area: streetCoord.area, lat: streetCoord.lat, lng: streetCoord.lng } : null}
          />
          {errMsg ? <span style={{ fontSize: 10, color: COLORS.red }}>{errMsg}</span> : null}
        </>
      )}
      {mode === "company" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(state?.companies || []).length === 0 ? (
            <span style={{ fontSize: 10, color: COLORS.ghost }}>No companies have been added yet — add one from Users → Manage Companies.</span>
          ) : state.companies.map(loc => {
            const sel = companyId === loc.id;
            const co = companyById(state, loc.id);
            return (
              <div key={loc.id} onClick={() => setCompanyId(loc.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, border: `1px solid ${sel ? COLORS.amber2 : COLORS.wire}`, borderRadius: 4, padding: "12px 14px", background: sel ? COLORS.amber : "transparent", cursor: "pointer" }}>
                <span style={{ fontSize: 18 }}>🏢</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: sel ? COLORS.ink : COLORS.chalk }}>{loc.name}{!loc.active ? " (inactive)" : ""}</div>
                  <div style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.ghost, marginTop: 2 }}>{co?.address || "—"}</div>
                </div>
                {sel ? <span style={{ color: COLORS.ink }}>✓</span> : null}
              </div>
            );
          })}
        </div>
      )}
      {mode === "manual" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <TextField
            label="Full address (typed exactly as it should appear in Waze)"
            value={manualAddress} onChange={e => setManualAddress(e.target.value)}
            placeholder="e.g. 14 Bokmakierie Street, Rocklands, Cape Town, 7100"
          />
          <span style={{ fontSize: 9, color: COLORS.ghost }}>
            {manualGeocoding
              ? "Looking up a precise pin for this address…"
              : "No dropdown search — type the exact address and it'll be looked up in the background to give your driver a precise pin in Waze. If it can't be found, Waze will fall back to searching this text directly when navigation opens. Include the suburb and postal code for the best match."}
          </span>
          {errMsg ? <span style={{ fontSize: 10, color: COLORS.red }}>{errMsg}</span> : null}
        </div>
      )}
    </div>
  );
}

function AdminTripDropoffs({ trip, state }) {
  let dropCoords = trip.dropoff_sequence_coords && trip.dropoff_sequence_coords.length > 0
    ? trip.dropoff_sequence_coords : [];
  if (trip.direction === "OUTBOUND" && dropCoords.length < (trip.agent_ids?.length || 0)) {
    const covered = new Set(dropCoords.map(d => d.agent_id).filter(Boolean));
    const derived = [...dropCoords];
    (trip.agent_ids || []).forEach(aid => {
      if (covered.has(aid)) return;
      const u = state.users.find(x => String(x.id) === String(aid));
      if (u?.home_address?.lat != null) derived.push({ lat: u.home_address.lat, lng: u.home_address.lng, label: u.home_address.label, agent_id: aid });
    });
    dropCoords = derived;
  }
  // ROOT-CAUSE FIX — same wrong-anchor bug just fixed in DriverNavTab
  // (commit d682f47) and computeLiveSequenceForDriver: this anchored the
  // REAL TomTom call itself (not just a pre-fallback) on the company
  // OFFICE, but the driver starts drop-offs from the trip's own shared
  // OUTBOUND pickup point instead — so even a fully-resolved TomTom
  // result here was answering the wrong question, not just briefly wrong
  // before it loaded. pickup_sequence_coords[0] is this trip's own
  // shared pickup coordinate (all OUTBOUND agents board at one location).
  const anchor = trip.pickup_sequence_coords?.[0] || defaultCompanyAnchor(state);
  // Ground truth over prediction for a completed trip — see
  // actualDropoffCoordOrder's comment for why this can genuinely differ
  // from (or reverse) a freshly re-predicted order. Computed before the
  // hook call so its presence can also skip the TomTom fetch entirely
  // (see useSortedDropoffs' skipFetch param) — no point spending a live
  // API call predicting something that already, verifiably, happened.
  const actualOrder = actualDropoffCoordOrder(dropCoords, trip);
  const [sorted] = useSortedDropoffs(dropCoords, anchor, trip.direction, trip.trip_id, undefined, trip.direction === "INBOUND" ? defaultCompanyAnchor(state) : null, trip.scheduled_time_epoch, !!actualOrder);
  const finalCoords = actualOrder || sorted || dropCoords;
  if (finalCoords.length <= 1) return (
    <span style={{ fontSize: 10 }}><span style={{ color: COLORS.red }}>◎ </span>{finalCoords[0]?.label || trip.custom_dropoff}</span>
  );
  return (
    <>
      {finalCoords.map((dc, dci) => {
        const dropAgent = dc.agent_id ? state.users.find(u => String(u.id) === String(dc.agent_id)) : null;
        return (
          <div key={dci} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 10 }}>
              <span style={{ color: COLORS.red }}>◎ </span>
              <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.ghost }}>D{dci + 1} </span>
              {dropAgent ? `${dropAgent.name.split(" ")[0]}: ` : ""}
              {dc.label || trip.custom_dropoff}
            </span>
            {dc.lat && <Button title="🧭" variant="waze" size="sm" onClick={() => smartOpenWaze(dc.lat, dc.lng, dc.label || trip.custom_dropoff, trip.dropoff_is_manual)} />}
          </div>
        );
      })}
    </>
  );
}

function AdminDashboard({ state, user, dispatch }) {
  // Viewer Administrator only sees TODAY's trips on the dashboard — Fleet
  // Ops and Standard keep the existing full live-window view (current +
  // previous month of activity, matching what "All Trips" shows). This does NOT
  // affect Viewer's access to History (which has its own separate 60-day
  // cap already) — this is specifically about the Dashboard's daily
  // snapshot being genuinely daily for that tier.
  const isViewer = user.admin_level === ADMIN_LEVEL.VIEWER;
  const todayStr = sastTodaySlashStr();
  const trips = isViewer ? state.trips.filter(t => t.scheduled_date === todayStr) : state.trips;
  const counts = {
    total: trips.length,
    unassign: trips.filter(t => t.state === TRIP_STATE.UNASSIGNED_BOOKING).length,
    active: trips.filter(t => [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)).length,
    done: trips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED).length,
  };

  // Emergency backup — exports ALL non-completed trips currently loaded in
  // the browser to a CSV file on the user's device. Reads from in-memory
  // state only, so it works even if the server is completely unreachable.
  // Includes today's active trips + all future bookings.
  const [backingUp, setBackingUp] = React.useState(false);
  const doBackup = () => {
    setBackingUp(true);
    try {
      const backupTrips = state.trips.filter(t =>
        t.state !== TRIP_STATE.ARCHIVED_COMPLETED &&
        t.state !== TRIP_STATE.ARCHIVED_CANCELLED
      );
      const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      exportTripsToCsv(
        backupTrips,
        state.users,
        state.driver_status,
        `BACKUP_${dateTag}`,
        {}, {}
      );
    } finally {
      setBackingUp(false);
    }
  };

  // Per-section collapse for the dashboard's stacked widgets — per
  // explicit request to sweep the app for space-consuming sections.
  // This is the FIRST screen every admin sees, and previously stacked
  // Driver Fleet (a full driver-card list duplicating much of
  // AdminDrivers), Announcement, Weekly Ops Summary, 7-Day Demand
  // Forecast, and Staffing Gaps all fully expanded with no way to hide
  // ones an admin doesn't need right now. Starts with nothing collapsed,
  // matching existing behavior exactly. "Recent Activity" deliberately
  // left alone — already capped to 8 rows, not a real space cost.
  const [collapsedSections, setCollapsedSections] = React.useState(new Set());
  const toggleSection = (key) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="pad">
      {/* Emergency backup panel — always visible at the top of the dashboard */}
      <BackupVerifyPanel />
      <div style={{ background: "rgba(245,166,35,.06)", border: "1px solid rgba(245,166,35,.25)", borderRadius: 6, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.amber }}>🛡 EMERGENCY BACKUP</div>
          <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>
            Saves all upcoming &amp; active trips to a CSV on your device — works offline, no server needed.
          </div>
        </div>
        <Button
          title={backingUp ? "SAVING…" : `⬇ BACKUP (${state.trips.filter(t => t.state !== TRIP_STATE.ARCHIVED_COMPLETED && t.state !== TRIP_STATE.ARCHIVED_CANCELLED).length} trips)`}
          variant="ghost"
          size="sm"
          onClick={doBackup}
          disabled={backingUp}
          style={{ flexShrink: 0, borderColor: COLORS.amber, color: COLORS.amber }}
        />
      </div>
      {isViewer && (
        <div style={{ fontSize: 10, color: COLORS.ghost }}>Showing today's trips only ({todayStr}). Full trip history is available under History.</div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 1, background: COLORS.wire, border: `1px solid ${COLORS.wire}`, borderRadius: 4, overflow: "hidden" }}>
        {[["TOTAL", counts.total, COLORS.chalk], ["UNASSIGNED", counts.unassign, COLORS.red], ["ACTIVE", counts.active, COLORS.amber], ["DONE", counts.done, COLORS.green]].map(([l, v, c]) => (
          <div key={l} style={{ background: COLORS.card, padding: 14, width: "49.5%" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: COLORS.ghost, textTransform: "uppercase" }}>{l}</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4, fontFamily: FONTS.head, color: c }}>{v}</div>
          </div>
        ))}
      </div>
      <SectionHeader label="Driver Fleet" collapsed={collapsedSections.has("fleet")} onToggle={() => toggleSection("fleet")} />
      {!collapsedSections.has("fleet") && state.driver_status.map(ds => {
        const u = state.users.find(x => String(x.id) === String(ds.driver_id));
        const load = getDriverLoad(state, ds.driver_id, todayStr);
        const driverCapacityDash = ds.capacity || DRIVER_CAPACITY;
        const full = load >= driverCapacityDash;
        return (
          <Card key={ds.driver_id} style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
            <DriverAvatar name={u?.name} isOnline={u?.is_online} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{u?.name}</div>
              <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>{ds.vehicle}</div>
              <div style={{ margin: "6px 0 8px" }}><StateBadge state={full ? "FULLY_BOOKED" : ds.state} /></div>
              <CapacityBar load={load} capacity={driverCapacityDash} />
            </div>
          </Card>
        );
      })}
      {hasAdminPermission(user, "manageDispatch") && (
        <>
          <SectionHeader label="Announcement" collapsed={collapsedSections.has("announce")} onToggle={() => toggleSection("announce")} />
          {!collapsedSections.has("announce") && (() => { try { return <AnnouncementPanel dispatch={dispatch} />; } catch(e) { return <div style={{color:'red',fontSize:10}}>Announcement error: {e.message}</div>; } })()}
        </>
      )}
      <SectionHeader label="Weekly Ops Summary" collapsed={collapsedSections.has("weeklyOps")} onToggle={() => toggleSection("weeklyOps")} />
      {!collapsedSections.has("weeklyOps") && (() => { try { return <WeeklyOpsSummaryPanel state={state} />; } catch(e) { return <div style={{color:'red',fontSize:10}}>WeeklyOps error: {e.message}</div>; } })()}
      <SectionHeader label="7-Day Demand Forecast" collapsed={collapsedSections.has("forecast")} onToggle={() => toggleSection("forecast")} />
      {!collapsedSections.has("forecast") && (() => { try { return <CapacityForecastPanel state={state} />; } catch(e) { return <div style={{color:'red',fontSize:10}}>CapacityForecast error: {e.message}</div>; } })()}
      <SectionHeader label="Staffing Gaps (Next 7 Days)" collapsed={collapsedSections.has("gaps")} onToggle={() => toggleSection("gaps")} />
      {!collapsedSections.has("gaps") && (() => { try { return <SmartSchedulingPanel state={state} />; } catch(e) { return <div style={{color:'red',fontSize:10}}>SmartScheduling error: {e.message}</div>; } })()}
      <SectionHeader label="Recent Activity" />
      <Card body={false}>
        {trips.slice(0, 8).length === 0 ? <Empty icon="⊟" text="No bookings or trips yet" /> : trips.slice(0, 8).map(t => (
          <div key={t.trip_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: `1px solid ${COLORS.wire}` }}>
            <span style={{ width: 80, fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 11 }}>{t.agent_ids?.length || 1} passenger{(t.agent_ids?.length || 1) !== 1 ? "s" : ""}</span>
            <StateBadge state={t.state} />
          </div>
        ))}
      </Card>
    </div>
  );
}

function AddAgentPanel({ trip, state, dispatch, onClose }) {
  const [agentId, setAgentId] = useState("");
  const [agentSearch, setAgentSearch] = useState("");
  const [mode, setMode] = useState("street");
  const [companyId, setCompanyId] = useState((state.companies || [])[0]?.id || "");
  // Separate company selection for the OUTBOUND dropoff selector below —
  // previously shared companyId with the pickup selector, so an admin
  // choosing "Company" mode for BOTH pickup and dropoff (with different
  // companies for each) would silently have one selection overwrite the
  // other, since both LocationSelector instances were driven by the same
  // state variable.
  const [dropCompanyId, setDropCompanyId] = useState((state.companies || [])[0]?.id || "");
  const [streetValue, setStreetValue] = useState("");
  const [streetArea, setStreetArea] = useState("");
  const [streetCoord, setStreetCoord] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  // For OUTBOUND trips each agent has their own dropoff (home address).
  // For INBOUND trips there's one shared dropoff (the company) — inherited from the trip.
  const isOutbound = trip.direction === "OUTBOUND";
  const [dropMode, setDropMode] = useState("street");
  const [dropStreetValue, setDropStreetValue] = useState("");
  const [dropStreetCoord, setDropStreetCoord] = useState(null);
  const [dropConfirmed, setDropConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const availableAgentsAll = state.users.filter(u => u.role === ROLE.AGENT && !trip.agent_ids.some(id => String(id) === String(u.id)));
  // Search-to-filter, per explicit request — a flat unfiltered list is
  // fine for a handful of agents, but genuinely slow to scroll through
  // on a real fleet with many. Same case-insensitive substring match on
  // name/staff-number already used elsewhere in this file (AdminContacts).
  const availableAgents = agentSearch.trim().length >= 1
    ? availableAgentsAll.filter(a => a.name.toLowerCase().includes(agentSearch.trim().toLowerCase()) || (a.staff_number || "").toLowerCase().includes(agentSearch.trim().toLowerCase()))
    : availableAgentsAll;
  const selectedCompany = companyById(state, companyId) || { address: "", lat: null, lng: null };
  const selectedAgent = state.users.find(u => String(u.id) === String(agentId));

  // Picking an agent with a saved home address pre-fills it, same convenience
  // the agent's own booking screen gives them — admin can still override.
  // For OUTBOUND trips also pre-fills the dropoff (their home address).
  const chooseAgent = (id) => {
    setAgentId(id);
    const a = state.users.find(u => String(u.id) === String(id));
    if (a?.home_address) {
      setMode("street");
      setStreetValue(a.home_address.label);
      setStreetArea(a.home_address.area);
      setStreetCoord({ lat: a.home_address.lat, lng: a.home_address.lng });
      setConfirmed(true);
      // OUTBOUND: home is also the dropoff
      if (isOutbound) {
        setDropMode("street");
        setDropStreetValue(a.home_address.label);
        setDropStreetCoord({ lat: a.home_address.lat, lng: a.home_address.lng });
        setDropConfirmed(true);
      }
    } else {
      setStreetValue(""); setStreetCoord(null); setConfirmed(false);
      if (isOutbound) { setDropStreetValue(""); setDropStreetCoord(null); setDropConfirmed(false); }
    }
  };

  const selectedDropCompany = companyById(state, dropCompanyId) || { address: "", lat: null, lng: null };
  // Requires streetCoord/dropStreetCoord too, not just confirmed —
  // LocationSelector's manual-entry mode sets confirmed:true the instant
  // 8+ characters are typed, BEFORE the debounced TomTom geocode even
  // fires (intentional there: it lets the primary agent booking flow's
  // Waze fallback work on raw text alone). But this panel writes
  // pickup_coord/dropoff_coord straight into the trips table via
  // TRIP/ADD_AGENT with no null check — saving inside that debounce
  // window dispatched pickup_coord: null and crashed with a raw
  // TypeError. confirmed alone was never a safe enough gate for a save
  // path that actually persists coordinates.
  const canSave = agentId &&
    (mode === "company" || (streetValue && confirmed && streetCoord)) &&
    (!isOutbound || dropMode === "company" || (dropStreetValue && dropConfirmed && dropStreetCoord));

  const [saveError, setSaveError] = useState(null);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const pickupLabel = mode === "company" ? selectedCompany.address : streetValue;
    const pickupCoord = mode === "company" ? { lat: selectedCompany.lat, lng: selectedCompany.lng } : streetCoord;
    // For OUTBOUND pass per-agent dropoff; for INBOUND the trip's shared
    // dropoff is used by default. "Company" mode for the dropoff was
    // previously a dead end — selecting a company here never actually
    // fed into dropoffLabel/dropoffCoord, since only the street-mode
    // handler ever wrote dropStreetValue/dropStreetCoord/dropConfirmed.
    const dropoffLabel = isOutbound ? (dropMode === "company" ? selectedDropCompany.address : dropStreetValue) : null;
    const dropoffCoord = isOutbound
      ? (dropMode === "company" ? { lat: selectedDropCompany.lat, lng: selectedDropCompany.lng } : dropStreetCoord)
      : null;
    try {
      // FOUND VIA /code-review (deep pass): this never sent a phone at
      // all, so the merged-trip phone-number fix (DriverTripsTab/
      // DriverNavTab/admin TripDetailRow all preferring coord/pickup
      // phone over the trip-level fallback) had nothing to actually find
      // for an agent added through this panel — every one of those sites
      // fell straight through to trip.phone (the PRIMARY agent's number)
      // for anyone added here. The agent's own current profile phone is
      // the best signal available at this point (there's no per-booking
      // phone entry step in this admin flow, unlike an agent's own
      // self-booking).
      await dispatch({ type: "TRIP/ADD_AGENT", trip_id: trip.trip_id, agent_id: agentId, phone: selectedAgent?.phone || null, pickup_label: pickupLabel, pickup_coord: pickupCoord, dropoff_label: dropoffLabel, dropoff_coord: dropoffCoord });
      onClose();
    } catch (e) {
      setSaveError(e.message || "Couldn't add the passenger — please try again.");
    } finally {
      setSaving(false);
    }
  };

  if (availableAgentsAll.length === 0) {
    return (
      <Card style={{ borderColor: COLORS.wire }}>
        <span style={{ fontSize: 10, color: COLORS.ghost }}>Every agent is already on this trip.</span>
        <Button title="CLOSE" variant="ghost" size="sm" onClick={onClose} />
      </Card>
    );
  }

  return (
    <Card style={{ borderColor: COLORS.amber2, background: "rgba(245,166,35,.03)" }}>
      <SectionHeader label="Add Passenger" />
      <TextField label="Search by name or staff number" value={agentSearch} onChange={e => setAgentSearch(e.target.value)} placeholder="e.g. Nomsa Dlamini or AG1001" />
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {availableAgents.length === 0 ? (
          <span style={{ fontSize: 10, color: COLORS.ghost, padding: "8px 0" }}>No agents match "{agentSearch}"</span>
        ) : availableAgents.map(a => (
          <div key={a.id} onClick={() => chooseAgent(a.id)}
            style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: `1px solid ${String(agentId) === String(a.id) ? COLORS.amber2 : COLORS.wire}`, borderRadius: 4, background: String(agentId) === String(a.id) ? COLORS.amber : "transparent" }}>
            <DriverAvatar name={a.name} isOnline={a.is_online} size={30} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: String(agentId) === String(a.id) ? COLORS.ink : COLORS.chalk }}>{a.name}</div>
              <div style={{ fontSize: 9, color: String(agentId) === String(a.id) ? COLORS.ink : COLORS.ghost }}>{a.auth.login}</div>
            </div>
          </div>
        ))}
      </div>

      {agentId && (
        <>
          <SectionHeader label="Pickup Location" />
          <LocationSelector mode={mode} setMode={setMode} companyId={companyId} setCompanyId={setCompanyId} state={state}
            streetValue={streetValue} streetCoord={confirmed ? streetCoord : null}
            onStreetChange={({ street, area, coord, confirmed: c }) => { setStreetValue(street); setStreetArea(area); setStreetCoord(coord); setConfirmed(!!c); }} />
          {isOutbound && (
            <>
              <SectionHeader label="Drop-off Location (this agent's home)" />
              <LocationSelector mode={dropMode} setMode={setDropMode} companyId={dropCompanyId} setCompanyId={setDropCompanyId} state={state}
                streetValue={dropStreetValue} streetCoord={dropConfirmed ? dropStreetCoord : null}
                onStreetChange={({ street, coord, confirmed: c }) => { setDropStreetValue(street); setDropStreetCoord(coord); setDropConfirmed(!!c); }} />
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
            {saveError && <span style={{ fontSize: 10, color: COLORS.red, display: "block", marginBottom: 6 }}>{saveError}</span>}
            <Button title={saving ? "ADDING…" : "ADD TO TRIP →"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={!canSave || saving} loading={saving} />
          </div>
        </>
      )}
    </Card>
  );
}

function RelocateAgentPanel({ trip, agent, currentPickup, state, dispatch, onClose }) {
  const [mode, setMode] = useState("street");
  const [companyId, setCompanyId] = useState((state.companies || [])[0]?.id || "");
  const [streetValue, setStreetValue] = useState(currentPickup?.label || "");
  const [streetArea, setStreetArea] = useState("");
  const [streetCoord, setStreetCoord] = useState(currentPickup ? { lat: currentPickup.lat, lng: currentPickup.lng } : null);
  const [confirmed, setConfirmed] = useState(!!currentPickup);
  const [saving, setSaving] = useState(false);

  const selectedCompany = companyById(state, companyId) || { address: "", lat: null, lng: null };
  // See the identical fix/reasoning on AddAgentPanel's canSave — requires
  // streetCoord too, not just confirmed, since manual-entry mode sets
  // confirmed:true before the debounced geocode resolves, and this panel
  // writes pickup_coord straight into the trips table with no null check.
  const canSave = mode === "company" || (streetValue && confirmed && streetCoord);

  const [saveError, setSaveError] = useState(null);
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const pickupLabel = mode === "company" ? selectedCompany.address : streetValue;
    const pickupCoord = mode === "company" ? { lat: selectedCompany.lat, lng: selectedCompany.lng } : streetCoord;
    try {
      await dispatch({ type: "TRIP/RELOCATE_AGENT", trip_id: trip.trip_id, agent_id: agent.id, pickup_label: pickupLabel, pickup_coord: pickupCoord });
      onClose();
    } catch (e) {
      setSaveError(e.message || "Couldn't move the pickup — please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ borderColor: COLORS.blue2, background: "rgba(45,140,240,.04)" }}>
      <SectionHeader label={`Relocate — ${agent.name}`} />
      <span style={{ fontSize: 9, color: COLORS.ghost }}>Current pickup: {currentPickup?.label || "—"}</span>
      <LocationSelector mode={mode} setMode={setMode} companyId={companyId} setCompanyId={setCompanyId} state={state}
        streetValue={streetValue} streetCoord={confirmed ? streetCoord : null}
        onStreetChange={({ street, area, coord, confirmed: c }) => { setStreetValue(street); setStreetArea(area); setStreetCoord(coord); setConfirmed(!!c); }} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
        {saveError && <span style={{ fontSize: 10, color: COLORS.red, display: "block", marginBottom: 6 }}>{saveError}</span>}
        <Button title={saving ? "MOVING…" : "MOVE PICKUP →"} variant="blue" style={{ flex: 1 }} onClick={save} disabled={!canSave || saving} loading={saving} />
      </div>
    </Card>
  );
}

function DropoffSequenceDisplay({ coords, trip, state, anchor }) {
  const destination = trip.direction === "INBOUND" ? defaultCompanyAnchor(state) : null;
  // Ground truth over prediction for a completed trip — see
  // actualDropoffCoordOrder's comment for why this can genuinely differ
  // from (or reverse) a freshly re-predicted order, and useSortedDropoffs'
  // skipFetch param for why this also skips the TomTom call entirely.
  const actualOrder = actualDropoffCoordOrder(coords, trip);
  const [sorted, loading, tomtomError] = useSortedDropoffs(coords, anchor, trip.direction, trip.trip_id, undefined, destination, trip.scheduled_time_epoch, !!actualOrder);
  const finalCoords = actualOrder || sorted || coords || [];
  if (finalCoords.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ color: COLORS.ghost, fontSize: 10 }}>DROP-OFF{finalCoords.length > 1 ? "S" : ""}: </span>
        {loading && !actualOrder && finalCoords.length > 1 && (
          <span style={{ fontSize: 8, color: COLORS.amber, fontStyle: "italic" }}>⟳ optimizing route order…</span>
        )}
        {finalCoords.map((c, i) => {
          const agentUser = c.agent_id ? state.users.find(u => String(u.id) === String(c.agent_id)) : null;
          const label = c.label || trip.custom_dropoff;
          return (
            <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {finalCoords.length > 1 && <span style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700 }}>D{i + 1}</span>}
              {agentUser && <span style={{ fontSize: 9, color: COLORS.ghost }}>{agentUser.name.split(" ")[0]}:</span>}
              <span style={{ color: c._derived ? COLORS.amber : COLORS.red, fontSize: 10 }}>{label || `[${c.lat?.toFixed(4)},${c.lng?.toFixed(4)}]`}{c._derived ? " *" : ""}</span>
              {c.lat && <Button title="🧭" variant="waze" size="sm" onClick={() => smartOpenWaze(c.lat, c.lng, label, trip.dropoff_is_manual)} />}
            </span>
          );
        })}
        {finalCoords.some(c => c._derived) && <span style={{ fontSize: 8, color: COLORS.ghost }}>* from profile</span>}
      </div>
      {tomtomError && !actualOrder && finalCoords.length > 1 && (
        <span style={{ fontSize: 8, color: COLORS.red }}>⚠ Route optimization: {tomtomError} (showing straight-line estimate)</span>
      )}
    </div>
  );
}

function TripDetailRow({ trip, state, dispatch, initiallyOpen, user }) {
  const [open, setOpen] = useState(!!initiallyOpen);
  const [addingAgent, setAddingAgent] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const adminCancelTrip = async () => {
    setCancelError(null);
    try {
      await dispatch({ type: "TRIP/ADMIN_CANCEL", trip_id: trip.trip_id });
      // Row disappears via the refetch/state update — nothing to reset.
    } catch (e) {
      setCancelError(e.message || `Couldn't cancel the ${tripNoun(trip)} — please try again.`);
    }
  };
  const [relocatingId, setRelocatingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const [delays, setDelays] = useState(null); // null = not loaded yet
  const [gpsTrail, setGpsTrail] = useState(null); // null = not loaded yet, [] = loaded, empty
  const [gpsTrailLoading, setGpsTrailLoading] = useState(false);
  const [gpsTrailError, setGpsTrailError] = useState(null);
  const [showGpsTrailMap, setShowGpsTrailMap] = useState(false);
  const loadGpsTrail = async () => {
    setGpsTrailLoading(true);
    setGpsTrailError(null);
    try {
      setGpsTrail(await fetchGpsTrailForTrip(trip.trip_id));
    } catch (e) {
      setGpsTrailError(e.message || "Couldn't load the GPS trail — please try again.");
    } finally {
      setGpsTrailLoading(false);
    }
  };
  const driver = state.users.find(u => String(u.id) === String(trip.driver_id));
  const passengers = trip.agent_ids.map(id => state.users.find(u => String(u.id) === String(id))).filter(Boolean);
  const canEdit = ![TRIP_STATE.ARCHIVED_COMPLETED, TRIP_STATE.ARCHIVED_CANCELLED].includes(trip.state) && dispatch != null;
  // Use the assigned driver's own vehicle capacity, not the global default —
  // a driver with an 8-seat minibus would be incorrectly blocked at 4 seats
  // otherwise. Falls back to DRIVER_CAPACITY for unassigned trips (no driver
  // to look up) or when the driver_status record is missing.
  const tripDriverCapacity = (state.driver_status?.find(d => String(d.driver_id) === String(trip.driver_id))?.capacity) || DRIVER_CAPACITY;

  const confirmRemove = async (agentId) => {
    try {
      await dispatch({ type: "TRIP/REMOVE_AGENT", trip_id: trip.trip_id, agent_id: agentId });
    } catch (e) {
      console.warn("[TripDetailRow] remove agent failed:", e.message);
    } finally {
      setRemovingId(null);
    }
  };

  const toggleOpen = () => {
    setOpen(o => {
      const next = !o;
      // Fetch delays only the first time this row is expanded, not on
      // every render — a trip with no delays never needs re-fetching.
      if (next && delays === null) {
        fetchTripDelays(trip.trip_id).then(setDelays).catch(() => setDelays([]));
      }
      return next;
    });
  };

  return (
    <>
      <div onClick={toggleOpen} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: `1px solid ${COLORS.wire}` }}>
        <span style={{ width: 80, fontSize: 10, color: COLORS.amber, fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
          {trip.trip_id}
          {trip.is_exception && (
            <span title={exceptionLabel(trip) || "Exception"} style={{ fontSize: 9, fontWeight: 800, color: "#000", background: COLORS.red, borderRadius: 2, width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>E</span>
          )}
        </span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 11 }}>
          {trip.agent_ids.length} passenger{trip.agent_ids.length !== 1 ? "s" : ""}
        </span>
        {trip.long_distance_flag && <span style={{ fontSize: 8, fontWeight: 700, color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 2, padding: "2px 5px" }}>40km+</span>}
        <StateBadge state={trip.state} />
        <span style={{ color: COLORS.ghost, fontSize: 11 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ background: COLORS.surface, borderBottom: `1px solid ${COLORS.wire}`, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {delays && delays.length > 0 && (
            <div style={{ background: "rgba(245,166,35,.08)", border: "1px solid rgba(245,166,35,.3)", borderRadius: 4, padding: 10 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.amber, letterSpacing: 1 }}>⏱ DELAY/DETOUR REPORTED</span>
              {delays.map(d => (
                <div key={d.id} style={{ fontSize: 10, color: COLORS.chalk, marginTop: 4 }}>
                  <span style={{ fontWeight: 700 }}>{d.reason}</span>{d.note ? ` — ${d.note}` : ""}
                  <span style={{ color: COLORS.ghost }}> ({epochToDisplay(d.reported_at)})</span>
                </div>
              ))}
            </div>
          )}
          {trip.admin_note && (
            <div style={{ background: "rgba(232,58,58,.08)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 10 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, letterSpacing: 1 }}>⚠ ADMIN NOTE</span>
              <div style={{ fontSize: 10, color: COLORS.chalk, marginTop: 3 }}>{trip.admin_note}</div>
            </div>
          )}
          {trip.no_shows && trip.no_shows.length > 0 && (
            <div style={{ background: "rgba(232,58,58,.08)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 10 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, letterSpacing: 1 }}>🚫 NO SHOW{trip.no_shows.length > 1 ? "S" : ""}</span>
              {trip.no_shows.map((ns, i) => {
                const nsAgent = state.users.find(u => String(u.id) === String(ns.agent_id));
                // (0,0) is a real GPS-failure artifact on some devices,
                // not a real location — treated as "not available" here
                // too, in case any bad data from before this was fixed
                // still exists in the database.
                const hasRealLocation = ns.location && !(ns.location.lat === 0 && ns.location.lng === 0);
                return (
                  <div key={i} style={{ fontSize: 10, color: COLORS.chalk, marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span><span style={{ fontWeight: 700 }}>{nsAgent?.name || ns.agent_id}</span> <span style={{ color: COLORS.ghost }}>({epochToDisplay(ns.ts)})</span></span>
                    {hasRealLocation ? (
                      <a
                        href={`https://www.google.com/maps?q=${ns.location.lat},${ns.location.lng}`}
                        target="_blank" rel="noopener noreferrer"
                        style={{ color: COLORS.teal, fontSize: 9, textDecoration: "underline" }}
                      >
                        📍 Driver's location at the time ({ns.location.lat.toFixed(5)}, {ns.location.lng.toFixed(5)})
                      </a>
                    ) : (
                      <span style={{ color: COLORS.ghost, fontSize: 9 }}>Location not available</span>
                    )}
                    {ns.note && <span style={{ color: COLORS.ghost, fontSize: 9 }}>Note: {ns.note}</span>}
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>TYPE: </span>{trip.trip_type}</span>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>DATE: </span>{trip.scheduled_date}</span>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>TIME: </span>{trip.scheduled_time}</span>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>PHONE: </span>{trip.phone}</span>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>PICKUP #: </span>{trip.pickup_order_num ?? "—"}</span>
            <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>DROP #: </span>{trip.drop_sequence_num ?? "—"}</span>
            {driver && <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>DRIVER: </span>{driver.name}</span>}
            {driver && canEdit && (
              <Button title="✕ REMOVE DRIVER" variant="danger" size="sm" onClick={() => dispatch({ type: "TRIP/REMOVE_DRIVER", trip_id: trip.trip_id }).catch(() => {}) /* failure already toasted by the wrapper */} />
            )}
            {/* Only the real, post-trip GPS-measured distance — per
                explicit request, no pre-trip route figure (DRIVER'S
                FULL ROUTE) shown here anymore either. */}
            {trip.actual_distance_km != null && <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>ACTUAL DIST: </span><span style={{ color: COLORS.teal, fontWeight: 700 }}>{trip.actual_distance_km.toFixed(1)} km</span></span>}
            {/* Independent of the km figure above — FOUND VIA /code-review:
                removing the pre-trip route-km display also silently
                removed its red exceeds-policy color coding, with nothing
                replacing it, so a live policy breach on an in-progress
                trip became invisible to admins in-app (still exported in
                the CSV, just never shown here). Matches DriverTripsTab's
                identical fix in TransitOS_web.jsx. */}
            {trip.driver_route_exceeds_policy && (
              <span style={{ fontSize: 10, width: "100%", color: COLORS.red, fontWeight: 700 }}>⚠ Route exceeds policy</span>
            )}
          </div>

          {/* GPS trail — only shown once this trip has actually been
              started (route_total_km only ever gets set by TRIP/RECORD_ROUTE,
              the same "has Start Trip actually been tapped" signal used
              elsewhere). driver_position_log already gets a row every ~25s
              while a trip is active, but nothing ever read it back out
              until now — lazy-loaded on click, same pattern as delays
              above, since a long trip's breadcrumb trail can be hundreds
              of rows and most admins won't need it on every expand.
              Gated on viewGpsTrail (not viewDriverProfiles) — FOUND VIA
              /security-review, then per explicit follow-up request:
              this control had no permission gate at all when first
              added, so it was initially gated on viewDriverProfiles
              (same restriction as full driver profile detail). Then
              split into its own dedicated permission so Viewer-tier
              admins could be granted GPS trail access WITHOUT also
              unlocking the rest of what viewDriverProfiles gates (phone,
              home address, live status, route detail) — safe to grant
              broadly since Viewer never reaches a trip outside their own
              company here in the first place (ViewerPortal's scopedState
              already filters trips before AdminProfileSearch, the one
              place this component is reachable from for that tier, ever
              renders). The real boundary is still the driver_position_log
              RLS policy (admin-role-only reads), not this check — but
              hiding the control for a tier that can't use it anyway
              matches this file's own established convention (see
              viewTripFees/exportCsv gates nearby) and avoids a dead
              button that would just come back empty. */}
          {trip.route_total_km != null && hasAdminPermission(user, "viewGpsTrail") && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {gpsTrail === null ? (
                <Button title={gpsTrailLoading ? "LOADING…" : "📍 LOAD GPS TRAIL"} variant="ghost" size="sm" onClick={loadGpsTrail} disabled={gpsTrailLoading} />
              ) : gpsTrail.length === 0 ? (
                <span style={{ fontSize: 10, color: COLORS.ghost }}>📍 No GPS points recorded for this trip.</span>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button title="🗺️ VIEW ON MAP" variant="ghost" size="sm" onClick={() => setShowGpsTrailMap(true)} />
                  {/* Separate exportGpsTrail check — FOUND VIA /code-review:
                      viewGpsTrail alone let Viewer download the raw CSV
                      too, contradicting Viewer's own documented "can
                      never export data in any form" invariant. Its own
                      permission (not exportCsv) because FINANCIAL has
                      exportCsv:false but should still be able to export
                      this non-billing telemetry data. Viewing the trail
                      on-screen isn't exporting; downloading a file is. */}
                  {hasAdminPermission(user, "exportGpsTrail") && (
                    <Button title={`⬇ DOWNLOAD GPS TRAIL CSV (${gpsTrail.length} points)`} variant="ghost" size="sm" onClick={() => exportGpsTrailToCsv(gpsTrail, trip.trip_id)} />
                  )}
                </div>
              )}
              {gpsTrailError && <span style={{ fontSize: 10, color: COLORS.red }}>{gpsTrailError}</span>}
              {showGpsTrailMap && gpsTrail && gpsTrail.length > 0 && (
                <GpsTrailModal
                  trail={gpsTrail}
                  tripId={trip.trip_id}
                  direction={trip.direction}
                  pickupTimestamps={trip.pickup_timestamps}
                  dropoffTimestamps={trip.dropoff_timestamps}
                  pickupCoords={trip.pickup_sequence_coords}
                  // OUTBOUND (work→home) drops each agent at their own
                  // home, so the drop-offs are the interesting per-agent
                  // stops; INBOUND (home→work) picks each agent up at
                  // their own home and drops everyone at the same shared
                  // work location, so the pickups are the interesting
                  // ones — per explicit request.
                  stops={(trip.direction === "OUTBOUND" ? trip.dropoff_sequence_coords : trip.pickup_sequence_coords) || []}
                  onClose={() => setShowGpsTrailMap(false)}
                />
              )}
            </div>
          )}

          <SectionHeader label={`Passengers (${passengers.length})`} />
          {passengers.map((p, i) => {
            // Paired by agent_id, not array index — `passengers` is
            // filter(Boolean)'d over agent_ids, so its indices desync from
            // pickup_sequence_coords the moment any user record is
            // missing; index pairing then attributed pickup points to the
            // wrong passengers. Index-0 fallback covers the primary agent
            // on legacy coords that predate agent_id stamping.
            const pickup = trip.pickup_sequence_coords?.find(c => String(c.agent_id) === String(p.id))
              ?? (String(trip.agent_ids[0]) === String(p.id) ? trip.pickup_sequence_coords?.[0] : null);
            // Per-agent dropoff — OUTBOUND trips have one home address per agent.
            // Try: (1) stored dropoff_sequence_coords entry by agent_id,
            // (2) position-0 fallback for the primary agent on legacy coords,
            // (3) user's home_address for OUTBOUND trips where extradropoffs
            //     wasn't stored (trips dispatched before the per-agent dropoff
            //     feature was added) — avoids showing wrong address for non-primary agents.
            const agentDropoff = (trip.dropoff_sequence_coords?.find(c => String(c.agent_id) === String(p.id))
              ?? (String(trip.agent_ids[0]) === String(p.id) ? trip.dropoff_sequence_coords?.[0] : null))
              ?? (trip.direction === "OUTBOUND" && state.users.find(u => String(u.id) === String(p.id))?.home_address
                ? { ...state.users.find(u => String(u.id) === String(p.id)).home_address, _derived: true }
                : null);
            const pickedUp = trip.completed_pickups?.some(c => String(c) === String(p.id));
            const droppedOff = (trip.completed_dropoffs || []).some(c => String(c) === String(p.id));
            const driverName = trip.driver_id ? state.users.find(u => String(u.id) === String(trip.driver_id))?.name : null;
            const isRelocating = String(relocatingId) === String(p.id);
            const isConfirmingRemove = String(removingId) === String(p.id);
            return (
              <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                  <DriverAvatar name={p.name} isOnline={p.is_online} size={28} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{p.name}</span>
                    {pickedUp && <span style={{ fontSize: 9, color: COLORS.green, marginLeft: 6 }}>✓ picked up</span>}
                    {droppedOff && driverName && <span style={{ fontSize: 9, color: COLORS.teal, marginLeft: 6 }}>✓ dropped by {driverName}</span>}
                    <div style={{ fontSize: 9, color: COLORS.ghost }}>{pickup?.label || "—"}</div>
                    {/* Profile phone (p.phone, from state.users) wins when
                        set (most current); pickup?.phone — this agent's own
                        booking-time number, via pickup_sequence_coords — is
                        the fallback. Same priority exportTripsToCsv already
                        established for this exact problem. The trip-level
                        "PHONE:" field above only ever shows the primary
                        agent's, so a merged multi-passenger trip had no way
                        to see any other agent's number at all. FOUND VIA
                        direct user report. */}
                    {(p.phone || pickup?.phone) && (
                      <div style={{ fontSize: 9, color: COLORS.ghost }}>☎ {p.phone || pickup?.phone}</div>
                    )}
                    {agentDropoff && agentDropoff.label && agentDropoff.label !== (pickup?.label) && (
                      <div style={{ fontSize: 9, color: COLORS.red }}>◎ {agentDropoff.label}</div>
                    )}
                    {/* Actual GPS pickup address — recorded when driver taps PICKED UP */}
                    {trip.pickup_locations?.[p.id]?.label && (
                      <div style={{ fontSize: 9, color: COLORS.green, marginTop: 1 }}>
                        📍 Picked up {actualPickupOrderFor(trip, p.id) ? `(#${actualPickupOrderFor(trip, p.id)} of the run) ` : ""}at: {trip.pickup_locations[p.id].label}
                      </div>
                    )}
                    {/* Actual GPS dropoff address — recorded when driver taps DROPPED OFF */}
                    {trip.dropoff_locations?.[p.id]?.label && (
                      <div style={{ fontSize: 9, color: COLORS.teal, marginTop: 1 }}>
                        📍 Dropped off {actualDropOrderFor(trip, p.id) ? `(#${actualDropOrderFor(trip, p.id)} of the run) ` : ""}at: {trip.dropoff_locations[p.id].label}
                      </div>
                    )}
                  </div>
                  {pickup?.lat && <Button title="🧭 P" variant="waze" size="sm" onClick={() => smartOpenWaze(pickup.lat, pickup.lng, pickup.label, trip.pickup_is_manual)} />}
                  {agentDropoff?.lat && agentDropoff.label !== pickup?.label && (
                    <Button title="🧭 D" variant="waze" size="sm" onClick={() => smartOpenWaze(agentDropoff.lat, agentDropoff.lng, agentDropoff.label, trip.dropoff_is_manual)} />
                  )}
                  {canEdit && !isRelocating && (
                    <Button title="MOVE" variant="ghost" size="sm" onClick={() => { setRelocatingId(p.id); setRemovingId(null); }} />
                  )}
                  {canEdit && passengers.length > 1 && !isConfirmingRemove && (
                    <Button title="✕" variant="danger" size="sm" onClick={() => { setRemovingId(p.id); setRelocatingId(null); }} />
                  )}
                </div>
                {isRelocating && (
                  <RelocateAgentPanel trip={trip} agent={p} currentPickup={pickup} state={state} dispatch={dispatch} onClose={() => setRelocatingId(null)} />
                )}
                {isConfirmingRemove && (
                  <div style={{ background: "rgba(232,58,58,.06)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <span style={{ fontSize: 10, color: COLORS.chalk }}>
                      {trip.driver_id
                        ? `This is an active trip — a driver (${driver?.name || "assigned"}) is already on this route. Remove ${p.name}? The driver, ${p.name}, and admins will all be notified.`
                        : `Remove ${p.name} from this booking?`}
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setRemovingId(null)} />
                      <Button title="CONFIRM REMOVE" variant="danger" size="sm" style={{ flex: 1 }} onClick={() => confirmRemove(p.id)} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {canEdit && !addingAgent && (
            trip.agent_ids.length >= tripDriverCapacity
              ? <div style={{ fontSize: 10, color: COLORS.ghost, padding: "6px 0" }}>{tripNounCap(trip)} full ({trip.agent_ids.length}/{tripDriverCapacity} seats) — remove a passenger to add another.</div>
              : <Button title={`+ ADD PASSENGER TO THIS ${tripNounCap(trip).toUpperCase()}`} variant="ghost" size="sm" onClick={() => setAddingAgent(true)} />
          )}
          {addingAgent && <AddAgentPanel trip={trip} state={state} dispatch={dispatch} onClose={() => setAddingAgent(false)} />}

          {/* DROP-OFFS footer — derives missing per-agent dropoffs from home_address
              for OUTBOUND trips dispatched before the extradropoffs feature, then
              sorts nearest-to-furthest from the company (OUTBOUND: driver leaves
              office and drops each agent at their own home in the most efficient order). */}
          {(() => {
            let allDropCoords = trip.dropoff_sequence_coords || [];
            if (trip.direction === "OUTBOUND" && allDropCoords.length < (trip.agent_ids?.length || 0)) {
              const covered = new Set(allDropCoords.map(d => d.agent_id).filter(Boolean));
              const derived = [...allDropCoords];
              (trip.agent_ids || []).forEach(aid => {
                if (covered.has(aid)) return;
                const u = state.users.find(x => String(x.id) === String(aid));
                if (u?.home_address?.lat != null) derived.push({ lat: u.home_address.lat, lng: u.home_address.lng, label: u.home_address.label, agent_id: aid, _derived: true });
              });
              allDropCoords = derived;
            }
            // Sort OUTBOUND dropoffs nearest-to-furthest from where the driver
            // actually starts drop-offs — the trip's own shared pickup point,
            // NOT the company — so the admin sees them in the same order the
            // driver will actually visit them. ROOT-CAUSE FIX: this used
            // defaultCompanyAnchor(state) (the office), the same wrong-anchor
            // bug found and fixed elsewhere this session (DriverNavTab,
            // computeLiveSequenceForDriver, AdminTripDropoffs,
            // DriverTripDropoffs) — a driver has already left the office by
            // the time they're doing OUTBOUND drop-offs.
            const dropSeqAnchor = trip.pickup_sequence_coords?.[0] || defaultCompanyAnchor(state);
            if (trip.direction === "OUTBOUND" && allDropCoords.length > 1) {
              allDropCoords = sortDropoffCoordsByProximity(allDropCoords, dropSeqAnchor);
            }
            return (
              <DropoffSequenceDisplay
                coords={allDropCoords}
                trip={trip}
                state={state}
                anchor={dropSeqAnchor}
              />
            );
          })()}

          {canEdit && (
            !confirmingCancel ? (
              <Button title={`✕ CANCEL ${tripNounCap(trip).toUpperCase()}`} variant="ghost" size="sm" onClick={() => setConfirmingCancel(true)} style={{ alignSelf: "flex-start" }} />
            ) : (
              <div style={{ background: "rgba(232,58,58,.06)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                <span style={{ fontSize: 10, color: COLORS.chalk }}>
                  Cancel {tripNoun(trip)} {trip.trip_id}? {trip.driver_id
                    ? "The assigned driver will be notified and freed up, and every passenger gets a cancellation alert."
                    : "Every passenger on it gets a cancellation alert."}
                </span>
                {cancelError && <span style={{ fontSize: 10, color: COLORS.red }}>{cancelError}</span>}
                <div style={{ display: "flex", gap: 8 }}>
                  <Button title={`KEEP ${tripNounCap(trip).toUpperCase()}`} variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => { setConfirmingCancel(false); setCancelError(null); }} />
                  <Button title="CONFIRM CANCEL" variant="danger" size="sm" style={{ flex: 1 }} onClick={adminCancelTrip} />
                </div>
              </div>
            )
          )}
        </div>
      )}
    </>
  );
}

function AdminTrips({ state, dispatch, user, jumpTripId, onJumpConsumed }) {
  const [filter, setFilter] = useState("ALL");
  const [selectedDriverId, setSelectedDriverId] = useState(null); // null = show all groups
  const [exporting, setExporting] = useState(false);
  // Date filter + multi-select delete — moved here from Dispatch per
  // explicit request, so an admin can find and remove unwanted bookings
  // from the same screen where they already browse/filter every trip,
  // rather than a separate dispatch-focused screen. The actual DELETE
  // stays scoped to still-UNASSIGNED bookings only (same as it always
  // was) — per explicit decision, this move is a relocation of the UI,
  // not an expansion of what can be bulk-deleted.
  const [dateFilter, setDateFilter] = useState("");
  // FOUND VIA /code-review (productivity audit): this is the single
  // largest, most comprehensive trip list in the app, yet unlike
  // AdminUsers/AdminProfileSearch/AdminHistory/AdminActivityLog (all
  // given search this session), it had no text search at all — finding
  // "did agent X's booking get assigned" meant scrolling/scanning by eye.
  const [searchQuery, setSearchQuery] = useState("");
  // Per-driver-group collapse — each group's trip list starts expanded
  // (matches the existing behavior before this was added), toggled by
  // tapping that group's own header. Keyed by the same string group key
  // used for `groups`/`orderedKeys` below ("UNASSIGNED" or a driver id).
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const toggleGroupCollapsed = (key) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const [selectedTripIds, setSelectedTripIds] = useState(new Set());
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkMsg, setBulkMsg] = useState(null);

  // Jump-to-trip from a notification tap — per the scan finding, an
  // admin notification previously only marked itself read with no way
  // to actually navigate to the trip it's about. Clears every filter
  // that could hide the target (state/date/driver-group) so it's
  // genuinely visible, not left invisible behind a stale filter from
  // whatever the admin was doing before tapping the notification.
  useEffect(() => {
    if (jumpTripId) {
      setFilter("ALL");
      setDateFilter("");
      setSelectedDriverId(null);
      // FOUND VIA /code-review: a stale search string was never cleared
      // here, so a notification tap could jump to a trip that the still-
      // active search text then immediately filtered right back out of
      // view, defeating the whole point of this effect.
      setSearchQuery("");
      // selectedTripIds is no longer cleared manually here — the
      // visibility-pruning effect below (keyed on displayTrips/
      // selectedDriverId) handles it: any previously-selected trip
      // that's actually hidden by these resets gets dropped there,
      // while one that stays visible correctly stays selected.
      onJumpConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTripId]);
  // Ids just successfully deleted, hidden immediately regardless of
  // refetch timing — see handleBulkDeleteTrips.
  const [locallyHiddenTripIds, setLocallyHiddenTripIds] = useState(new Set());
  const filters = ["ALL", ...Object.values(TRIP_STATE)];
  // Each step memoized on its own inputs — FOUND VIA /code-review: these
  // were plain consts before, rebuilt with a fresh array identity every
  // render; the displayTrips memo below depends on displayTripsByDate, so
  // an unstable identity here defeated that memoization entirely (it
  // re-ran the full search filter on every render, not just on actual
  // search/filter changes).
  const visibleStateTrips = React.useMemo(
    () => state.trips.filter(t => !locallyHiddenTripIds.has(t.trip_id)),
    [state.trips, locallyHiddenTripIds]
  );
  const displayTripsByState = React.useMemo(
    () => filter === "ALL" ? visibleStateTrips : visibleStateTrips.filter(t => t.state === filter),
    [visibleStateTrips, filter]
  );
  const displayTripsByDate = React.useMemo(
    () => dateFilter ? displayTripsByState.filter(t => t.scheduled_date === dateFilter) : displayTripsByState,
    [displayTripsByState, dateFilter]
  );
  // FOUND VIA /code-review: state.users.find() per agent per trip was an
  // O(trips × agents × users) linear scan on every render — reusing the
  // same usersById-Map pattern computeGroupSuggestions already uses for
  // this identical trips×agents×users shape (AdminSection.jsx:1009).
  const usersById = React.useMemo(() => usersByIdMap(state.users), [state.users]);
  // Matches on any agent's name/staff number, the driver's name, or the
  // trip id itself — same fields AdminDispatch's own driver search and
  // AdminProfileSearch already match on, for consistency.
  const displayTrips = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return displayTripsByDate;
    return displayTripsByDate.filter(t => {
      if (String(t.trip_id).toLowerCase().includes(q)) return true;
      // FOUND VIA /code-review (7th pass): `if (t.driver_id)` treats a
      // driver_id of 0 as falsy/missing, same bug class the geofence
      // coord.lat check was fixed for elsewhere in this diff.
      if (t.driver_id != null) {
        const driverUser = usersById.get(String(t.driver_id));
        if ((driverUser?.name || "").toLowerCase().includes(q)) return true;
      }
      return (t.agent_ids || []).some(id => {
        const u = usersById.get(String(id));
        return (u?.name || "").toLowerCase().includes(q) || (u?.staff_number || "").toLowerCase().includes(q);
      });
    });
  }, [displayTripsByDate, searchQuery, usersById]);
  const availableTripDates = [...new Set(state.trips.map(t => t.scheduled_date).filter(Boolean))].sort();
  // Per explicit decision: this trips CSV always includes the Trip Fee
  // column/total now, so access to it is gated by viewTripFees (Fleet
  // Ops/Financial only) rather than the general exportCsv permission
  // Standard admins still have for other exports.
  const canExport = hasAdminPermission(user, "viewTripFees");
  const canEditTrips = hasAdminPermission(user, "manageTrips");
  const toggleTripSelect = (tripId) => {
    setSelectedTripIds(prev => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId); else next.add(tripId);
      return next;
    });
  };
  const selectedUnassignedIds = [...selectedTripIds].filter(id => state.trips.find(t => t.trip_id === id)?.state === TRIP_STATE.UNASSIGNED_BOOKING);
  const selectedCompletedIds = [...selectedTripIds].filter(id => state.trips.find(t => t.trip_id === id)?.state === TRIP_STATE.ARCHIVED_COMPLETED);
  // Every completed trip CURRENTLY VISIBLE on screen — respects
  // whatever filters are active (state filter, date filter), same as
  // displayTrips itself, per explicit decision: "select all" means all
  // completed trips you can actually see right now, not literally every
  // completed trip in the whole database regardless of filtering.
  const visibleCompletedTripIds = displayTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED).map(t => t.trip_id);
  const allVisibleCompletedSelected = visibleCompletedTripIds.length > 0 && visibleCompletedTripIds.every(id => selectedTripIds.has(id));
  const toggleSelectAllCompleted = () => {
    setSelectedTripIds(prev => {
      const next = new Set(prev);
      if (allVisibleCompletedSelected) {
        // Already all selected — this toggle deselects them, leaving
        // any selected UNASSIGNED bookings untouched.
        visibleCompletedTripIds.forEach(id => next.delete(id));
      } else {
        visibleCompletedTripIds.forEach(id => next.add(id));
      }
      return next;
    });
  };
  const handleBulkDeleteTrips = async () => {
    if (selectedUnassignedIds.length === 0 && selectedCompletedIds.length === 0) return;
    setBulkDeleting(true);
    try {
      // A selection can contain BOTH categories at once (an admin
      // multi-selecting across different driver groups) — each needs
      // its own action (different safety scope per action, see the
      // reducer cases), so both are dispatched when both are present,
      // then combined into one summary message.
      const [unassignedResults, completedResults] = await Promise.all([
        selectedUnassignedIds.length > 0 ? dispatch({ type: "TRIP/ADMIN_BULK_DELETE_UNASSIGNED", trip_ids: selectedUnassignedIds }) : Promise.resolve([]),
        selectedCompletedIds.length > 0 ? dispatch({ type: "TRIP/ADMIN_BULK_DELETE_COMPLETED", trip_ids: selectedCompletedIds }) : Promise.resolve([]),
      ]);
      const allResults = [...(unassignedResults || []), ...(completedResults || [])];
      const okCount = allResults.filter(r => r.ok).length;
      const failResults = allResults.filter(r => !r.ok);
      setBulkMsg(failResults.length === 0
        ? `✓ Deleted ${okCount} item${okCount !== 1 ? "s" : ""}`
        : `⚠ Deleted ${okCount}, ${failResults.length} skipped — ${failResults.map(r => r.reason).join("; ")}`);
      // Belt-and-suspenders: the dispatch above already triggers a real
      // backend refetch (Supabase mode) or a direct state mutation (demo
      // mode), both of which SHOULD make deleted trips vanish from this
      // screen on their own. This makes it deterministic and immediate
      // regardless — every successfully-deleted id is excluded from the
      // locally-rendered list right away, rather than the screen relying
      // purely on the async refetch's timing to catch up.
      const justDeletedIds = new Set(allResults.filter(r => r.ok).map(r => r.trip_id));
      setLocallyHiddenTripIds(prev => new Set([...prev, ...justDeletedIds]));
      setSelectedTripIds(new Set()); setConfirmingBulkDelete(false);
    } catch (e) {
      setBulkMsg(`✗ ${e.message || "Delete failed — please try again."}`);
    } finally {
      setBulkDeleting(false);
    }
  };

  // Group by driver_id — trips with no driver assigned yet land in their
  // own "Unassigned" group rather than being dropped from the view.
  const groups = {};
  displayTrips.forEach(t => {
    const key = t.driver_id ?? "UNASSIGNED";
    (groups[key] ||= []).push(t);
  });
  const driverIds = Object.keys(groups).filter(k => k !== "UNASSIGNED");
  // Group keys come from Object.keys() so they're always strings, but
  // user ids are numbers (Supabase bigint) OR strings ("USR_…" in demo
  // mode) — Number(key) turned demo ids into NaN, breaking driver names
  // and the per-driver filter there. String-compare instead, which is
  // correct for both id shapes.
  // FOUND VIA /code-review (9th pass): re-scanned state.users per call
  // instead of reusing usersById (already in scope two lines above for
  // this exact O(trips × users) shape) — called once per driver-group
  // header/button, which at this app's target scale (~1800 agents) adds
  // up across every render.
  const findUserByKey = (key) => usersById.get(String(key));
  const sortedDriverIds = driverIds.sort((a, b) => {
    const nameA = findUserByKey(a)?.name || "";
    const nameB = findUserByKey(b)?.name || "";
    return nameA.localeCompare(nameB);
  });
  const orderedKeys = [...sortedDriverIds, ...(groups.UNASSIGNED ? ["UNASSIGNED"] : [])];
  const visibleKeys = selectedDriverId ? orderedKeys.filter(k => k === String(selectedDriverId)) : orderedKeys;

  // Prunes the bulk-delete selection to whatever is actually rendered
  // under the CURRENT filters (status/date/search/driver-group), rather
  // than wiping the whole selection on every filter-changing
  // interaction. FOUND VIA /code-review (6th pass): the search input's
  // per-keystroke full clear was far more disruptive than intended —
  // every character typed wiped an in-progress bulk-delete selection
  // even for trips that stayed visible. Replaces that and the other
  // setSelectedTripIds(new Set()) calls previously scattered across the
  // status filter, date filter, driver-group buttons, and the
  // notification jump effect: a trip still visible after whatever
  // filter just changed stays selected; one that's been filtered out of
  // view is dropped — the actual hazard those calls existed to guard
  // against, not a full wipe on every interaction.
  useEffect(() => {
    const renderedIds = new Set(visibleKeys.flatMap(k => groups[k]).map(t => t.trip_id));
    setSelectedTripIds(prev => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter(id => renderedIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayTrips, selectedDriverId]);

  return (
    <div className="pad">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {filters.map(f => <Button key={f} size="sm" variant={filter === f ? "amber" : "ghost"} title={f === "ALL" ? "ALL" : f.replace("_BOOKING", "").replace("ARCHIVED_", "")} onClick={() => setFilter(f)} />)}
        {canExport && (
          <Button
            size="sm" variant="ghost"
            title={exporting ? "EXPORTING…" : `⬇ EXPORT CSV (${displayTrips.length})`}
            disabled={exporting}
            onClick={async () => {
              setExporting(true);
              try {
                const tripIds = displayTrips.map(t => t.trip_id);
                const [delaysByTrip, auditByTrip] = await Promise.all([
                  fetchDelaysForTrips(tripIds),
                  fetchAuditLogsForTrips(tripIds),
                ]);
                exportTripsToCsv(displayTrips, state.users, state.driver_status, filter === "ALL" ? "all_trips" : `trips_${filter.toLowerCase()}`, delaysByTrip, auditByTrip, state.fee_rates);
              } catch (e) {
                // Without this catch, a throw here (e.g. CSV/Blob build
                // failing) escaped the onClick as an unhandled rejection
                // with the button stuck saying nothing happened.
                console.warn("[AdminTrips] CSV export failed:", e.message);
              } finally {
                setExporting(false);
              }
            }}
            style={{ marginLeft: "auto" }}
          />
        )}
      </div>

      <div>
        <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>SEARCH</label>
        <input
          className="inp" value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Agent name / staff number / driver name / trip ID…" style={{ width: "100%" }}
        />
      </div>

      {availableTripDates.length > 1 && (
        <div>
          <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>FILTER BY DATE</label>
          <select className="inp" value={dateFilter} onChange={e => setDateFilter(e.target.value)} style={{ width: "100%" }}>
            <option value="">All dates</option>
            {availableTripDates.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
      )}

      {canEditTrips && visibleCompletedTripIds.length > 0 && (
        <Button
          title={allVisibleCompletedSelected ? `☑ DESELECT ALL COMPLETED (${visibleCompletedTripIds.length})` : `☐ SELECT ALL COMPLETED (${visibleCompletedTripIds.length})`}
          variant="ghost" size="sm" onClick={toggleSelectAllCompleted} style={{ alignSelf: "flex-start" }}
        />
      )}

      {/* FOUND VIA /code-review (11th pass): gated purely on
          driverIds.length > 1 (how many driver groups the CURRENT
          search/date/status filters happen to leave standing) — if a
          search narrowed the trip list down to a single driver's trips
          while a DIFFERENT driver was selected, this whole bar (the only
          way to reset selectedDriverId) vanished, leaving no visible
          path back to a non-empty view. Also shows whenever a driver
          filter is active, regardless of how many groups currently
          remain, so "ALL DRIVERS" always stays reachable. */}
      {(driverIds.length > 1 || selectedDriverId) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button size="sm" variant={!selectedDriverId ? "amber" : "ghost"} title="ALL DRIVERS" onClick={() => setSelectedDriverId(null)} />
          {sortedDriverIds.map(id => (
            <Button key={id} size="sm" variant={String(selectedDriverId) === id ? "amber" : "ghost"}
              title={`${findUserByKey(id)?.name || id} (${groups[id].length})`}
              onClick={() => setSelectedDriverId(id)} />
          ))}
        </div>
      )}

      {displayTrips.length === 0 ? (
        <Empty icon="⊟" text="No bookings or trips" />
      ) : visibleKeys.length === 0 ? (
        // FOUND VIA /code-review (11th pass): the driver-group filter
        // (selectedDriverId) isn't baked into displayTrips itself — a
        // search/date/status change can leave the selected driver with
        // zero matching trips while displayTrips is still non-empty for
        // OTHER drivers, which previously rendered nothing at all with
        // no message, since only displayTrips.length was checked here.
        <Empty icon="⊟" text="This driver has no trips matching the current search/filters — try ALL DRIVERS above." />
      ) : visibleKeys.map(key => {
        const isUnassigned = key === "UNASSIGNED";
        const driverUser = isUnassigned ? null : findUserByKey(key);
        const groupTrips = groups[key];
        const isCollapsed = collapsedGroups.has(key);
        return (
          <div key={key}>
            <div
              onClick={() => toggleGroupCollapsed(key)}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px 4px", cursor: "pointer" }}
            >
              <span style={{ fontSize: 10, color: COLORS.ghost, width: 12, textAlign: "center" }}>{isCollapsed ? "▸" : "▾"}</span>
              {!isUnassigned && <DriverAvatar name={driverUser?.name} isOnline={driverUser?.is_online} size={26} />}
              <span style={{ fontFamily: FONTS.head, fontSize: 13, fontWeight: 800, color: isUnassigned ? COLORS.ghost : COLORS.chalk }}>
                {isUnassigned ? "UNASSIGNED" : (driverUser?.name || `Driver ${key}`)}
              </span>
              <span style={{ fontSize: 10, color: COLORS.ghost }}>({groupTrips.length} {isUnassigned ? "booking" : "trip"}{groupTrips.length !== 1 ? "s" : ""})</span>
              {/* No pre-trip route-km summary here anymore, per explicit
                  request (only exact kms on the admin side) — these are
                  active, not-yet-completed trips, so there's no exact
                  figure to show for them yet. */}
            </div>
            {!isCollapsed && (
            <Card body={false}>
              {groupTrips.map(t => {
                const isSelectable = canEditTrips && (t.state === TRIP_STATE.UNASSIGNED_BOOKING || t.state === TRIP_STATE.ARCHIVED_COMPLETED);
                if (!isSelectable) {
                  return <TripDetailRow key={t.trip_id} trip={t} state={state} dispatch={canEditTrips ? dispatch : null} initiallyOpen={String(t.trip_id) === String(jumpTripId)} user={user} />;
                }
                const checked = selectedTripIds.has(t.trip_id);
                return (
                  <div key={t.trip_id} style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <div onClick={() => toggleTripSelect(t.trip_id)} style={{ padding: "14px 0 0 10px", cursor: "pointer", flexShrink: 0 }}>
                      <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${checked ? COLORS.amber : COLORS.wire}`, background: checked ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink }}>{checked && "✓"}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TripDetailRow trip={t} state={state} dispatch={dispatch} initiallyOpen={String(t.trip_id) === String(jumpTripId)} user={user} />
                    </div>
                  </div>
                );
              })}
            </Card>
            )}
          </div>
        );
      })}

      {bulkMsg && (
        <div style={{ background: bulkMsg.startsWith("✗") ? "rgba(232,58,58,.08)" : "rgba(29,185,84,.08)", border: `1px solid ${bulkMsg.startsWith("✗") ? "rgba(232,58,58,.3)" : "rgba(29,185,84,.3)"}`, borderRadius: 4, padding: 10 }}>
          <span style={{ color: bulkMsg.startsWith("✗") ? COLORS.red : COLORS.green, fontWeight: 700, fontSize: 11 }}>{bulkMsg}</span>
        </div>
      )}
      {(selectedUnassignedIds.length > 0 || selectedCompletedIds.length > 0) && (() => {
        const totalSelected = selectedUnassignedIds.length + selectedCompletedIds.length;
        return confirmingBulkDelete ? (
          <div style={{ background: "rgba(232,58,58,.06)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8, position: "sticky", bottom: 8 }}>
            <span style={{ fontSize: 11, color: COLORS.chalk }}>
              Delete {totalSelected} selected item{totalSelected !== 1 ? "s" : ""}
              {selectedUnassignedIds.length > 0 && selectedCompletedIds.length > 0
                ? ` (${selectedUnassignedIds.length} unassigned booking${selectedUnassignedIds.length !== 1 ? "s" : ""}, ${selectedCompletedIds.length} completed trip${selectedCompletedIds.length !== 1 ? "s" : ""})`
                : ""}? This can't be undone.
            </span>
            {selectedCompletedIds.length > 0 && (
              <span style={{ fontSize: 10, color: COLORS.red, fontWeight: 700 }}>
                ⚠ {selectedCompletedIds.length} of these {selectedCompletedIds.length !== 1 ? "are" : "is a"} completed trip{selectedCompletedIds.length !== 1 ? "s" : ""} — a real historical record, permanently removed from CSV exports and driver trip counts too, not just this list.
              </span>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setConfirmingBulkDelete(false)} />
              <Button title={bulkDeleting ? "DELETING…" : `DELETE ${totalSelected}`} variant="danger" size="sm" style={{ flex: 1 }} onClick={handleBulkDeleteTrips} disabled={bulkDeleting} loading={bulkDeleting} />
            </div>
          </div>
        ) : (
          <Button title={`🗑 DELETE ${totalSelected} SELECTED`} variant="ghost" size="sm" onClick={() => setConfirmingBulkDelete(true)} style={{ alignSelf: "flex-start", position: "sticky", bottom: 8 }} />
        );
      })()}
    </div>
  );
}

function AdminProfileSearch({ state, user, dispatch }) {
  const [query, setQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [historyTrips, setHistoryTrips] = useState(null); // null = not loaded yet
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Viewer can search agent profiles only — driver profiles require
  // viewDriverProfiles, which Viewer doesn't have.
  const canSearchDrivers = hasAdminPermission(user, "viewDriverProfiles");
  const searchable = state.users.filter(u => u.role === ROLE.AGENT || (canSearchDrivers && u.role === ROLE.DRIVER));
  const matches = query.trim().length >= 1
    ? searchable.filter(u => u.name.toLowerCase().includes(query.trim().toLowerCase()) || (u.staff_number || "").toLowerCase().includes(query.trim().toLowerCase()))
    : [];

  const selectedUser = selectedUserId ? state.users.find(u => String(u.id) === String(selectedUserId)) : null;
  const driverStatus = selectedUser?.role === ROLE.DRIVER ? state.driver_status.find(d => String(d.driver_id) === String(selectedUser.id)) : null;

  const selectProfile = async (u) => {
    setSelectedUserId(u.id);
    setQuery("");
    setHistoryTrips(null);
    setLoadingHistory(true);
    try {
      const hits = await fetchTripHistory(u.role === ROLE.AGENT ? { agentId: u.id } : { driverId: u.id });
      // Same scoping principle as the trip-search tab's runSearch/
      // runSearchWithRange — FOUND VIA /code-review: fetchTripHistory
      // queries by agent/driver id only, with no company filter, so
      // without this a Viewer could reassign-then-search their way into
      // an agent's out-of-scope-company trip history (and from there, GPS
      // trail data) just by the agent's CURRENT branch_id matching. No
      // manual company picker exists on this tab (unlike the search tab),
      // so this is a straight scope-or-don't, no user-selected override.
      setHistoryTrips(isCompanyScoped(user, state.companies) ? scopeTripsToCompany(hits, state.users, getAdminCompanyIds(user, state.companies)) : hits);
    } catch (e) {
      setHistoryTrips([]);
    } finally {
      setLoadingHistory(false);
    }
  };

  // Live (current-and-previous-month-or-active) trips for this person, from state
  // already in memory — combined with the fetched full history above so
  // "all their trips" genuinely means all of them, not just the recent
  // window the rest of the app deliberately limits itself to.
  const liveTrips = selectedUser
    ? state.trips.filter(t => selectedUser.role === ROLE.AGENT ? t.agent_ids?.some(id => String(id) === String(selectedUser.id)) : t.driver_id === selectedUser.id)
    : [];
  const liveTripIds = new Set(liveTrips.map(t => t.trip_id));
  const allTrips = [...liveTrips, ...(historyTrips || []).filter(t => !liveTripIds.has(t.trip_id))]
    .sort((a, b) => (b.scheduled_time_epoch || 0) - (a.scheduled_time_epoch || 0));

  const exceptionCount = allTrips.filter(t => t.is_exception).length;
  const completedCount = allTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED).length;
  // On-screen totals — per explicit request ("the finance admin side
  // still doesn't capture the total of the trip per agent and also the
  // total trip cost"). These figures already existed, correctly computed,
  // inside the CSV's trailing GRAND TOTAL row (tripTotalFeeAmount/
  // tripDriverPayment, same as exportTripsToCsv) — but were never
  // actually shown anywhere on screen, only reachable by downloading and
  // opening the export. De-dupe
  // by trip_id first (same convention the CSV total row already uses) so
  // a multi-passenger trip's fee/pay isn't counted once per passenger row.
  // tripTotalFeeAmount already sums every agent's own outcome-based share
  // for a trip (see its own comment) — this matches the CSV export's
  // grand total exactly, both now built on the same per-agent model.
  const uniqueTripsForTotal = Array.from(new Map(allTrips.map(t => [t.trip_id, t])).values());
  const totalTripFee = state.fee_rates ? uniqueTripsForTotal.reduce((sum, t) => sum + (tripTotalFeeAmount(t, state.fee_rates) || 0), 0) : null;
  const totalDriverPay = state.fee_rates ? uniqueTripsForTotal.reduce((sum, t) => sum + (tripDriverPayment(t, state.fee_rates)?.total || 0), 0) : null;

  return (
    <div className="pad">
      <SectionHeader label={canSearchDrivers ? "Search Agent / Driver Profiles" : "Search Agent Profiles"} />
      <TextField
        label="Search by name or staff number"
        value={query}
        onChange={e => { setQuery(e.target.value); setSelectedUserId(null); }}
        placeholder="e.g. Nomsa Dlamini or AG1001"
      />
      {matches.length > 0 && (
        <Card body={false}>
          {matches.slice(0, 10).map(u => (
            <div key={u.id} onClick={() => selectProfile(u)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 10, borderBottom: `1px solid ${COLORS.wire}` }}>
              <DriverAvatar name={u.name} isOnline={u.is_online} size={28} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700 }}>{u.name}</div>
                <div style={{ fontSize: 9, color: COLORS.ghost }}>Staff #: {u.staff_number || "—"}</div>
              </div>
              <RoleBadge role={u.role} />
            </div>
          ))}
        </Card>
      )}

      {selectedUser && (
        <>
          <Card>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <DriverAvatar name={selectedUser.name} isOnline={selectedUser.is_online} size={48} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FONTS.head, fontSize: 17, fontWeight: 800 }}>{selectedUser.name}</div>
                <div style={{ fontSize: 10, color: COLORS.ghost }}>Staff #: {selectedUser.staff_number || "—"}</div>
              </div>
              <RoleBadge role={selectedUser.role} />
            </div>
          </Card>

          {/* Full stored profile — same component the Users tab uses, so
              anything visible there (branch history, campaign, admin
              level, etc.) shows up here too instead of a thinner
              duplicate that drifts out of sync over time. */}
          <UserProfilePanel u={selectedUser} driverStatus={driverStatus} state={state} />

          <Card>
            <div style={{ display: "flex", gap: 16 }}>
              <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>TOTAL BOOKINGS: </span><span style={{ fontWeight: 700 }}>{allTrips.length}</span></span>
              <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>COMPLETED: </span><span style={{ fontWeight: 700, color: COLORS.green }}>{completedCount}</span></span>
              {exceptionCount > 0 && <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>EXCEPTIONS: </span><span style={{ fontWeight: 700, color: COLORS.red }}>{exceptionCount}</span></span>}
              {hasAdminPermission(user, "viewTripFees") && totalTripFee != null && (
                <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>TOTAL TRIP COST: </span><span style={{ fontWeight: 700, color: COLORS.amber }}>R{totalTripFee.toFixed(2)}</span></span>
              )}
              {hasAdminPermission(user, "viewTripFees") && totalDriverPay != null && (
                <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>DRIVER PAY TOTAL: </span><span style={{ fontWeight: 700, color: COLORS.teal }}>R{totalDriverPay.toFixed(2)}</span></span>
              )}
              {allTrips.length > 0 && <DisputeAdminPanel trip={allTrips[0]} dispatch={dispatch} users={state.users} />}
              {allTrips.length > 0 && [TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(allTrips[0].state) && (
                <button onClick={() => copyShareLink(allTrips[0], dispatch)}
                  style={{ fontSize: 9, color: COLORS.teal, fontWeight: 700, border: `1px solid ${COLORS.teal}`, padding: "2px 6px", borderRadius: 2, background: "none", cursor: "pointer" }}>
                  🔗 {allTrips[0].share_token ? "COPY SHARE LINK" : "GENERATE LIVE LINK"}
                </button>
              )}
            </div>
            <span style={{ fontSize: 8, color: COLORS.ghost }}>Counts here cover this person's FULL history (fetched on demand) — the profile panel above only shows the live current+previous-month window, same as the rest of the app.</span>
            {hasAdminPermission(user, "viewTripFees") && allTrips.length > 0 && (
              <Button size="sm" variant="ghost" title={exporting ? "EXPORTING…" : "⬇ EXPORT THIS PERSON'S BOOKINGS"} disabled={exporting} onClick={async () => {
                setExporting(true);
                try {
                  const tripIds = allTrips.map(t => t.trip_id);
                  const [delaysByTrip, auditByTrip] = await Promise.all([
                    fetchDelaysForTrips(tripIds),
                    fetchAuditLogsForTrips(tripIds),
                  ]);
                  exportTripsToCsv(allTrips, state.users, state.driver_status, `${selectedUser.name.replace(/\s+/g, "_")}_trips`, delaysByTrip, auditByTrip, state.fee_rates);
                } finally {
                  setExporting(false);
                }
              }} />
            )}
          </Card>

          <SectionHeader label={`Trip History (${allTrips.length})`} />
          {loadingHistory && <div style={{ fontSize: 10, color: COLORS.ghost, padding: 10 }}>Loading full history…</div>}
          {!loadingHistory && allTrips.length === 0 && <Empty icon="⊟" text="No trips found for this person" />}
          {!loadingHistory && allTrips.length > 0 && (
            <Card body={false}>
              {allTrips.map(t => <TripDetailRow key={t.trip_id} trip={t} state={state} dispatch={null} user={user} />)}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FeeRatesPanel({ state, user, dispatch }) {
  const rates = state.fee_rates;
  const [normal, setNormal] = useState("");
  const [lateBooking, setLateBooking] = useState("");
  const [lateCancellation, setLateCancellation] = useState("");
  const [noShow, setNoShow] = useState("");
  const [driverPayPerAgent, setDriverPayPerAgent] = useState("");
  const [driverPayPerExtraKm, setDriverPayPerExtraKm] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [edited, setEdited] = useState(false);

  // Pre-fill from the live rates once loaded — but only until the admin
  // starts actually editing, so a realtime update from another admin's
  // save doesn't yank the field out from under whatever this admin is
  // mid-typing.
  useEffect(() => {
    if (edited || !rates) return;
    setNormal(String(rates.normal_zar));
    setLateBooking(String(rates.late_booking_zar));
    setLateCancellation(String(rates.late_cancellation_zar));
    setNoShow(String(rates.no_show_zar));
    setDriverPayPerAgent(String(rates.driver_pay_per_agent_zar));
    setDriverPayPerExtraKm(String(rates.driver_pay_per_extra_km_zar));
  }, [rates, edited]);

  if (!hasAdminPermission(user, "manageFeeRates")) return null;

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      await dispatch({
        type: "ADMIN/UPDATE_FEE_RATES",
        normal_zar: parseFloat(normal) || 0, late_booking_zar: parseFloat(lateBooking) || 0,
        late_cancellation_zar: parseFloat(lateCancellation) || 0, no_show_zar: parseFloat(noShow) || 0,
        driver_pay_per_agent_zar: parseFloat(driverPayPerAgent) || 0,
        driver_pay_per_extra_km_zar: parseFloat(driverPayPerExtraKm) || 0,
      });
      setEdited(false);
      setSaveMsg("Saved.");
      setTimeout(() => setSaveMsg(null), 3000);
    } catch (e) {
      setSaveMsg(e.message || "Couldn't save the fee rates.");
    } finally {
      setSaving(false);
    }
  };

  const field = (label, value, setValue) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 110 }}>
      <span style={{ fontSize: 9, color: COLORS.ghost }}>{label}</span>
      <input type="number" min="0" step="0.01" value={value}
        onChange={e => { setValue(e.target.value); setEdited(true); }}
        style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 3, padding: "6px 8px", fontSize: 12 }} />
    </div>
  );

  return (
    <div style={{ background: "rgba(245,166,35,.06)", border: "1px solid rgba(245,166,35,.25)", borderRadius: 6, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.amber }}>💰 TRIP FEE RATES</div>
        <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>Sets the Trip Fee (ZAR) column/total on the trips CSV — visible to Fleet Ops and Financial admins only.</div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {field("Normal", normal, setNormal)}
        {field("Late Booking", lateBooking, setLateBooking)}
        {field("Late Cancellation", lateCancellation, setLateCancellation)}
        {field("No Show", noShow, setNoShow)}
      </div>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.amber, marginTop: 4 }}>🚗 DRIVER PAYMENT (REFERENCE)</div>
        <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>What the driver earns — shown as reference columns on the same CSV, separate from the client-billed Trip Fee above. "Extra km" is distance beyond the existing 40km long-distance threshold.</div>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {field("Per Agent / Trip", driverPayPerAgent, setDriverPayPerAgent)}
        {field("Per Extra KM", driverPayPerExtraKm, setDriverPayPerExtraKm)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button title={saving ? "SAVING…" : "SAVE RATES"} variant="amber" size="sm" disabled={saving || !rates} onClick={save} />
        {saveMsg && <span style={{ fontSize: 10, color: COLORS.ghost }}>{saveMsg}</span>}
      </div>
    </div>
  );
}

function AdminHistory({ state, user, dispatch }) {
  // Viewer is capped at 60 days of trip history; other tiers keep the
  // existing 90-day default (which was never a hard cap for them, just a
  // starting point — they can still pick any earlier date).
  const isViewer = user.admin_level === ADMIN_LEVEL.VIEWER;
  const maxLookbackDays = isViewer ? 60 : 90;
  // SAST-pinned (sastTodayStr/shiftDateStr — same helpers applyQuickRange
  // below already uses) instead of new Date()/toISOString()'s UTC
  // calendar day — FOUND VIA /code-review: this component's initial
  // mount state disagreed with its own (already SAST-pinned)
  // applyQuickRange for up to 2 hours after SAST midnight. Also hoisted
  // to one earliestAllowedStr instead of recomputing
  // earliestAllowed.toISOString().slice(0,10) inline at 6 separate call
  // sites — a future edit to the lookback-clamp logic only needs to
  // change one place now.
  const earliestAllowedStr = shiftDateStr(sastTodayStr(), { days: -maxLookbackDays });
  const [fromDate, setFromDate] = useState(earliestAllowedStr);
  const [toDate, setToDate] = useState(sastTodayStr);
  const [agentFilter, setAgentFilter] = useState("");
  const [driverFilter, setDriverFilter] = useState("");
  // Company-level filter — separate from the per-agent filter above,
  // lets a non-Viewer admin narrow the whole search (and its CSV export)
  // to one or more companies at once, without picking through agents one
  // by one. Viewers don't get this control: they're already automatically
  // scoped to their assigned companies via isCompanyScoped, and manually
  // offering a company picker here would look like it lets them widen
  // that scope back out, which it must never actually do. Array (not a
  // single value) so multiple companies can be selected together, same
  // as the Viewer scoping feature itself.
  const [companyFilter, setCompanyFilter] = useState([]);
  // Both on by default — an unfiltered view shows everything, same as
  // before this feature existed. Unchecking one hides that category
  // from the already-fetched results rather than re-querying, since
  // is_exception is already present on every trip object returned by
  // fetchTripHistory.
  const [showNormal, setShowNormal] = useState(true);
  const [showException, setShowException] = useState(true);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState(null);

  const agents = state.users.filter(u => u.role === ROLE.AGENT);
  const drivers = state.users.filter(u => u.role === ROLE.DRIVER);

  // Enforced on the actual query, not just the date picker's default —
  // a Viewer could still type/select an earlier date directly into the
  // input, so this clamps whatever's actually submitted, not just what
  // the field started as.
  const handleFromDateChange = (v) => {
    if (isViewer && v < earliestAllowedStr) {
      setFromDate(earliestAllowedStr);
      return;
    }
    setFromDate(v);
  };

  const runSearch = async () => {
    setLoading(true); setErr(null);
    try {
      const effectiveFromDate = isViewer && fromDate < earliestAllowedStr ? earliestAllowedStr : fromDate;
      const fromMs = effectiveFromDate ? new Date(`${effectiveFromDate}T00:00:00`).getTime() : undefined;
      const toMs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : undefined;
      const hits = await fetchTripHistory({
        fromMs, toMs,
        agentId: agentFilter || undefined,
        driverId: driverFilter || undefined,
      });
      // fetchTripHistory queries Supabase directly, independent of the
      // already-scoped state.trips the rest of this tab reads from — so
      // a company-scoped Viewer's search still needs its own explicit
      // filter here, or it would return every company's trips regardless
      // of the scoping applied everywhere else in this tab. A non-Viewer
      // who picked one or more companies from the (Viewer-only-hidden)
      // companyFilter checklist gets the same treatment, just driven by
      // their own one-off selection instead of a permanent account-level
      // scope.
      const effectiveCompanyIds = isCompanyScoped(user, state.companies)
        ? getAdminCompanyIds(user, state.companies)
        : (companyFilter.length ? companyFilter : null);
      setResults(effectiveCompanyIds ? scopeTripsToCompany(hits, state.users, effectiveCompanyIds) : hits);
    } catch (e) {
      setErr(e.message || "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  // Quick day/week/month presets — sets the From/To fields and runs the
  // search immediately, rather than making someone manually calculate
  // and type a date range for the common cases.
  const applyQuickRange = (unit) => {
    // SAST-pinned + calendar-month-safe via shiftDateStr — the previous
    // `start.setMonth(start.getMonth() - 1)` overflowed into the wrong
    // month on any day-29/30/31 date shorter months don't have (e.g. Oct
    // 31 minus 1 month lands on Oct 1, not Sep 30), silently collapsing
    // "PAST MONTH" to a 1-day range. Found and fixed via the same bug in
    // AdminActivityLog's own quick-range helper.
    const endStr = sastTodayStr();
    const startStr = unit === "day" ? shiftDateStr(endStr, { days: -1 })
      : unit === "week" ? shiftDateStr(endStr, { days: -7 })
      : shiftDateStr(endStr, { months: -1 });
    const clampedStartStr = isViewer && startStr < earliestAllowedStr ? earliestAllowedStr : startStr;
    setFromDate(clampedStartStr);
    setToDate(endStr);
    setTimeout(() => runSearchWithRange(clampedStartStr, endStr), 0);
  };

  // Same as runSearch but takes explicit dates — needed because
  // applyQuickRange's setFromDate/setToDate calls don't take effect until
  // the next render, so runSearch() called immediately after would still
  // read the OLD state values.
  const runSearchWithRange = async (fromStr, toStr) => {
    setLoading(true); setErr(null);
    try {
      const fromMs = new Date(`${fromStr}T00:00:00`).getTime();
      const toMs = new Date(`${toStr}T23:59:59`).getTime();
      const hits = await fetchTripHistory({
        fromMs, toMs,
        agentId: agentFilter || undefined,
        driverId: driverFilter || undefined,
      });
      // Same scoping as runSearch — this was previously missing entirely
      // here, so the quick-range buttons let a company-scoped Viewer see
      // every company's trips regardless of their assigned scope.
      const effectiveCompanyIds = isCompanyScoped(user, state.companies)
        ? getAdminCompanyIds(user, state.companies)
        : (companyFilter.length ? companyFilter : null);
      setResults(effectiveCompanyIds ? scopeTripsToCompany(hits, state.users, effectiveCompanyIds) : hits);
    } catch (e) {
      setErr(e.message || "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pad">
      <FeeRatesPanel state={state} user={user} dispatch={dispatch} />
      <AuditExportPanel state={state} />
      <SectionHeader label="SLA Report (On-Time Performance)" />
      <SlaReportPanel trips={results || state.trips} users={state.users} />
      <SectionHeader label="Trip History" />
      <div style={{ fontSize: 10, color: COLORS.ghost, marginBottom: 4 }}>
        The live Trips view only shows completed trips from the last 30 days. Search here for anything older.
        {isViewer && " Your access is limited to the last 60 days of history."}
      </div>
      <Card>
        <SectionHeader label="Quick Range" />
        <div style={{ display: "flex", gap: 8 }}>
          <Button title="TODAY" size="sm" variant="ghost" onClick={() => applyQuickRange("day")} style={{ flex: 1 }} />
          <Button title="PAST WEEK" size="sm" variant="ghost" onClick={() => applyQuickRange("week")} style={{ flex: 1 }} />
          <Button title="PAST MONTH" size="sm" variant="ghost" onClick={() => applyQuickRange("month")} style={{ flex: 1 }} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 140px" }}>
            <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>FROM</label>
            <input type="date" className="inp" value={fromDate} min={isViewer ? earliestAllowedStr : undefined} onChange={e => handleFromDateChange(e.target.value)} style={{ width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>TO</label>
            <input type="date" className="inp" value={toDate} onChange={e => setToDate(e.target.value)} style={{ width: "100%" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <div style={{ flex: "1 1 160px" }}>
            <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>AGENT (optional)</label>
            <select className="inp" value={agentFilter} onChange={e => setAgentFilter(e.target.value)} style={{ width: "100%" }}>
              <option value="">All agents</option>
              {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>DRIVER (optional)</label>
            <select className="inp" value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ width: "100%" }}>
              <option value="">All drivers</option>
              {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          {!isViewer && (
            <div style={{ flex: "1 1 100%" }}>
              <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>COMPANY (optional — select any number)</label>
              {(state.companies || []).length === 0 ? (
                <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet.</span>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 4 }}>
                  {state.companies.map(c => {
                    const checked = companyFilter.includes(c.id);
                    return (
                      <div key={c.id} onClick={() => setCompanyFilter(checked ? companyFilter.filter(id => id !== c.id) : [...companyFilter, c.id])}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${checked ? COLORS.amber : COLORS.wire}`, background: checked ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{checked && "✓"}</span>
                        <span style={{ fontSize: 11, color: COLORS.chalk }}>{c.name}{!c.active ? " (inactive)" : ""}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
          <div onClick={() => setShowNormal(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${showNormal ? COLORS.amber : COLORS.wire}`, background: showNormal ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{showNormal && "✓"}</span>
            <span style={{ fontSize: 10, color: COLORS.chalk }}>Normal bookings</span>
          </div>
          <div onClick={() => setShowException(v => !v)} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${showException ? COLORS.amber : COLORS.wire}`, background: showException ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{showException && "✓"}</span>
            <span style={{ fontSize: 10, color: COLORS.chalk }}>Exception bookings <span style={{ color: COLORS.red }}>(E)</span></span>
          </div>
        </div>
        <Button title={loading ? "SEARCHING…" : "SEARCH"} variant="amber" full onClick={runSearch} disabled={loading} style={{ marginTop: 12 }} />
      </Card>

      {err && (
        <div style={{ background: "rgba(220,53,69,.08)", border: "1px solid rgba(220,53,69,.3)", borderRadius: 4, padding: 10 }}>
          <span style={{ color: COLORS.red, fontSize: 11 }}>{err}</span>
        </div>
      )}

      {results !== null && (() => {
        // Applied once here rather than duplicated across the count
        // display, the row list, and the CSV export below — all three
        // read from this same derived array, so they can never disagree
        // about what "filtered" means.
        const filteredResults = results.filter(t => (t.is_exception ? showException : showNormal));
        // On-screen totals — per explicit request ("the finance admin
        // side still doesn't capture... the total trip cost"). Same
        // figures the CSV's trailing GRAND TOTAL row already computes
        // (tripTotalFeeAmount/tripDriverPayment — each agent billed by
        // their own outcome on the trip, summed), de-duped by trip_id
        // first so a multi-passenger trip's fee/pay isn't counted once
        // per passenger row.
        const uniqueFilteredTrips = Array.from(new Map(filteredResults.map(t => [t.trip_id, t])).values());
        const totalTripFee = state.fee_rates ? uniqueFilteredTrips.reduce((sum, t) => sum + (tripTotalFeeAmount(t, state.fee_rates) || 0), 0) : null;
        const totalDriverPay = state.fee_rates ? uniqueFilteredTrips.reduce((sum, t) => sum + (tripDriverPayment(t, state.fee_rates)?.total || 0), 0) : null;
        return (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 10, color: COLORS.ghost, flex: 1 }}>
              {filteredResults.length} trip{filteredResults.length !== 1 ? "s" : ""} found
              {filteredResults.length !== results.length ? ` (${results.length} total before filter)` : ""}
              {results.length === 500 ? " (capped at 500 — narrow the date range for a complete list)" : ""}
            </div>
            {hasAdminPermission(user, "viewTripFees") && totalTripFee != null && (
              <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>TOTAL TRIP COST: </span><span style={{ fontWeight: 700, color: COLORS.amber }}>R{totalTripFee.toFixed(2)}</span></span>
            )}
            {hasAdminPermission(user, "viewTripFees") && totalDriverPay != null && (
              <span style={{ fontSize: 10 }}><span style={{ color: COLORS.ghost }}>DRIVER PAY TOTAL: </span><span style={{ fontWeight: 700, color: COLORS.teal }}>R{totalDriverPay.toFixed(2)}</span></span>
            )}
            {filteredResults.length > 0 && hasAdminPermission(user, "viewTripFees") && (
              <Button size="sm" variant="amber" title={exporting ? "SAVING…" : "💾 SAVE TRIP SHEET (CSV)"} disabled={exporting} onClick={async () => {
                setExporting(true);
                try {
                  const tripIds = filteredResults.map(t => t.trip_id);
                  const [delaysByTrip, auditByTrip] = await Promise.all([
                    fetchDelaysForTrips(tripIds),
                    fetchAuditLogsForTrips(tripIds),
                  ]);
                  const companyLabel = companyFilter.length
                    ? `_${companyFilter.map(id => (state.companies || []).find(c => String(c.id) === String(id))?.name.replace(/\s+/g, "_")).filter(Boolean).join("-") || "company"}`
                    : "";
                  exportTripsToCsv(filteredResults, state.users, state.driver_status, `trip_history_${fromDate}_to_${toDate}${companyLabel}`, delaysByTrip, auditByTrip, state.fee_rates);
                } catch (e) {
                  // Surfaced in the tab's existing error banner instead of
                  // escaping the onClick as an unhandled rejection.
                  setErr(e.message || "Couldn't build the trip sheet CSV.");
                } finally {
                  setExporting(false);
                }
              }} />
            )}
          </div>
          <Card body={false}>
            {filteredResults.length === 0
              ? <Empty icon="⊟" text={results.length === 0 ? "No completed trips in this range" : "No trips match the current Normal/Exception filter"} />
              : filteredResults.map(t => <TripDetailRow key={t.trip_id} trip={t} state={state} dispatch={null} user={user} />)}
          </Card>
        </>
        );
      })()}
    </div>
  );
}

function fleetUtilizationToCsv(rows) {
  const headers = ["Driver", "Trips", "Driving (hrs)", "Loading/Dispatch Lag (hrs)", "Gap Between Trips (hrs)"];
  const toHrs = (ms) => (ms / (1000 * 60 * 60)).toFixed(2);
  const dataRows = rows.map(r => [r.driver_name, r.trips, toHrs(r.driving_ms), toHrs(r.loading_ms), toHrs(r.gap_ms)]);
  const csv = [headers, ...dataRows].map(r => r.map(csvEscapeCell).join(",")).join("\r\n");
  return "﻿" + csv;
}

function AdminFleetUtilization({ state, user, dispatch }) {
  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [fromDate, setFromDate] = useState(thirtyDaysAgo.toISOString().slice(0, 10));
  const [toDate, setToDate] = useState(today.toISOString().slice(0, 10));
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const runSearch = async () => {
    setLoading(true);
    setErr(null);
    try {
      const fromMs = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : undefined;
      const toMs = toDate ? new Date(`${toDate}T23:59:59`).getTime() : undefined;
      const hits = await fetchTripHistory({ fromMs, toMs });
      setResults(computeFleetUtilization(hits, state.users));
    } catch (e) {
      setErr(e.message || "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = () => {
    if (!results || results.length === 0) return;
    downloadCsv(fleetUtilizationToCsv(results), `fleet_utilization_${fromDate}_to_${toDate}.csv`);
  };

  return (
    <div className="pad">
      <SectionHeader label="Fleet Utilization" />
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        Per-trip timestamp breakdown (driving / loading / gap between trips) for completed trips in the selected
        range. "Gap" only counts time between two trips on the SAME day — it's the closest available proxy for idle
        time today, not a true online/away log, so it can't distinguish genuine idle from off-duty.
      </div>
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>FROM</span>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "7px 10px", fontSize: 12 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>TO</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "7px 10px", fontSize: 12 }} />
          </div>
          <Button title={loading ? "SEARCHING…" : "RUN SEARCH"} variant="amber" size="sm" onClick={runSearch} disabled={loading} />
          {results && results.length > 0 && <Button title="⬇ EXPORT CSV" variant="ghost" size="sm" onClick={exportCsv} />}
        </div>
        {err && <span style={{ fontSize: 10, color: COLORS.red }}>{err}</span>}
      </Card>

      {results && (
        results.length === 0 ? (
          <Empty icon="📊" text="No completed trips in this range" />
        ) : results.map(r => {
          const totalMs = r.driving_ms + r.loading_ms + r.gap_ms;
          const pct = (ms) => totalMs > 0 ? (ms / totalMs) * 100 : 0;
          const toHrs = (ms) => (ms / (1000 * 60 * 60)).toFixed(1);
          return (
            <Card key={r.driver_id}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 800 }}>{r.driver_name}</span>
                <span style={{ fontSize: 10, color: COLORS.ghost }}>{r.trips} trip{r.trips !== 1 ? "s" : ""}</span>
              </div>
              <div className="cap-wrap" style={{ marginTop: 8 }}>
                <div className="cap-track" style={{ display: "flex", overflow: "hidden" }}>
                  <div style={{ width: `${pct(r.driving_ms)}%`, background: COLORS.green }} />
                  <div style={{ width: `${pct(r.loading_ms)}%`, background: COLORS.amber }} />
                  <div style={{ width: `${pct(r.gap_ms)}%`, background: COLORS.wire }} />
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {[
                  ["DRIVING", `${toHrs(r.driving_ms)}h`, COLORS.green],
                  ["LOADING/LAG", `${toHrs(r.loading_ms)}h`, COLORS.amber],
                  ["GAP", `${toHrs(r.gap_ms)}h`, COLORS.ghost],
                ].map(([label, val, color]) => (
                  <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 3, padding: "4px 10px", minWidth: 80 }}>
                    <div style={{ fontSize: 8, color: COLORS.ghost, letterSpacing: 0.8 }}>{label}</div>
                    <div style={{ fontSize: 14, fontWeight: 800, color, fontFamily: FONTS.head }}>{val}</div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}

// Surfaces the admin activity log (audit_logs table) with real daily/
// weekly/monthly grouping — closes a real gap: logAuditAction already
// records EVERY admin action (trip changes, user CRUD, company/fee-rate
// edits, DMs, announcements, driver docs/shifts, etc.) but the only other
// UI surface that ever reads audit_logs (AuditExportPanel, in Search
// Profiles) only ever fetches entries linked to a trip, so every non-trip
// action type — "everything from deleted users to adding drivers and
// everything in between," per the explicit request this was built for —
// was logged but permanently unreachable in the app. Only reachable from
// AdminApp (FLEET_OPS/STANDARD — see the viewAuditLog permission gate at
// its call site), which are both fleet-wide unrestricted tiers
// (getAdminCompanyIds returns [] for both), so this deliberately has no
// company-scoping logic — VIEWER/FINANCIAL never reach this tab at all.
function AdminActivityLog() {
  const [fromDate, setFromDate] = useState(() => shiftDateStr(sastTodayStr(), { days: -7 }));
  const [toDate, setToDate] = useState(sastTodayStr);
  const [granularity, setGranularity] = useState("day"); // "day" | "week" | "month" | "raw"
  const [categoryFilter, setCategoryFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");
  const [logs, setLogs] = useState(null);
  // The range actually behind `logs` — CSV filename uses this, not the
  // live fromDate/toDate inputs, which can be edited after a search
  // without re-running it (the inputs would otherwise mislabel an export
  // with a range it doesn't actually contain).
  const [searchedRange, setSearchedRange] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  // Guards against RUN SEARCH and a quick-range button (or two quick-range
  // clicks) firing overlapping requests — without this, a slow first
  // request resolving AFTER a faster second one would silently overwrite
  // logs/searchedRange with stale data and no indication anything raced.
  const searchSeqRef = React.useRef(0);

  const runSearch = async (fromStr = fromDate, toStr = toDate) => {
    const seq = ++searchSeqRef.current;
    setLoading(true); setErr(null);
    // A category picked for the previous result set can silently zero
    // out an unrelated new one (it's no longer in the new category list
    // but the <select> still shows it selected) — clear it on every new
    // search rather than leave an invisible stale filter behind.
    setCategoryFilter("");
    try {
      // Pinned to SAST calendar-day boundaries (not the viewing device's
      // local time) — must agree with auditLogPeriodKey's own SAST
      // bucketing below, or a "TODAY" search from outside SAST would
      // fetch the wrong 24h window and disagree with the day/week/month
      // buckets it's then grouped into.
      const fromMs = fromStr ? sastMidnightMs(fromStr) : undefined;
      const toMs = toStr ? sastMidnightMs(toStr) + 24 * 3600000 - 1 : undefined;
      const result = await fetchAuditLogsRange({ fromMs, toMs });
      if (seq !== searchSeqRef.current) return; // superseded by a newer search
      setLogs(result);
      setSearchedRange({ from: fromStr, to: toStr });
    } catch (e) {
      if (seq !== searchSeqRef.current) return;
      setErr(e.message || "Search failed");
      setLogs(null);
    } finally {
      if (seq === searchSeqRef.current) setLoading(false);
    }
  };

  // Same quick-range convenience as AdminProfileSearch/AdminFleetUtilization,
  // SAST-pinned like runSearch above (not UTC via toISOString()).
  const applyQuickRange = (unit) => {
    const endStr = sastTodayStr();
    const startStr = unit === "day" ? shiftDateStr(endStr, { days: -1 })
      : unit === "week" ? shiftDateStr(endStr, { days: -7 })
      : shiftDateStr(endStr, { months: -1 });
    setFromDate(startStr); setToDate(endStr);
    runSearch(startStr, endStr);
  };

  const categories = React.useMemo(() => {
    const set = new Set((logs || []).map(l => auditLogCategory(l.actionType)));
    return [...set].sort();
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    if (!logs) return [];
    const needle = textFilter.trim().toLowerCase();
    return logs.filter(l => {
      if (categoryFilter && auditLogCategory(l.actionType) !== categoryFilter) return false;
      if (!needle) return true;
      return [l.actionType, l.username, l.details].some(v => (v || "").toLowerCase().includes(needle));
    });
  }, [logs, categoryFilter, textFilter]);

  const grouped = React.useMemo(
    () => (granularity === "raw" ? [] : groupAuditLogsByPeriod(filteredLogs, granularity)),
    [filteredLogs, granularity]
  );

  const exportCsv = () => {
    if (!filteredLogs.length || !searchedRange) return;
    downloadCsv(auditLogsToCsv(filteredLogs), `activity_log_${searchedRange.from}_to_${searchedRange.to}.csv`);
  };

  const periodLabel = (key) => {
    if (granularity === "month") {
      const [y, m] = key.split("-");
      return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-ZA", { month: "long", year: "numeric" });
    }
    if (granularity === "week") return `Week of ${key}`;
    return key;
  };

  return (
    <div className="pad">
      <SectionHeader label="Admin Activity Log" />
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        Every admin/agent-triggered action recorded by the app — trip changes, user and company management, fee
        rate edits, dispatch, messages, announcements, driver document/shift updates, and more. Capped at the most
        recent 1000 entries in the selected range — narrow the date range if you hit that cap.
      </div>
      <Card>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>FROM</span>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "7px 10px", fontSize: 12 }} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>TO</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "7px 10px", fontSize: 12 }} />
          </div>
          <Button title={loading ? "SEARCHING…" : "RUN SEARCH"} variant="amber" size="sm" onClick={() => runSearch()} disabled={loading} />
          {filteredLogs.length > 0 && <Button title="⬇ EXPORT CSV" variant="ghost" size="sm" onClick={exportCsv} />}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <Button title="TODAY" size="sm" variant="ghost" onClick={() => applyQuickRange("day")} disabled={loading} style={{ flex: 1 }} />
          <Button title="WEEK" size="sm" variant="ghost" onClick={() => applyQuickRange("week")} disabled={loading} style={{ flex: 1 }} />
          <Button title="MONTH" size="sm" variant="ghost" onClick={() => applyQuickRange("month")} disabled={loading} style={{ flex: 1 }} />
        </div>
        {err && <span style={{ fontSize: 10, color: COLORS.red }}>{err}</span>}
      </Card>

      {logs && (
        <Card>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>GROUP BY</span>
            {[["day", "DAILY"], ["week", "WEEKLY"], ["month", "MONTHLY"], ["raw", "RAW LIST"]].map(([g, label]) => (
              <Button key={g} title={label} size="sm" variant={granularity === g ? "amber" : "ghost"} onClick={() => setGranularity(g)} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}
              style={{ background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "6px 8px", fontSize: 11 }}>
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input value={textFilter} onChange={e => setTextFilter(e.target.value)} placeholder="Search actor / action / details…"
              style={{ flex: 1, minWidth: 180, background: COLORS.card, border: `1px solid ${COLORS.wire}`, color: COLORS.chalk, borderRadius: 4, padding: "6px 8px", fontSize: 11 }} />
          </div>
          <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 6 }}>
            {filteredLogs.length} of {logs.length} entries
            {logs.length === 1000 ? " (capped at 1000 — narrow the date range for a complete list)" : ""}
          </div>
        </Card>
      )}

      {logs && filteredLogs.length === 0 && <Empty icon="📜" text="No activity matches this range/filter" />}

      {granularity === "raw" ? (
        filteredLogs.map(l => <AuditLogEntryRow key={l.id} log={l} />)
      ) : (
        grouped.map(bucket => (
          <Card key={bucket.key}>
            <details className="no-marker">
              <summary style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 800 }}>{periodLabel(bucket.key)}</span>
                <span style={{ fontSize: 10, color: COLORS.ghost }}>{bucket.count} action{bucket.count !== 1 ? "s" : ""}</span>
              </summary>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {Object.entries(bucket.byCategory).sort((a, b) => b[1] - a[1]).map(([cat, count]) => (
                  <div key={cat} style={{ background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 3, padding: "3px 8px", fontSize: 9, color: COLORS.ghost }}>
                    {cat} · {count}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {bucket.entries.map(l => <AuditLogEntryRow key={l.id} log={l} compact />)}
              </div>
            </details>
          </Card>
        ))
      )}
    </div>
  );
}

function AuditLogEntryRow({ log, compact }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8,
      padding: compact ? "4px 0" : "8px 0", borderBottom: `1px solid ${COLORS.wire}`,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: compact ? 10 : 11, fontWeight: 700 }}>
          {log.actionType}{log.tripId != null && <span style={{ color: COLORS.ghost, fontWeight: 400 }}> · trip {log.tripId}</span>}
        </div>
        <div style={{ fontSize: 9, color: COLORS.ghost }}>{log.username || "System"}{log.details ? ` — ${log.details}` : ""}</div>
      </div>
      <span style={{ fontSize: 9, color: COLORS.ghost, whiteSpace: "nowrap" }}>{fmtSastDateTime(log.timestamp)}</span>
    </div>
  );
}

function AdminDispatch({ state, dispatch }) {
  // Multiple unassigned trips can be selected together — for when several
  // agents happen to be going the same way and one driver should pick up
  // all of them in a single run instead of separate dispatches. A Set
  // (not an array) so toggling a trip in/out on tap is a simple
  // add/delete rather than an indexOf/splice dance.
  const [selectedTripIds, setSelectedTripIds] = useState(new Set());
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  // Search on the driver list — per the scan finding. Existing filters
  // (day/direction/area) already shorten the unassigned-bookings list,
  // but the driver list itself has no filtering at all, which matters
  // on a fleet with many drivers.
  const [driverSearch, setDriverSearch] = useState("");
  const [msg, setMsg] = useState(null);
  const [dispatching, setDispatching] = useState(false);
  // Which driver a dispatch was actually started for — FOUND VIA
  // /code-review (10th pass): the loading spinner/disabled button was
  // rendered purely off `sel` (the CURRENTLY selected driver's card), so
  // if the admin changed selection while a dispatch was still in flight
  // (a different trip checkbox, a different driver card, any of the
  // day/direction/area filters — all of which reset selectedDriverId),
  // the spinner silently vanished from the driver actually being
  // dispatched and could misleadingly appear on an uninvolved,
  // newly-selected driver instead. This tracks the real target
  // independent of whatever is currently selected.
  const [dispatchingDriverId, setDispatchingDriverId] = useState(null);
  // FOUND VIA /code-review (4th pass): `dispatching` state alone can't
  // stop a rapid double-click — both click-handler invocations read the
  // same pre-update `dispatching === false` from this render's closure
  // before React commits the first setDispatching(true), so both pass
  // the `if (dispatching) return` guard. A ref is mutated synchronously
  // (no render/commit needed), so the second invocation sees it flip
  // immediately, closing the gap the state-only guard's own comment
  // already flagged as open.
  const dispatchingRef = useRef(false);
  // The driver-scoring memo below computes each driver's live-position
  // "freshness" (30s cutoff) — see useTicker's own header comment for why
  // memoizing that check needs this. 10s keeps the staleness verdict from
  // drifting more than ~10s stale, without reintroducing a full recompute
  // on every render.
  const nowTick = useTicker(10000);
  // Filters the unassigned bookings list down to one calendar date — with
  // several agents each booking a week (or more), the unassigned list can
  // easily reach 20-30+ cards all mixed together with no way to tell
  // which day is which at a glance. Defaults to "" (show every date);
  // populated from whatever dates actually exist in the CURRENT
  // unassigned list, not a fixed calendar picker, so the dropdown never
  // offers a date with nothing to show.
  const [dayFilter, setDayFilter] = useState("");
  // Filters the unassigned bookings list to one DIRECTION (INBOUND or
  // OUTBOUND) — when several agents each make a return booking, their
  // morning (INBOUND) and evening (OUTBOUND) legs should be dispatched
  // as SEPARATE groups, not mixed together: 3 agents' inbound legs
  // combine into one trip, their outbound legs combine into a different
  // one, grouped by direction regardless of each agent's exact time.
  const [directionFilter, setDirectionFilter] = useState("");
  // Filters INBOUND unassigned bookings by the agent's HOME AREA (e.g.
  // Mitchells Plain, Bellville) — only meaningful for INBOUND (that's
  // the direction where the agent is being picked up FROM home), so
  // this only applies/shows once directionFilter === "INBOUND". A
  // booking's "area" is every one of its agents' home areas (normally
  // just one agent pre-dispatch, but checked as a set so an edge-case
  // multi-agent unassigned booking still matches correctly if ANY of
  // its agents live in the selected area).
  const [areaFilter, setAreaFilter] = useState("");
  // FOUND VIA /code-review (resource-usage audit): this whole filter/
  // selection derivation chain (through availableDriversRaw) used to run
  // as plain consts on EVERY render — this is the busiest, most-clicked
  // admin screen in the app, and it re-rendered (and redid all of this)
  // on every realtime state update anywhere in the app, not just ones
  // relevant to dispatch. Memoized as one block since every step here
  // feeds the next; MIN_FULL_PCT stays outside since it's a plain
  // constant, not a derivation.
  const MIN_FULL_PCT = 0.75;
  const {
    unassignedAllDates, availableDates, unassignedByDay, availableDirections, unassignedByDirection,
    tripHomeAreas, availableAreas, unassigned, selectedTrips, primaryTrip, seatsByDate,
    isMultiDaySelection, totalSeats, overCapacity, underCapacityWarning, availableDriversRaw,
  } = React.useMemo(() => {
    const unassignedAllDates = state.trips.filter(t => t.state === TRIP_STATE.UNASSIGNED_BOOKING);
    const availableDates = [...new Set(unassignedAllDates.map(t => t.scheduled_date))].sort();
    const unassignedByDay = dayFilter ? unassignedAllDates.filter(t => t.scheduled_date === dayFilter) : unassignedAllDates;
    const availableDirections = [...new Set(unassignedByDay.map(t => t.direction).filter(Boolean))].sort();
    const unassignedByDirection = directionFilter ? unassignedByDay.filter(t => t.direction === directionFilter) : unassignedByDay;
    const tripHomeAreas = (t) => (t.agent_ids || [])
      .map(id => state.users.find(u => String(u.id) === String(id))?.home_address?.area)
      .filter(Boolean);
    const availableAreas = directionFilter === "INBOUND"
      ? [...new Set(unassignedByDirection.flatMap(tripHomeAreas))].sort()
      : [];
    const unassigned = (directionFilter === "INBOUND" && areaFilter)
      ? unassignedByDirection.filter(t => tripHomeAreas(t).includes(areaFilter))
      : unassignedByDirection;
    const selectedTrips = unassigned.filter(t => selectedTripIds.has(t.trip_id));
    // The first-selected trip is the "primary" — whichever one absorbs the
    // others when merged (see TRIP/DISPATCH_MULTI). Order matters for the
    // audit trail and for which agent's name the merge notification uses,
    // so this is insertion order, not sorted order.
    const primaryTrip = selectedTrips[0] || null;
    // A selection spanning more than one calendar date needs capacity
    // checked PER DAY, not summed across the whole selection — day 1's
    // passengers and day 3's passengers never share a vehicle at the same
    // time, so summing them is meaningless. The whole selection routes to
    // TRIP/BULK_ASSIGN_DRIVER (each trip assigned independently — its
    // handler auto-merges same-day trips server-side) rather than the
    // merge-into-one-trip path DISPATCH_MULTI uses for a single day.
    //
    // FOUND VIA DIRECT USER REPORT (3 agents each with their own separate
    // week-long return-trip series, assigned to one driver together, got
    // "13/4 seats — exceeds vehicle capacity"): this used to require every
    // selected trip to share ONE week_group_id, which only ever holds for
    // a SINGLE agent's own recurring series. The moment several different
    // agents' week series are selected together — a totally normal
    // "these 3 people ride together every day" case — each agent has their
    // own week_group_id, the check failed, and totalSeats fell through to
    // the flat sum-everything branch: 3 agents × 6 days summed as if all
    // 18 bookings needed one vehicle simultaneously. The real constraint is
    // just "how many agents does this driver carry on this vehicle's
    // busiest single day" — computed below per calendar date, regardless
    // of whether one agent or several own the trips on that date.
    const seatsByDate = new Map();
    for (const t of selectedTrips) seatsByDate.set(t.scheduled_date, (seatsByDate.get(t.scheduled_date) || 0) + t.agent_ids.length);
    const isMultiDaySelection = seatsByDate.size > 1;
    const totalSeats = isMultiDaySelection ? Math.max(...seatsByDate.values(), 0) : selectedTrips.reduce((n, t) => n + t.agent_ids.length, 0);
    const overCapacity = totalSeats > DRIVER_CAPACITY;
    // A vehicle trip should combine enough agent bookings to fill it at
    // least 75% (3 of 4 seats) before dispatching a driver — a single
    // booking (or two) is under that target. Per explicit decision this is
    // a WARNING, not a hard block: an admin can still dispatch below 75%
    // when there's genuinely no one else to combine with, they just see
    // it flagged rather than the app silently allowing it as if it were
    // fully optimal. Week bookings are exempt — one agent's own schedule
    // repeated across several days is not "several agents sharing a ride"
    // and was never the kind of under-filled trip this rule targets.
    const underCapacityWarning = !isMultiDaySelection && totalSeats > 0 && !overCapacity && (totalSeats / DRIVER_CAPACITY) < MIN_FULL_PCT;
    const availableDriversRaw = state.driver_status.filter(ds => {
      // Feature 7: shift filtering — exclude drivers not rostered for this time slot.
      // isDriverOnShift returns true when no schedule is set (backward compat).
      const tripTimeStr = primaryTrip?.scheduled_time || null;
      const tripDateStr = primaryTrip?.scheduled_date || null;
      if (!isDriverOnShift(ds, tripDateStr, tripTimeStr)) return false;
      // Real per-vehicle capacity, not the bare DRIVER_CAPACITY default —
      // matches the pattern every other capacity check in this file already
      // uses. Without this, a driver with a bigger vehicle got wrongly
      // EXCLUDED from the available list once loaded past the default of 4
      // (even with real room left), and a driver with a smaller vehicle
      // (e.g. a 2-seat sedan) showed as available for a booking their real
      // car can't fit.
      const driverCapacity = ds.capacity || DRIVER_CAPACITY;
      if (isMultiDaySelection) {
        // Check each distinct date against its FULL batch total (every
        // selected trip's agents landing on that date, from seatsByDate
        // above) — not just one trip's own agent count. A driver who
        // already has room for agent A alone on day 1 isn't necessarily
        // able to also take agent B's day-1 booking from this same batch.
        return [...seatsByDate.entries()].every(([date, seats]) => {
          if (!isDriverOnShift(ds, date, tripTimeStr)) return false;
          return getDriverLoad(state, ds.driver_id, date) + Math.max(1, seats) <= driverCapacity;
        });
      }
      const checkDate = primaryTrip?.scheduled_date;
      return getDriverLoad(state, ds.driver_id, checkDate) + Math.max(1, totalSeats) <= driverCapacity;
    });
    return {
      unassignedAllDates, availableDates, unassignedByDay, availableDirections, unassignedByDirection,
      tripHomeAreas, availableAreas, unassigned, selectedTrips, primaryTrip, seatsByDate,
      isMultiDaySelection, totalSeats, overCapacity, underCapacityWarning, availableDriversRaw,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.trips, state.users, state.driver_status, dayFilter, directionFilter, areaFilter, selectedTripIds]);

  const toggleTrip = (tripId) => {
    setSelectedTripIds(prev => {
      const next = new Set(prev);
      if (next.has(tripId)) { next.delete(tripId); return next; }
      // Block adding a trip whose agent already appears on another
      // SELECTED TRIP FOR THE SAME DATE — that's a genuine duplicate (the
      // same person can't ride on two bookings being combined for one
      // day). The same agent appearing on a DIFFERENT date is expected
      // and fine (a week series), since different dates never merge into
      // one trip record anyway (see isMultiDaySelection/
      // TRIP/BULK_ASSIGN_DRIVER, which assigns each date independently).
      //
      // FOUND VIA DIRECT USER REPORT ("it doesn't allow me to select all
      // the outbound to one driver" — 3 agents, each with their own
      // 6-day week series): the old check required EVERY currently-
      // selected trip to share ONE week_group_id before allowing a
      // repeat agent through at all. The moment a second agent's booking
      // was also selected (a totally normal "these people ride
      // together" case), that global check failed, and adding the FIRST
      // agent's next day got wrongly flagged as a duplicate — the same
      // root cause as the capacity bug just fixed, just in the
      // selection guard instead of the seat math.
      const tripBeingAdded = unassigned.find(t => String(t.trip_id) === String(tripId));
      if (tripBeingAdded) {
        const currentlySelected = unassigned.filter(t => next.has(t.trip_id));
        const sameDateSelected = currentlySelected.filter(t => t.scheduled_date === tripBeingAdded.scheduled_date);
        const incomingAgentIds = new Set((tripBeingAdded.agent_ids || []).map(String));
        const alreadySelectedAgentIdsSameDate = new Set(sameDateSelected.flatMap(t => (t.agent_ids || []).map(String)));
        const overlap = [...incomingAgentIds].find(id => alreadySelectedAgentIdsSameDate.has(id));
        if (overlap) {
          const overlapName = state.users.find(u => String(u.id) === String(overlap))?.name || "This agent";
          setMsg(`✗ ${overlapName} is already on another selected booking for this date — combining two of the same agent's bookings on the same day isn't a valid merge.`);
          setTimeout(() => setMsg(null), 4000);
          return next; // unchanged — the tap is rejected
        }
      }
      next.add(tripId);
      return next;
    });
    setSelectedDriverId(null);
  };

  // Sort by proximity to the PRIMARY trip's pickup point (the anchor of
  // the run) — per explicit decision, prefers the driver's LIVE current
  // GPS position (same 30s staleness threshold Live Map already uses —
  // a driver who hasn't reported in 30s+ isn't meaningfully "live"
  // anymore) and falls back to their home address when no fresh live
  // position exists (offline, never logged in today, or genuinely
  // stale). Drivers with neither sort to the bottom, deprioritized not
  // excluded — no data doesn't mean unavailable.
  // Same memoization reasoning as the block above — depends on that
  // block's own outputs (primaryTrip, availableDriversRaw, selectedTrips)
  // plus driverSearch/state.driver_positions, so it still only recomputes
  // when something it actually reads has changed.
  const { pickupCoord, availableDrivers, nearestDriverId, topScoredDriverId, displayedDrivers } = React.useMemo(() => {
    const pickupCoord = primaryTrip?.pickup_sequence_coords?.[0];
    const availableDrivers = [...availableDriversRaw]
      .map(ds => {
        const u = state.users.find(x => String(x.id) === String(ds.driver_id));
        const livePos = state.driver_positions?.[ds.driver_id];
        const liveIsFresh = livePos && (nowTick - new Date(livePos.updated_at).getTime()) <= 30000;
        const originCoord = liveIsFresh ? { lat: livePos.lat, lng: livePos.lng } : (u?.home_address || null);
        const distKm = (pickupCoord && originCoord)
          ? haversineKm(pickupCoord.lat, pickupCoord.lng, originCoord.lat, originCoord.lng) * ROAD_FACTOR
          : null;
        // Feature 4: smart score — combines proximity, load, acceptance rate, and
        // whether this driver has previously declined any of this trip's agents.
        const tripAgentIds = selectedTrips.flatMap(t => t.agent_ids || []);
        const { score, acceptRate, prevDeclinedThisAgent } = scoreDriverForTrip(ds, u, distKm, tripAgentIds, state.trips);
        return { ds, u, distKm, usedLivePosition: liveIsFresh && distKm != null, score, acceptRate, prevDeclinedThisAgent };
      })
      .sort((a, b) => b.score - a.score); // highest score first
    const nearestDriverId = availableDrivers[0]?.distKm != null ? availableDrivers[0].ds.driver_id : null;
    const topScoredDriverId = availableDrivers[0]?.ds.driver_id || null;
    // Search-filtered list for DISPLAY only — per the scan finding, a
    // fleet with many drivers had no way to narrow this list at all.
    // Deliberately a SEPARATE list from availableDrivers itself, so
    // nearestDriverId above still reflects the true nearest driver across
    // the whole fleet, not just whoever currently matches a search.
    // Matches on name OR vehicle description (searching "hiace" finds
    // every driver with a Toyota Hiace, a genuinely useful thing to
    // filter by when picking a vehicle for a larger group).
    const displayedDrivers = driverSearch.trim().length >= 1
      ? availableDrivers.filter(({ u, ds }) => {
          const q = driverSearch.trim().toLowerCase();
          return (u?.name || "").toLowerCase().includes(q) ||
            (ds.vehicle || "").toLowerCase().includes(q) ||
            (u?.home_address?.area || "").toLowerCase().includes(q) ||
            (u?.home_address?.label || "").toLowerCase().includes(q);
        })
      : availableDrivers;
    return { pickupCoord, availableDrivers, nearestDriverId, topScoredDriverId, displayedDrivers };
  }, [primaryTrip, availableDriversRaw, selectedTrips, state.users, state.driver_positions, state.trips, driverSearch, nowTick]);

  const handleDispatch = async () => {
    // FOUND VIA AUDIT (2026-08-09): was `|| overCapacity` — overCapacity
    // is totalSeats > the bare DRIVER_CAPACITY default (4), unrelated to
    // which driver is actually selected. availableDriversRaw (above) has
    // already filtered the whole picker down to drivers whose OWN real
    // capacity fits totalSeats, so any selectedDriverId reaching this
    // point is by construction already capacity-valid — gating on the
    // generic constant here just wrongly blocked dispatch to a real,
    // available bigger vehicle (e.g. capacity 6) whenever totalSeats > 4.
    if (!primaryTrip || !selectedDriverId) return;
    // FOUND VIA /code-review (productivity audit): the dispatch button had
    // no loading/disabled state at all — at high-volume overnight dispatch,
    // an admin unsure whether a click registered could double-tap (or tap
    // a different driver's button while the first request is still in
    // flight), assigning the same booking twice. dispatchingRef is the
    // real guard (mutated synchronously, so a rapid double-click's second
    // invocation sees it immediately — see its own declaration comment);
    // `dispatching` state stays purely for the button's disabled/spinner
    // rendering, which doesn't need to be synchronous.
    if (dispatchingRef.current) return;
    dispatchingRef.current = true;
    setDispatching(true);
    setDispatchingDriverId(selectedDriverId);
    const driverName = state.users.find(u => String(u.id) === String(selectedDriverId))?.name;
    // Which trip ids to drop from the selection once this resolves — the
    // DISPATCH_MULTI / single-trip branches throw on any failure so they
    // only ever reach the prune below on full success (all of them). The
    // multi-day branch narrows this to just the legs that actually
    // succeeded, so a partial failure leaves the failed days still
    // checked and immediately retryable (FOUND VIA /code-review).
    let dispatchedIds = selectedTrips.map(t => t.trip_id);
    try {
      if (isMultiDaySelection) {
        const results = await dispatch({
          type: "TRIP/BULK_ASSIGN_DRIVER",
          trip_ids: selectedTrips.map(t => t.trip_id),
          driver_id: selectedDriverId,
        });
        // results is per-TRIP (one entry per outbound/return leg), but the
        // admin-facing message should report distinct DAYS — a week with
        // a return trip every day has 2 trip rows per date, so counting
        // results.length directly would double the real day count.
        const tripDateById = Object.fromEntries(selectedTrips.map(t => [t.trip_id, t.scheduled_date]));
        const okResults = (results || []).filter(r => r.ok);
        const failResults = (results || []).filter(r => !r.ok);
        const okDays = new Set(okResults.map(r => tripDateById[r.trip_id])).size;
        const failDays = new Set(failResults.map(r => tripDateById[r.trip_id])).size;
        dispatchedIds = okResults.map(r => r.trip_id);
        setMsg(failDays === 0
          ? `✓ All ${okDays} day${okDays !== 1 ? "s" : ""} assigned to ${driverName}`
          : `⚠ ${okDays} day${okDays !== 1 ? "s" : ""} assigned, ${failDays} failed — ${failResults.map(r => r.reason).join("; ")}`);
      } else if (selectedTrips.length > 1) {
        await dispatch({
          type: "TRIP/DISPATCH_MULTI",
          trip_ids: selectedTrips.map(t => t.trip_id),
          driver_id: selectedDriverId,
        });
        setMsg(`✓ ${selectedTrips.length} bookings combined into one trip and dispatched to ${driverName}`);
      } else {
        // Single-trip case stays on the plain action — same audit trail
        // and behavior as before this feature existed, no need to route
        // a 1-trip "merge" through the merge machinery.
        await dispatch({ type: "TRIP/ASSIGN_DRIVER", trip_id: primaryTrip.trip_id, driver_id: selectedDriverId });
        setMsg(`✓ Dispatched to ${driverName}`);
      }
      // Only the completed bookings' selection clears — the chosen
      // driver deliberately STAYS selected, per the scan finding.
      // Assigning several separate bookings to the same driver in a
      // row is a genuinely common workflow, and re-picking the same
      // driver from the list after every single assignment was a real,
      // repeated, unnecessary step.
      // FOUND VIA /code-review (3rd pass): used to reset selectedTripIds
      // to an empty Set outright — fine if nothing changed the selection
      // during the await, but the checkboxes stay interactive while
      // `dispatching` is true (only the DISPATCH button itself is
      // disabled), so an admin who deselected this batch and picked a
      // different one to queue up next had that unrelated new selection
      // silently wiped when this batch's dispatch resolved. Only remove
      // the ids that were ACTUALLY part of this dispatch (captured via
      // `selectedTrips`, closed over at click time) instead.
      const dispatchedIdSet = new Set(dispatchedIds);
      setSelectedTripIds(prev => new Set([...prev].filter(id => !dispatchedIdSet.has(id))));
    } catch (e) {
      setMsg(`✗ ${e.message || "Dispatch failed — please try again."}`);
    } finally {
      dispatchingRef.current = false;
      setDispatching(false);
      setDispatchingDriverId(null);
      setTimeout(() => setMsg(null), 4000);
    }
  };

  return (
    <div className="pad">
      {msg && (
        <div style={{ background: msg.startsWith("✗") ? "rgba(220,53,69,.1)" : "rgba(29,185,84,.1)", border: `1px solid ${msg.startsWith("✗") ? "rgba(220,53,69,.3)" : "rgba(29,185,84,.3)"}`, borderRadius: 4, padding: 12 }}>
          <span style={{ color: msg.startsWith("✗") ? COLORS.red : COLORS.green, fontWeight: 700, fontSize: 11 }}>{msg}</span>
        </div>
      )}
      {(() => {
        const suggestions = computeGroupSuggestions(unassignedAllDates.filter(t => !selectedTripIds.has(t.trip_id)), state.users, state.driver_status);
        if (!suggestions.length) return null;
        return (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: COLORS.green, letterSpacing: 1, marginBottom: 6 }}>💡 COMBINE SUGGESTED</div>
            {suggestions.map((sg, i) => {
              const companyLabel = companyById(state, sg.companyId)?.label || "Unknown company";
              const timeSpread = sg.earliestTime && sg.latestTime && sg.earliestTime !== sg.latestTime
                ? `${sg.earliestTime}–${sg.latestTime}` : (sg.earliestTime || "");
              return (
                <div key={i} style={{ background: "rgba(29,185,84,0.06)", border: "1px solid rgba(29,185,84,0.25)", borderRadius: 4, padding: "8px 10px", marginBottom: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: COLORS.green }}>{sg.trips.length} bookings · {sg.date} · {sg.direction} · {sg.totalPax} passengers</div>
                  <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>{companyLabel} · {sg.area}{timeSpread ? ` · ${timeSpread}` : ""}</div>
                  <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>{sg.trips.map(t => t.agent_name || t.trip_id).join(", ")}</div>
                  <Button title="SELECT ALL FOR COMBINING" variant="ghost" size="sm" style={{ marginTop: 6, borderColor: COLORS.green, color: COLORS.green }}
                    onClick={() => { setSelectedTripIds(new Set(sg.trips.map(t => t.trip_id))); setSelectedDriverId(null); }} />
                </div>
              );
            })}
          </div>
        );
      })()}
      <SectionHeader label={`Unassigned Bookings (${unassigned.length}${(dayFilter || directionFilter || areaFilter) ? ` of ${unassignedAllDates.length}` : ""})`} />
      {availableDates.length > 1 && (
        <div>
          <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>FILTER BY DAY</label>
          <select className="inp" value={dayFilter} onChange={e => { setDayFilter(e.target.value); setDirectionFilter(""); setSelectedTripIds(new Set()); setSelectedDriverId(null); }} style={{ width: "100%" }}>
            <option value="">All dates ({unassignedAllDates.length} bookings)</option>
            {availableDates.map(d => (
              <option key={d} value={d}>{d} ({unassignedAllDates.filter(t => t.scheduled_date === d).length} bookings)</option>
            ))}
          </select>
        </div>
      )}
      {availableDirections.length > 1 && (
        <div>
          <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>FILTER BY DIRECTION</label>
          <span style={{ display: "block", fontSize: 8, color: COLORS.ghost, marginTop: -2, marginBottom: 3 }}>
            Agents with a return booking have separate inbound and outbound legs — filter to one direction to dispatch it as its own trip.
          </span>
          <select className="inp" value={directionFilter} onChange={e => { setDirectionFilter(e.target.value); setAreaFilter(""); setSelectedTripIds(new Set()); setSelectedDriverId(null); }} style={{ width: "100%" }}>
            <option value="">Both directions ({unassignedByDay.length} bookings)</option>
            {availableDirections.map(d => (
              <option key={d} value={d}>{d} ({unassignedByDay.filter(t => t.direction === d).length} bookings)</option>
            ))}
          </select>
        </div>
      )}
      {directionFilter === "INBOUND" && availableAreas.length > 1 && (
        <div>
          <label style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, letterSpacing: 1 }}>FILTER BY AREA</label>
          <span style={{ display: "block", fontSize: 8, color: COLORS.ghost, marginTop: -2, marginBottom: 3 }}>
            Narrows inbound bookings to one home area — useful for grouping agents who live near each other onto the same driver.
          </span>
          <select className="inp" value={areaFilter} onChange={e => { setAreaFilter(e.target.value); setSelectedTripIds(new Set()); setSelectedDriverId(null); }} style={{ width: "100%" }}>
            <option value="">All areas ({unassignedByDirection.length} bookings)</option>
            {availableAreas.map(a => (
              <option key={a} value={a}>{a} ({unassignedByDirection.filter(t => tripHomeAreas(t).includes(a)).length} bookings)</option>
            ))}
          </select>
        </div>
      )}
      <span style={{ fontSize: 9, color: COLORS.ghost }}>Tap to select — pick multiple bookings to combine them into one trip.</span>
      {unassigned.length === 0 ? <Empty icon="⊕" text="No unassigned bookings" /> : unassigned.map(t => {
        const sel = selectedTripIds.has(t.trip_id);
        return (
          <div key={t.trip_id} onClick={() => toggleTrip(t.trip_id)}
            style={{ cursor: "pointer", background: COLORS.card, border: `1px solid ${sel ? COLORS.amber : COLORS.wire}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${sel ? COLORS.amber : COLORS.wire}`, background: sel ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{sel && "✓"}</span>
                <span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span>
              </div>
              <StateBadge state={t.state} />
            </div>
            <div style={{ fontSize: 11, fontWeight: 700 }}>{t.agent_ids.length} passenger{t.agent_ids.length !== 1 ? "s" : ""}</div>
            <div style={{ fontSize: 11 }}><span style={{ color: COLORS.green }}>◉ </span>{t.custom_pickup}</div>
            <div style={{ fontSize: 11 }}><span style={{ color: COLORS.red }}>◎ </span>{t.custom_dropoff}</div>
            <div style={{ display: "flex", gap: 10 }}>
              <span style={{ fontSize: 9, color: COLORS.ghost }}>📅 {t.scheduled_date}</span>
              <span style={{ fontSize: 9, color: COLORS.ghost }}>🕐 {t.scheduled_time}</span>
              <span style={{ fontSize: 9, color: COLORS.ghost }}>{t.trip_type}</span>
            </div>
            {(() => {
                const risk = tripNoShowRisk(t, state.trips);
                if (!risk) return null;
                const isHigh = risk === 'HIGH';
                return (
                  <span style={{ fontSize: 9, fontWeight: 700, color: isHigh ? COLORS.red : COLORS.amber,
                    border: `1px solid ${isHigh ? COLORS.red : COLORS.amber}`, padding: "2px 6px", borderRadius: 2, width: "fit-content" }}>
                    {isHigh ? "🚨 HIGH NO-SHOW RISK" : "⚠ ELEVATED NO-SHOW RISK"} — check history before dispatching
                  </span>
                );
              })()}
              {t.declinedBy?.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontSize: 9, color: COLORS.red, fontWeight: 700 }}>
                  ⚠ DRIVER REJECTION — declined by {t.declinedBy.length} driver{t.declinedBy.length !== 1 ? "s" : ""}
                </span>
                {t.rejection_reason && (
                  <span style={{ fontSize: 9, color: COLORS.red }}>
                    Reason: {t.rejection_reason}{t.rejection_note ? ` — "${t.rejection_note}"` : ""}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
      {selectedTrips.length > 0 && (
        <>
          <SectionHeader label="Select Driver" />
          <div style={{ background: overCapacity ? "rgba(220,53,69,.08)" : "rgba(245,166,35,.08)", borderRadius: 4, padding: 10, border: `1px solid ${overCapacity ? "rgba(220,53,69,.3)" : "rgba(245,166,35,.3)"}`, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 10, color: COLORS.mist }}>
              {selectedTrips.length === 1
                ? <>Assigning: <span style={{ color: COLORS.amber }}>{primaryTrip.trip_id}</span> — {primaryTrip.custom_pickup}</>
                : isMultiDaySelection
                ? <>Assigning <span style={{ color: COLORS.amber }}>{new Set(selectedTrips.flatMap(t => t.agent_ids || [])).size} agent{new Set(selectedTrips.flatMap(t => t.agent_ids || [])).size !== 1 ? "s" : ""}</span> to the same driver across <span style={{ color: COLORS.amber }}>{distinctWeekDays(selectedTrips)} days</span> ({[...new Set(selectedTrips.map(t => t.scheduled_date))].sort().join(", ")})</>
                : <>Combining <span style={{ color: COLORS.amber }}>{selectedTrips.length} bookings</span> ({selectedTrips.reduce((n, t) => n + (t.agent_ids?.length || 1), 0)} passengers total) onto {primaryTrip.trip_id}</>}
            </span>
            <span style={{ fontSize: 9, color: overCapacity ? COLORS.red : COLORS.ghost }}>
              {isMultiDaySelection
                ? `${totalSeats}/${DRIVER_CAPACITY} seats on the busiest day${overCapacity ? " — exceeds vehicle capacity" : ""}`
                : `${totalSeats}/${DRIVER_CAPACITY} seats${overCapacity ? " — exceeds vehicle capacity, remove a trip" : ""}`}
            </span>
            {underCapacityWarning && (
              <span style={{ fontSize: 9, color: COLORS.amber }}>
                ⚠ Under {Math.round(MIN_FULL_PCT * 100)}% target — a trip normally combines enough bookings to fill at least {Math.ceil(DRIVER_CAPACITY * MIN_FULL_PCT)} of {DRIVER_CAPACITY} seats. Consider combining with another booking before dispatching, if one's available.
              </span>
            )}
          </div>
          {availableDrivers.length > 1 && (
            <TextField label="Search drivers by name, vehicle, or area" value={driverSearch} onChange={e => setDriverSearch(e.target.value)} placeholder="e.g. Sipho, Hiace, or Milnerton" />
          )}
          {availableDrivers.length === 0 ? (
            <Empty icon="◉" text="No drivers available — all fully booked" />
          ) : displayedDrivers.length === 0 ? (
            <Empty icon="◉" text={`No drivers match "${driverSearch}"`} />
          ) : displayedDrivers.map(({ ds, u, distKm, usedLivePosition, score, acceptRate, prevDeclinedThisAgent }) => {
            const load = getDriverLoad(state, ds.driver_id, primaryTrip?.scheduled_date);
            const driverCapacityDispatch = ds.capacity || DRIVER_CAPACITY;
            // Workload warning: per explicit decision ("select it per
            // vehicle capacity"), the trip-count threshold SCALES WITH
            // this driver's own seat capacity rather than being one
            // fixed number for every driver — a 6-seat vehicle can
            // reasonably do more runs in a day than a 4-seat one before
            // it's worth flagging. Counts ALL of today's trips for this
            // driver, including completed ones (getDriverTripCountForDate,
            // not getDriverLoad — a driver who already finished several
            // runs today is exactly the case worth surfacing).
            const tripsToday = primaryTrip?.scheduled_date ? getDriverTripCountForDate(state, ds.driver_id, primaryTrip.scheduled_date) : 0;
            const heavyWorkloadWarning = tripsToday >= driverCapacityDispatch;
            const sel = selectedDriverId === ds.driver_id;
            const declined = selectedTrips.some(t => t.declinedBy?.includes(ds.driver_id));
            const isNearest = String(ds.driver_id) === String(nearestDriverId);
            const isUnavailable = !!ds.is_unavailable;
            return (
              // Same fix as handleDispatch above — every driver reaching
              // this .map() already passed availableDriversRaw's real
              // per-driver capacity check, so gating selectability on the
              // generic overCapacity (bare DRIVER_CAPACITY=4) here wrongly
              // greyed out an already-valid bigger vehicle.
              <div key={ds.driver_id} onClick={() => !declined && !isUnavailable && setSelectedDriverId(ds.driver_id)}
                style={{ cursor: (declined || isUnavailable) ? "not-allowed" : "pointer", opacity: (declined || isUnavailable) ? .35 : 1, background: sel ? COLORS.amber : COLORS.card, border: `1px solid ${sel ? COLORS.amber2 : isNearest ? COLORS.green : COLORS.wire}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: FONTS.head, color: sel ? COLORS.ink : COLORS.chalk }}>{u?.name}</span>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {isUnavailable && <span style={{ fontSize: 8, color: COLORS.red, fontWeight: 700, border: `1px solid ${COLORS.red}`, padding: "2px 5px", borderRadius: 2 }}>UNAVAILABLE</span>}
                    {(() => { const docs = ds.documents || {}; const expired = DOC_TYPES.filter(d => docExpiryStatus(docs[d.key]).status === "expired"); return expired.length > 0 ? <span style={{ fontSize: 8, color: COLORS.red, fontWeight: 700, border: `1px solid ${COLORS.red}`, padding: "2px 5px", borderRadius: 2 }}>EXPIRED DOCS</span> : null; })()}
                    {isNearest && !sel && !isUnavailable && <span style={{ fontSize: 8, color: COLORS.green, fontWeight: 700, border: `1px solid ${COLORS.green}`, padding: "2px 5px", borderRadius: 2 }}>NEAREST</span>}
                    {declined && <span style={{ fontSize: 8, color: COLORS.red, fontWeight: 700, border: `1px solid ${COLORS.red}`, padding: "2px 5px", borderRadius: 2 }}>DECLINED</span>}
                    {sel && <span style={{ color: COLORS.ink }}>✓</span>}
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 10, color: sel ? COLORS.ink : COLORS.ghost }}>{ds.vehicle}</span>
                  <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                    {String(ds.driver_id) === String(topScoredDriverId) && !sel && (
                      <span style={{ fontSize: 8, fontWeight: 700, color: COLORS.green, border: `1px solid ${COLORS.green}`, padding: "1px 4px", borderRadius: 2 }}>BEST MATCH</span>
                    )}
                    <span style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.ghost }}>Score: <span style={{ fontWeight: 700, color: sel ? COLORS.ink : (score >= 70 ? COLORS.green : score >= 40 ? COLORS.amber : COLORS.red) }}>{score}</span>/100</span>
                  </div>
                </div>
                {prevDeclinedThisAgent && !sel && (
                  <span style={{ fontSize: 9, color: COLORS.red }}>⚠ Previously declined a trip for this agent</span>
                )}
                {acceptRate < 0.7 && !sel && (
                  <span style={{ fontSize: 9, color: COLORS.amber }}>⚠ {Math.round(acceptRate * 100)}% acceptance rate</span>
                )}
                {(() => { const r = driverAvgRating(ds.driver_id, state.trips); return r ? (
                  <span style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.ghost }}>{"⭐".repeat(Math.round(r.avg))} {r.avg.toFixed(1)} avg rating</span>
                ) : null; })()}
                {distKm != null ? (
                  <span style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.teal }}>
                    {usedLivePosition ? "🛰 " : "🏠 "}
                    {usedLivePosition ? "current location" : (u?.home_address?.area || u?.home_address?.label)}
                    {` — ${distKm.toFixed(1)} km from pickup`}
                  </span>
                ) : u?.home_address && (
                  <span style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.teal }}>
                    🏠 {u.home_address.area || u.home_address.label}
                  </span>
                )}
                {heavyWorkloadWarning && (
                  <span style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.red, fontWeight: 700 }}>
                    ⚠ Already {tripsToday} trip{tripsToday !== 1 ? "s" : ""} today — at or over this driver's {driverCapacityDispatch}-seat capacity threshold.
                  </span>
                )}
                <CapacityBar load={load} capacity={driverCapacityDispatch} />
                {/* FOUND VIA /code-review (10th pass): used to render
                    purely off `sel`, so changing the selection while a
                    dispatch was still in flight (a different trip
                    checkbox, a different driver card, any of the day/
                    direction/area filters — all of which reset
                    selectedDriverId) made the spinner vanish from the
                    driver actually being dispatched, with no visible
                    confirmation it was still processing. Now also renders
                    on whichever card dispatchingDriverId actually points
                    at, independent of the current selection. */}
                {(sel || ds.driver_id === dispatchingDriverId) && (
                  <Button
                    // FOUND VIA /code-review (4th pass): Button swaps its
                    // whole label for a spinner whenever loading is true
                    // (see Button, TransitOS_web.jsx), so the "DISPATCHING…"
                    // branch here was computed every render but never
                    // actually shown — dropped as dead work.
                    title={isMultiDaySelection ? `⊕ ASSIGN DRIVER TO ${distinctWeekDays(selectedTrips)} DAYS` : selectedTrips.length > 1 ? `⊕ COMBINE & DISPATCH (${selectedTrips.length} BOOKINGS)` : "⊕ DISPATCH NOW"}
                    variant="amber" full disabled={dispatching} loading={ds.driver_id === dispatchingDriverId} onClick={(e) => { e.stopPropagation(); handleDispatch(); }}
                  />
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

const TILE_SIZE = 256;

function lonLatToWorldPixel(lon, lat, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI)) * scale;
  return { x, y };
}

function worldPixelToLonLat(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

function projectToSvg(lat, lng, width, height, viewport) {
  const centerPx = lonLatToWorldPixel(viewport.centerLng, viewport.centerLat, viewport.zoom);
  const pointPx = lonLatToWorldPixel(lng, lat, viewport.zoom);
  return { x: width / 2 + (pointPx.x - centerPx.x), y: height / 2 + (pointPx.y - centerPx.y) };
}

function unprojectFromSvg(screenX, screenY, width, height, viewport) {
  const centerPx = lonLatToWorldPixel(viewport.centerLng, viewport.centerLat, viewport.zoom);
  const worldX = centerPx.x + (screenX - width / 2);
  const worldY = centerPx.y + (screenY - height / 2);
  return worldPixelToLonLat(worldX, worldY, viewport.zoom);
}

function lonLatToTile(lon, lat, zoom) {
  const latRad = (lat * Math.PI) / 180;
  const n = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

function tileToLonLat(x, y, zoom) {
  const n = 2 ** zoom;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return { lon, lat: (latRad * 180) / Math.PI };
}

function tomtomTileUrl(x, y, zoom) {
  return `https://api.tomtom.com/map/1/tile/basic/main/${zoom}/${x}/${y}.png?key=${TOMTOM_API_KEY}&tileSize=256`;
}

let tomtomTileErrorLoggedOnce = { current: false };

const LiveMapTiles = React.memo(function LiveMapTiles({ width, height, viewport }) {
  // tileZoom picks which discrete tile IMAGE to fetch (tile servers only
  // have whole-number zoom levels) — but FOUND VIA DIRECT USER REPORT
  // ("trail alignment is out"): every tile's ON-SCREEN POSITION used to
  // ALSO be forced through this same rounded zoom (passing
  // `{...viewport, zoom: tileZoom}` into projectToSvg for each tile
  // corner), while everything else drawn on top of the map — driver
  // markers, the GPS trail's polyline — projects through the viewport's
  // REAL, continuous zoom instead. World-pixel scale is 2**zoom, so tiles
  // and overlay content were being computed in two DIFFERENT pixel
  // spaces sharing one <svg> — they only lined up by coincidence when
  // zoom happened to already be a whole number (e.g. right after "fit to
  // bounds"), and drifted further apart the more a wheel-zoom tick or
  // pinch pushed the real zoom away from its rounded value, worse the
  // farther a point sits from the viewport center. Real slippy maps
  // handle non-integer zoom by scaling each fetched tile image to its
  // TRUE position instead of snapping everything to the nearest whole
  // level — every coordinate below (including each tile's own corners)
  // now projects through the SAME real `viewport` used everywhere else,
  // so nothing drawn on this map can ever disagree with it again.
  const tileZoom = Math.round(viewport.zoom);
  if (!TOMTOM_API_KEY) {
    // No TomTom key — render OSM tiles as fallback using the same SVG approach
    const topLeftLonLat = unprojectFromSvg(0, 0, width, height, viewport);
    const bottomRightLonLat = unprojectFromSvg(width, height, width, height, viewport);
    const topLeft = lonLatToTile(topLeftLonLat.lon, topLeftLonLat.lat, tileZoom);
    const bottomRight = lonLatToTile(bottomRightLonLat.lon, bottomRightLonLat.lat, tileZoom);
    const osmTiles = [];
    for (let tx = topLeft.x - 1; tx <= bottomRight.x + 1; tx++) {
      for (let ty = topLeft.y - 1; ty <= bottomRight.y + 1; ty++) {
        const nw = tileToLonLat(tx, ty, tileZoom);
        const se = tileToLonLat(tx + 1, ty + 1, tileZoom);
        const p1 = projectToSvg(nw.lat, nw.lon, width, height, viewport);
        const p2 = projectToSvg(se.lat, se.lon, width, height, viewport);
        const sub = ["a","b","c"][((tx + ty) % 3 + 3) % 3]; // rotate OSM subdomains
        osmTiles.push(
          <image
            key={`osm-${tileZoom}-${tx}-${ty}`}
            href={`https://${sub}.tile.openstreetmap.org/${tileZoom}/${tx}/${ty}.png`}
            x={p1.x} y={p1.y}
            width={Math.max(1, p2.x - p1.x)}
            height={Math.max(1, p2.y - p1.y)}
            preserveAspectRatio="none"
            style={{ pointerEvents: "none" }}
            onError={e => { e.target.style.display = "none"; }}
          />
        );
      }
    }
    return <>{osmTiles}</>;
  }
  // Corners of the visible canvas, converted to lon/lat, then to which
  // tile range covers them — same idea as the old bounds-based version,
  // just driven by the current viewport's visible area instead of a
  // fixed Cape Town box.
  const topLeftLonLat = unprojectFromSvg(0, 0, width, height, viewport);
  const bottomRightLonLat = unprojectFromSvg(width, height, width, height, viewport);
  const topLeft = lonLatToTile(topLeftLonLat.lon, topLeftLonLat.lat, tileZoom);
  const bottomRight = lonLatToTile(bottomRightLonLat.lon, bottomRightLonLat.lat, tileZoom);
  const tiles = [];
  // +/-1 tile of padding so panning doesn't show a visible gap at the
  // edge for a frame while new tiles load in.
  for (let tx = topLeft.x - 1; tx <= bottomRight.x + 1; tx++) {
    for (let ty = topLeft.y - 1; ty <= bottomRight.y + 1; ty++) {
      const nw = tileToLonLat(tx, ty, tileZoom);
      const se = tileToLonLat(tx + 1, ty + 1, tileZoom);
      const p1 = projectToSvg(nw.lat, nw.lon, width, height, viewport);
      const p2 = projectToSvg(se.lat, se.lon, width, height, viewport);
      tiles.push(
        <image
          key={`${tileZoom}-${tx}-${ty}`}
          href={tomtomTileUrl(tx, ty, tileZoom)}
          x={p1.x} y={p1.y}
          width={Math.max(1, p2.x - p1.x)}
          height={Math.max(1, p2.y - p1.y)}
          preserveAspectRatio="none"
          style={{ pointerEvents: "none" }}
          onError={(e) => {
            e.target.style.display = "none";
            if (!tomtomTileErrorLoggedOnce.current) {
              tomtomTileErrorLoggedOnce.current = true;
              console.warn("[TomTom] Map tile failed — check API key and tile product authorization.");
            }
          }}
        />
      );
    }
  }
  // Render tiles as SVG <image> elements — coordinate space matches the
  // SVG viewBox exactly (0-700, 0-560), so tiles align with pins correctly
  // at any screen size. No separate positioning div needed.
  return <>{tiles}</>;
});

const LiveMapTrafficTiles = React.memo(function LiveMapTrafficTiles({ width, height, viewport }) {
  if (!TOMTOM_API_KEY) return null;
  // Same tile-position/overlay misalignment fix as LiveMapTiles just
  // above — tileZoom picks which discrete tile image to fetch, every
  // on-screen coordinate (including this tile's own corners) projects
  // through the real, continuous viewport.
  const tileZoom = Math.round(viewport.zoom);
  const topLeftLonLat = unprojectFromSvg(0, 0, width, height, viewport);
  const bottomRightLonLat = unprojectFromSvg(width, height, width, height, viewport);
  const topLeft = lonLatToTile(topLeftLonLat.lon, topLeftLonLat.lat, tileZoom);
  const bottomRight = lonLatToTile(bottomRightLonLat.lon, bottomRightLonLat.lat, tileZoom);
  const tiles = [];
  for (let tx = topLeft.x - 1; tx <= bottomRight.x + 1; tx++) {
    for (let ty = topLeft.y - 1; ty <= bottomRight.y + 1; ty++) {
      const nw = tileToLonLat(tx, ty, tileZoom);
      const se = tileToLonLat(tx + 1, ty + 1, tileZoom);
      const p1 = projectToSvg(nw.lat, nw.lon, width, height, viewport);
      const p2 = projectToSvg(se.lat, se.lon, width, height, viewport);
      tiles.push(
        <image
          key={`flow-${tileZoom}-${tx}-${ty}`}
          href={`https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${tileZoom}/${tx}/${ty}.png?key=${TOMTOM_API_KEY}`}
          x={p1.x} y={p1.y}
          width={Math.max(1, p2.x - p1.x)}
          height={Math.max(1, p2.y - p1.y)}
          preserveAspectRatio="none"
          opacity={0.7}
          style={{ pointerEvents: "none" }}
          onError={(e) => { e.target.style.display = "none"; }}
        />
      );
    }
  }
  return <>{tiles}</>;
});

function timeSinceLabel(isoString) {
  if (!isoString) return "no data";
  const diffSec = Math.max(0, Math.round((Date.now() - new Date(isoString).getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  return `${Math.round(diffSec / 3600)}h ago`;
}

function AnnouncementPanel({ dispatch }) {
  const [message, setMessage] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const post = async () => {
    if (!message.trim()) { setError("Enter an announcement message."); return; }
    setPosting(true);
    setError(null);
    setSent(false);
    try {
      await dispatch({ type: "ADMIN/POST_ANNOUNCEMENT", message: message.trim() });
      setMessage("");
      setSent(true);
    } catch (e) {
      setError(e.message || "Couldn't post the announcement — please try again.");
    } finally {
      setPosting(false);
    }
  };

  return (
    <Card>
      <SectionHeader label="📢 Company Announcement" />
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        Sends a notification to every agent and driver — for company-wide memos, not route/location alerts (use Route
        Advisory on the Live Map for those).
      </div>
      <TextField label="Message" value={message} onChange={e => setMessage(e.target.value)} placeholder="e.g. Office closed Friday for public holiday — no dispatch changes." />
      <Button title={posting ? "SENDING…" : "📢 BROADCAST"} variant="amber" size="sm" onClick={post} disabled={posting || !message.trim()} />
      {error && <span style={{ fontSize: 10, color: COLORS.red }}>{error}</span>}
      {sent && !error && <span style={{ fontSize: 10, color: COLORS.green }}>Announcement sent.</span>}
    </Card>
  );
}

function RouteAdvisoryPanel({ state, dispatch, onClose }) {
  const [note, setNote] = useState("");
  const [street, setStreet] = useState("");
  const [coord, setCoord] = useState(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const [clearingId, setClearingId] = useState(null);

  const activeAdvisories = (state.hazard_reports || []).filter(h => h.source === "admin");

  const post = async () => {
    if (!note.trim()) { setError("Enter a message describing the advisory."); return; }
    if (!coord) { setError("Pick the location from the search results (not just typed) before posting."); return; }
    setPosting(true);
    setError(null);
    try {
      await dispatch({ type: "ADMIN/POST_ROUTE_ADVISORY", note: note.trim(), lat: coord.lat, lng: coord.lng });
      setNote(""); setStreet(""); setCoord(null);
    } catch (e) {
      setError(e.message || "Couldn't post the advisory — please try again.");
    } finally {
      setPosting(false);
    }
  };

  const clearAdvisory = async (id) => {
    setClearingId(id);
    setError(null);
    try {
      await dispatch({ type: "ADMIN/CLEAR_ROUTE_ADVISORY", report_id: id });
    } catch (e) {
      setError(e.message || "Couldn't clear the advisory — please try again.");
    } finally {
      setClearingId(null);
    }
  };

  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionHeader label="📢 Route Advisory" />
        {onClose && <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.ghost, fontSize: 14, cursor: "pointer" }}>✕</button>}
      </div>
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        Posts a marker on every active driver's navigation map immediately — for anything you know about from any
        source (radio, a driver's call, local knowledge) that TomTom/formal traffic data wouldn't catch. Stays live
        for {ADMIN_ADVISORY_WINDOW_HOURS}h or until you clear it below.
      </div>
      <TextField label="Advisory Message" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. N2 closed near Mitchells Plain — protest, use M5" />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>LOCATION</span>
        <StreetInput value={street} placeholder="Search an address or area…"
          preConfirmed={coord ? { label: street, area: "", lat: coord.lat, lng: coord.lng } : null}
          onChange={({ street: s, coord: c, confirmed }) => { setStreet(s); if (confirmed) setCoord(c); }} />
      </div>
      <Button title={posting ? "POSTING…" : "📢 POST ADVISORY"} variant="amber" size="sm" onClick={post} disabled={posting || !note.trim()} />
      {error && <span style={{ fontSize: 10, color: COLORS.red }}>{error}</span>}

      {activeAdvisories.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
          <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>ACTIVE ADVISORIES ({activeAdvisories.length})</span>
          {activeAdvisories.map(h => (
            <div key={h.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: 10, border: `1px solid ${COLORS.wire}`, borderRadius: 4 }}>
              <span style={{ fontSize: 11, flex: 1 }}>{h.note}</span>
              <Button title={clearingId === h.id ? "…" : "🗑 CLEAR"} variant="ghost" size="sm" onClick={() => clearAdvisory(h.id)} disabled={clearingId === h.id} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AdminLiveMap({ state, user, dispatch }) {
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  // Drivers explicitly hidden from the map — a "hidden" set rather than a
  // "visible" one so a driver who comes online mid-session (or a newly
  // hired driver) defaults to shown without this needing to be kept in
  // sync with the roster. Per explicit request: at this app's growing
  // scale, being able to declutter the map to just the drivers you're
  // watching matters more once more than a handful are reporting at once.
  const [hiddenDriverIds, setHiddenDriverIds] = useState(() => new Set());
  const toggleDriverVisibility = (driverId) => {
    const isCurrentlyHidden = hiddenDriverIds.has(driverId);
    setHiddenDriverIds(prev => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId); else next.add(driverId);
      return next;
    });
    // FOUND VIA /code-review (9th pass): hiding the currently-selected
    // driver used to leave selectedDriverId pointing at a pin that no
    // longer renders on the map — the info Card below kept showing that
    // driver's stale position/state as if nothing had changed.
    if (!isCurrentlyHidden && driverId === selectedDriverId) setSelectedDriverId(null);
  };
  // Combined driver/agent search — per explicit request. Filters the
  // driver list below and, when agent pins are enabled, surfaces matching
  // agents too so either can be located quickly instead of scanning
  // unlabeled dots on the map.
  const [mapSearchQuery, setMapSearchQuery] = useState("");
  const [showAdvisoryPanel, setShowAdvisoryPanel] = useState(false);
  // "Show traffic" — same toggle concept as DriverNavMap's, extended to
  // the admin live map per explicit request. Defaults on.
  const [showTraffic, setShowTraffic] = useState(true);
  const [trafficIncidents, setTrafficIncidents] = useState([]);
  // Agent home-address pins — off by default (unlike showTraffic) since at
  // this app's target scale (~1800 agents) rendering every agent's pin
  // unconditionally would clutter a map whose primary purpose is tracking
  // DRIVERS, not agents. One tap away via the toggle below either way.
  const [showAgents, setShowAgents] = useState(false);
  const W = 700, H = 560;
  // Viewport state: center lat/lng + zoom level (standard slippy-map
  // zoom, ~10-18 is a reasonable city-to-street range). Starts centered
  // on Cape Town's old fixed bounding box at roughly the same zoom the
  // static version used, so the initial view looks the same as before —
  // pan/zoom is purely additive from here.
  const CPT_CENTER = { lat: (CPT_BOUNDS.north + CPT_BOUNDS.south) / 2, lng: (CPT_BOUNDS.east + CPT_BOUNDS.west) / 2 };
  const [viewport, setViewport] = useState({ centerLat: CPT_CENTER.lat, centerLng: CPT_CENTER.lng, zoom: 11 });
  const dragRef = useRef(null); // { startScreenX, startScreenY, startCenterLat, startCenterLng } while dragging
  const svgRef = useRef(null);

  // Wheel-zoom needs a native, non-passive listener — React's JSX onWheel
  // prop has been passive by default since React 17 (matching the
  // browser's own default for scroll performance), so calling
  // e.preventDefault() inside a JSX onWheel handler is silently ignored:
  // it logs "Unable to preventDefault inside passive event listener
  // invocation" and does NOT actually stop the page underneath from
  // scrolling. Real, confirmed user-facing bug, not just console noise —
  // scrolling the mouse wheel to zoom this map also scrolled the whole
  // admin page at the same time, since the browser's default wheel-scroll
  // behavior was never genuinely suppressed. Attaching the listener
  // directly to the DOM node with { passive: false } is the only way to
  // get a real, working preventDefault() for wheel events. setViewport is
  // a React-guaranteed-stable setter and this uses the functional updater
  // form, so an empty dependency array (attach once) is correct — no
  // stale-closure risk, unlike the DriverNavMap bug class fixed earlier.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      e.preventDefault();
      setViewport(v => ({ ...v, zoom: Math.max(3, Math.min(18, v.zoom + (e.deltaY < 0 ? 0.5 : -0.5))) }));
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Live traffic incidents within the current viewport. Reads viewport via
  // a ref rather than depending on it directly — `viewport` changes on
  // every pointer-move frame while dragging, and re-fetching per-frame
  // would flood TomTom with requests; instead this fetches on mount, on
  // toggle-on, and every 3 minutes, always against whatever the viewport
  // happens to be at that moment.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  useEffect(() => {
    if (!showTraffic) { setTrafficIncidents([]); return; }
    let cancelled = false;
    const fetchIncidents = async () => {
      const vp = viewportRef.current;
      const zoom = Math.round(vp.zoom);
      const topLeft = unprojectFromSvg(0, 0, W, H, { ...vp, zoom });
      const bottomRight = unprojectFromSvg(W, H, W, H, { ...vp, zoom });
      const bounds = {
        minLat: Math.min(topLeft.lat, bottomRight.lat), maxLat: Math.max(topLeft.lat, bottomRight.lat),
        minLng: Math.min(topLeft.lon, bottomRight.lon), maxLng: Math.max(topLeft.lon, bottomRight.lon),
      };
      const incidents = await tomtomTrafficIncidents(bounds);
      if (!cancelled) setTrafficIncidents(incidents);
    };
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 3 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [showTraffic]);

  // Live positions from the fast broadcast channel — keyed by driver id,
  // merged on top of the slower DB-backed state.driver_positions below.
  // The DB version remains the source of truth right after page load (or
  // for a driver who hasn't broadcast yet this session); broadcasts take
  // over the instant they start arriving, giving near-instant pin
  // movement instead of waiting for the ~25s DB persistence cycle.
  const [livePositions, setLivePositions] = useState({});
  useEffect(() => {
    if (!supabase) return;
    const driverIds = state.driver_status.map(ds => ds.driver_id);
    const channels = driverIds.map(id => {
      const ch = supabase.channel(driverPositionChannelName(id));
      ch.on("broadcast", { event: "pos" }, ({ payload }) => {
        setLivePositions(prev => ({
          ...prev,
          [id]: { lat: payload.la, lng: payload.lo, heading: payload.h, speed_kmh: payload.s, trip_id: payload.t, updated_at: new Date(payload.ts).toISOString() },
        }));
      });
      ch.subscribe();
      return ch;
    });
    return () => { channels.forEach(ch => supabase.removeChannel(ch)); };
    // Re-subscribes if the set of drivers changes (new driver added) —
    // deliberately keyed on the joined id list, not driver_status itself,
    // so a driver_status field update (e.g. vehicle edited) doesn't tear
    // down and recreate every channel unnecessarily.
  }, [state.driver_status.map(ds => ds.driver_id).join(",")]);

  // Viewer sees the live map itself (position, status) but not vehicle/
  // phone/address detail — same restriction already applied to the
  // Drivers tab and driver search, just extended to the map's detail
  // card too.
  const showVehicleDetail = hasAdminPermission(user, "viewDriverProfiles");

  const driverPoints = state.driver_status.map(ds => {
    const driverUser = state.users.find(u => String(u.id) === String(ds.driver_id));
    // Prefer the live broadcast position when available — it's always
    // more current than the DB-backed one once a driver starts sending.
    const pos = livePositions[ds.driver_id] || state.driver_positions?.[ds.driver_id];
    const trip = pos?.trip_id ? state.trips.find(t => String(t.trip_id) === String(pos.trip_id)) : null;
    // Stale = no update in over 30s, roughly 4x the expected ~8s interval —
    // catches a driver whose tab was closed or lost signal, not just normal
    // jitter between updates.
    const stale = pos ? (Date.now() - new Date(pos.updated_at).getTime()) > 30000 : true;
    return { driverId: ds.driver_id, name: driverUser?.name || "Unknown", vehicle: ds.vehicle, state: ds.state, pos, trip, stale, is_online: ds.is_online, is_away: ds.is_away };
  });

  // Agent home-address pins — memoized on state.users alone (not
  // livePositions/viewport, both of which change every ~8s per active
  // driver) so filtering ~1800 agents at this app's target scale doesn't
  // redo on every GPS tick, only when the user list itself actually
  // changes. Screen-projecting the (small, already-filtered) result is
  // cheap and stays inline in the render below, same as driverPoints.
  const agentHomePoints = React.useMemo(
    () => state.users.filter(u => u.role === ROLE.AGENT && u.home_address?.lat != null),
    [state.users]
  );
  // Same visibility restriction as showVehicleDetail below — an agent's
  // home address is the same class of profile detail already gated
  // behind a permission everywhere else it's shown (Users tab, driver
  // detail panel). Currently a no-op for the only two tiers that reach
  // this component (FLEET_OPS/STANDARD both hard-code viewUsers:true),
  // but stops a future admin tier without viewUsers from seeing every
  // agent's home address on the map despite lacking it anywhere else.
  const showAgentPins = hasAdminPermission(user, "viewUsers");
  // Viewport-culled to only agents currently visible on screen (+ a small
  // padding so a pin doesn't pop in/out right at the edge while panning)
  // — FOUND VIA /code-review: projecting+rendering EVERY agent's pin on
  // every viewport-change re-render (which fires on every pointer-move
  // frame while dragging) caused real jank once this toggle was on, at
  // this app's target scale (~1800 agents). Reuses the exact bounding-box
  // technique the traffic-incident fetch effect above already uses.
  let visibleAgentPoints = [];
  if (showAgents && showAgentPins && agentHomePoints.length > 0) {
    const topLeft = unprojectFromSvg(0, 0, W, H, viewport);
    const bottomRight = unprojectFromSvg(W, H, W, H, viewport);
    const pad = 0.05; // ~5km buffer
    const minLat = Math.min(topLeft.lat, bottomRight.lat) - pad, maxLat = Math.max(topLeft.lat, bottomRight.lat) + pad;
    const minLng = Math.min(topLeft.lon, bottomRight.lon) - pad, maxLng = Math.max(topLeft.lon, bottomRight.lon) + pad;
    visibleAgentPoints = agentHomePoints.filter(u =>
      u.home_address.lat >= minLat && u.home_address.lat <= maxLat &&
      u.home_address.lng >= minLng && u.home_address.lng <= maxLng
    );
  }

  const withPosition = driverPoints.filter(d => d.pos);
  // Excludes drivers hidden via the eye-toggle — FOUND VIA /code-review:
  // fitAllDrivers used to fit withPosition (every reporting driver)
  // regardless of hiddenDriverIds, so "SEE ALL DRIVERS" zoomed out to fit
  // pins the admin had just explicitly hidden, undoing the declutter the
  // hide feature exists for.
  const visibleWithPosition = withPosition.filter(d => !hiddenDriverIds.has(d.driverId));
  const selected = selectedDriverId ? driverPoints.find(d => d.driverId === selectedDriverId) : null;
  const mapSearchQueryTrimmed = mapSearchQuery.trim().toLowerCase();
  const filteredDriverPoints = mapSearchQueryTrimmed
    ? driverPoints.filter(d => d.name.toLowerCase().includes(mapSearchQueryTrimmed))
    : driverPoints;
  // Capped at 20 — at this app's target scale (~1800 agents) an unbounded
  // match list on a broad query (e.g. a common first name) would be its
  // own scroll-wall; a search is only useful here for narrowing down to
  // the handful the admin is actually looking for.
  const matchingAgents = React.useMemo(() => {
    if (!mapSearchQueryTrimmed || !showAgentPins) return [];
    return agentHomePoints.filter(u => (u.name || "").toLowerCase().includes(mapSearchQueryTrimmed)).slice(0, 20);
  }, [mapSearchQueryTrimmed, showAgentPins, agentHomePoints]);

  const zoomIn = () => setViewport(v => ({ ...v, zoom: Math.min(18, v.zoom + 1) }));
  const zoomOut = () => setViewport(v => ({ ...v, zoom: Math.max(3, v.zoom - 1) }));

  // Selecting a driver (from the map pin, the list, or a search match)
  // also un-hides them (a hidden driver has no pin to click on the map in
  // the first place, but the list/search paths can reach a hidden one)
  // and recenters the map on their current position — makes "search for a
  // driver" and "select a driver" the same jump-to-them action instead of
  // just opening the info panel on a pin that might be off-screen.
  const selectDriver = (driverId) => {
    const isDeselecting = driverId === selectedDriverId;
    setSelectedDriverId(isDeselecting ? null : driverId);
    if (isDeselecting) return;
    setHiddenDriverIds(prev => { if (!prev.has(driverId)) return prev; const next = new Set(prev); next.delete(driverId); return next; });
    const d = driverPoints.find(x => x.driverId === driverId);
    if (d?.pos) setViewport(v => ({ ...v, centerLat: d.pos.lat, centerLng: d.pos.lng, zoom: Math.max(v.zoom, 14) }));
    // Same fix as focusOnAgent below (FOUND VIA /code-review, 10th
    // pass): once a driver's been jumped to, a leftover search query
    // just keeps the list/results narrowed for no further reason.
    setMapSearchQuery("");
  };
  const focusOnAgent = (agentUser) => {
    if (agentUser.home_address?.lat == null) return;
    setShowAgents(true);
    setViewport(v => ({ ...v, centerLat: agentUser.home_address.lat, centerLng: agentUser.home_address.lng, zoom: Math.max(v.zoom, 15) }));
    // FOUND VIA /code-review (10th pass): left mapSearchQuery untouched,
    // so after jumping to the agent the driver list stayed narrowed to
    // the stale query and the "Matching Agents" panel kept rendering,
    // even though the search's job (locating this agent) was already
    // done. selectDriver above had the identical gap for its own jump
    // action, fixed the same way.
    setMapSearchQuery("");
  };

  // "See all active drivers" — recenter and zoom the viewport so every
  // currently-reporting driver fits on screen at once. This is the real
  // fix for pins that looked "missing" because they were outside the old
  // fixed Cape Town box, or too close together to tell apart without
  // zooming — recentering makes both cases immediately visible instead
  // of requiring someone to guess where an off-screen pin might be.
  const fitAllDrivers = () => {
    if (visibleWithPosition.length === 0) return;
    const lats = visibleWithPosition.map(d => d.pos.lat), lngs = visibleWithPosition.map(d => d.pos.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const centerLat = (minLat + maxLat) / 2, centerLng = (minLng + maxLng) / 2;
    // Pick the zoom level where the lat/lng span of all drivers still
    // fits comfortably within the canvas, with some padding — tried from
    // most-zoomed-in downward until the projected span fits.
    let zoom = 15;
    for (; zoom > 3; zoom--) {
      const p1 = lonLatToWorldPixel(minLng, maxLat, zoom);
      const p2 = lonLatToWorldPixel(maxLng, minLat, zoom);
      const spanX = Math.abs(p2.x - p1.x), spanY = Math.abs(p2.y - p1.y);
      if (spanX < W * 0.75 && spanY < H * 0.75) break;
    }
    setViewport({ centerLat, centerLng, zoom });
  };

  // Drag-to-pan: on mouse/touch down, record the starting screen position
  // and the viewport's center at that moment. On move, compute how many
  // screen pixels the pointer has moved and convert that into a real
  // lat/lng shift for the center — same math as unprojectFromSvg, just
  // applied to a delta instead of an absolute point.
  const pinchRef = useRef(null); // tracks 2-finger pinch state
  const handlePointerDown = (e) => {
    const rect = svgRef.current.getBoundingClientRect();
    if (e.touches && e.touches.length === 2) {
      // Two-finger pinch start — record initial distance and zoom
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      pinchRef.current = { startDist: dist, startZoom: viewport.zoom };
      dragRef.current = null;
      return;
    }
    pinchRef.current = null;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = {
      startScreenX: clientX, startScreenY: clientY,
      startCenterLat: viewport.centerLat, startCenterLng: viewport.centerLng,
      // Capture rect fresh — critical for correct coordinate scaling
      rectWidth: rect.width, rectHeight: rect.height,
    };
  };
  const handlePointerMove = (e) => {
    // Two-finger pinch — scale zoom by ratio of current to initial finger distance
    if (e.touches && e.touches.length === 2 && pinchRef.current) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const ratio = dist / pinchRef.current.startDist;
      const newZoom = Math.max(3, Math.min(18, pinchRef.current.startZoom + Math.log2(ratio)));
      setViewport(v => ({ ...v, zoom: newZoom }));
      return;
    }
    if (!dragRef.current) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dxScreen = clientX - dragRef.current.startScreenX;
    const dyScreen = clientY - dragRef.current.startScreenY;
    // Re-read rect on each move — avoids stale rect from layout shifts
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = W / rect.width, scaleY = H / rect.height;
    const startCenterPx = lonLatToWorldPixel(dragRef.current.startCenterLng, dragRef.current.startCenterLat, viewport.zoom);
    const newCenterPx = { x: startCenterPx.x - dxScreen * scaleX, y: startCenterPx.y - dyScreen * scaleY };
    const newCenterLonLat = worldPixelToLonLat(newCenterPx.x, newCenterPx.y, viewport.zoom);
    setViewport(v => ({ ...v, centerLat: newCenterLonLat.lat, centerLng: newCenterLonLat.lon }));
  };
  const handlePointerUp = () => { dragRef.current = null; pinchRef.current = null; };
  // Expanding the map doesn't touch any of the pan/zoom/projection logic
  // above — the SVG already scales to fill its container via width/
  // height: 100%, so making the container itself fullscreen is enough.
  // A dedicated button (not a click-anywhere-on-the-map handler) since
  // the map surface itself already uses clicks to select a driver pin —
  // overloading that same gesture to also expand the map would make
  // selecting a driver and expanding the map fight over the same tap.
  const [isMapExpanded, setIsMapExpanded] = useState(false);

  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <SectionHeader label={`Live Driver Tracking (${withPosition.length}/${driverPoints.length} reporting)`} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {hasAdminPermission(user, "manageDispatch") && (
            <Button title="📢 ADVISORY" variant={showAdvisoryPanel ? "amber" : "ghost"} size="sm" onClick={() => setShowAdvisoryPanel(v => !v)} />
          )}
          <Button title="🚦 TRAFFIC" variant={showTraffic ? "amber" : "ghost"} size="sm" onClick={() => setShowTraffic(v => !v)} />
          {showAgentPins && <Button title="📍 AGENTS" variant={showAgents ? "amber" : "ghost"} size="sm" onClick={() => setShowAgents(v => !v)} />}
          <Button title="🎯 SEE ALL DRIVERS" variant="ghost" size="sm" onClick={fitAllDrivers} disabled={visibleWithPosition.length === 0} />
          <Button title="−" variant="ghost" size="sm" onClick={zoomOut} style={{ width: 32 }} />
          <Button title="+" variant="ghost" size="sm" onClick={zoomIn} style={{ width: 32 }} />
          <Button title={isMapExpanded ? "⤡ SHRINK" : "⤢ EXPAND"} variant="ghost" size="sm" onClick={() => setIsMapExpanded(v => !v)} />
        </div>
      </div>
      {showAdvisoryPanel && hasAdminPermission(user, "manageDispatch") && (
        <RouteAdvisoryPanel state={state} dispatch={dispatch} onClose={() => setShowAdvisoryPanel(false)} />
      )}
      <div style={{ fontSize: 10, color: COLORS.ghost, marginBottom: 4 }}>
        Positions update while a driver has the app open and an active trip. Grey pins haven't reported in over 30 seconds. Drag to pan, use +/− or scroll to zoom.
      </div>

      {isMapExpanded && (
        <div onClick={() => setIsMapExpanded(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", zIndex: 199, animation: "fadeIn .15s ease" }} />
      )}
      <div style={isMapExpanded ? {
        position: "fixed", zIndex: 200,
        top: 0, left: 0, right: 0, bottom: 0,
        display: "flex", flexDirection: "column",
        background: COLORS.bg,
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      } : undefined}>
        {/* Floating controls — always visible inside the map when expanded */}
        {isMapExpanded && (
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 12px", background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`,
            flexShrink: 0,
          }}>
            <div style={{ display: "flex", gap: 6 }}>
              <Button title="🎯" variant="ghost" size="sm" onClick={fitAllDrivers} disabled={visibleWithPosition.length === 0} style={{ width: 36 }} />
              <Button title="−" variant="ghost" size="sm" onClick={zoomOut} style={{ width: 36 }} />
              <Button title="+" variant="ghost" size="sm" onClick={zoomIn} style={{ width: 36 }} />
            </div>
            <Button title="✕ CLOSE" variant="ghost" size="sm" onClick={() => setIsMapExpanded(false)} />
          </div>
        )}
        <Card body={false} style={{ padding: 0, overflow: "hidden", ...(isMapExpanded ? { flex: 1, minHeight: 0 } : {}) }}>
          {/* minHeight 280px prevents the map collapsing to nothing on narrow mobile screens.
              The SVG viewBox is always 700×560 (internal coordinate space for projection
              maths) but the rendered element fills its container — touch coordinates are
              scaled by getBoundingClientRect() in the pointer handlers, so pins stay
              accurate regardless of actual screen width. */}
          <div style={{ position: "relative", width: "100%", minHeight: 280,
            height: isMapExpanded ? "100%" : undefined,
            aspectRatio: isMapExpanded ? undefined : `${W} / ${H}` }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block",
              cursor: dragRef.current ? "grabbing" : "grab",
              touchAction: "none" /* prevent browser scroll-hijack during map pan */ }}
            onMouseDown={handlePointerDown} onMouseMove={handlePointerMove} onMouseUp={handlePointerUp} onMouseLeave={handlePointerUp}
            // No e.preventDefault() here — same passive-listener limit as
            // the wheel handler above (JSX onTouch* is passive since
            // React 17, so the call could never succeed), but harmless to
            // drop: touchAction: "none" below already suppresses the
            // browser's default touch scroll/pan/zoom at the CSS/UA
            // level, independent of JS preventDefault.
            onTouchStart={handlePointerDown}
            onTouchMove={handlePointerMove}
            onTouchEnd={handlePointerUp}
          >
          {/* Map background — visible while tiles load */}
          <rect width={W} height={H} fill="#1a2333" />
          {/* Tile layer — SVG <image> elements mapped to the same viewBox coords as pins */}
          <LiveMapTiles width={W} height={H} viewport={viewport} />
          {showTraffic && <LiveMapTrafficTiles width={W} height={H} viewport={viewport} />}
          {/* Live traffic incidents (accidents/closures/jams/roadworks) —
              same TomTom Incidents v5 data as DriverNavMap's toggle, see
              tomtomTrafficIncidents. Native <title> gives a hover tooltip
              without needing a Leaflet-style popup component in this
              hand-rolled SVG map. */}
          {showTraffic && trafficIncidents.map(inc => {
            const p = projectToSvg(inc.lat, inc.lng, W, H, viewport);
            return (
              <g key={inc.id} className="marker-pop" style={{ transformOrigin: `${p.x}px ${p.y}px` }}>
                <title>{`${inc.description}${inc.from ? ` — ${inc.from}${inc.to ? " → " + inc.to : ""}` : ""}${inc.delaySec ? ` (+${Math.round(inc.delaySec / 60)} min)` : ""}`}</title>
                <circle cx={p.x} cy={p.y} r={9} fill={COLORS.panel} stroke={COLORS.blue} strokeWidth={1.5} opacity={0.9} />
                <text x={p.x} y={p.y} fontSize={11} textAnchor="middle" dominantBaseline="central" style={{ pointerEvents: "none" }}>
                  {TRAFFIC_INCIDENT_ICON[inc.iconCategory] || "❗"}
                </text>
              </g>
            );
          })}
          {/* Company location reference points */}
          {(state.companies || []).filter(co => co.address?.lat != null).map(co => {
            const p = projectToSvg(co.address.lat, co.address.lng, W, H, viewport);
            return (
              <g key={co.id}>
                <rect x={p.x - 5} y={p.y - 5} width={10} height={10} fill={COLORS.amber} opacity={0.7} />
                <text x={p.x + 8} y={p.y + 4} fontSize={9} fill={COLORS.ghost}>{co.name}</text>
              </g>
            );
          })}

          {/* Agent home-address pins — small red dots, toggled via the
              📍 AGENTS button. Native <title> gives a hover/tap tooltip
              (name + address) without needing a popup component, same
              pattern as the traffic-incident markers above. Deliberately
              no persistent text label per marker (unlike the company
              reference points) — at this app's target scale of ~1800
              agents, always-on labels would make the map unreadable the
              moment this toggle is on. */}
          {visibleAgentPoints.map(u => {
            const p = projectToSvg(u.home_address.lat, u.home_address.lng, W, H, viewport);
            return (
              <g key={u.id}>
                <title>{`${u.name}${u.home_address.label ? ` — ${u.home_address.label}` : ""}`}</title>
                <circle cx={p.x} cy={p.y} r={4} fill={COLORS.red} stroke={COLORS.panel} strokeWidth={1} opacity={0.85} />
              </g>
            );
          })}

          {/* FOUND VIA /code-review (7th pass): re-filtered driverPoints
              here instead of reusing visibleWithPosition, which is
              exactly this expression, defined above — kept in sync by
              construction instead of by hand now. */}
          {visibleWithPosition.map(d => {
            const p = projectToSvg(d.pos.lat, d.pos.lng, W, H, viewport);
            const color = d.stale ? COLORS.ghost : d.state === DRIVER_STATE.BUSY ? COLORS.amber : COLORS.green;
            const isSelected = selectedDriverId === d.driverId;
            return (
              // Position moved onto a single outer transform (was separate
              // absolute cx/cy/x/y on every child before) specifically so
              // svg-driver-marker's CSS transition can animate the WHOLE
              // marker gliding between GPS ticks instead of snapping — per
              // explicit request that the live map felt flat. Rotation
              // lives on its own nested <g> (car glyph only — the status
              // ring and name label must stay upright, not spin with
              // heading), animated independently so a heading change
              // doesn't also restart the position glide.
              <g key={d.driverId}
                className="svg-driver-marker"
                transform={`translate(${p.x},${p.y})`}
                onClick={() => selectDriver(d.driverId)}
                style={{ cursor: "pointer" }}>
                {/* Invisible hit target — 44px equivalent in SVG coords (~22 units radius
                    at typical zoom) so taps land on mobile even with imprecise fingers */}
                <circle cx={0} cy={0} r={18} fill="transparent" />
                {isSelected && <circle cx={0} cy={0} r={16} fill="none" stroke={color} strokeWidth={1.5} opacity={0.4} />}
                {/* Flat-fill "shadow" ellipse instead of a CSS drop-shadow
                    filter — FOUND VIA AUDIT: this map re-renders every
                    driver marker on every ~8s position broadcast (see
                    livePositions above), and an SVG filter forces the
                    browser to rasterize+blur each marker to an offscreen
                    buffer every time, compounded by the transform
                    transition on the car <g> below re-triggering it on
                    every heading change too. A plain semi-transparent
                    shape is a flat fill, not a blur — same visual "lifted
                    off the map" depth cue at a fraction of the paint cost.
                    Lives in the non-rotating outer <g> (unlike the car
                    body) since a shadow shouldn't spin with heading. */}
                <ellipse cx={0} cy={3} rx={7} ry={2.5} fill="rgba(0,0,0,.4)" opacity={d.stale ? 0.5 : 1} />
                {/* Pin body — a vector top-down car silhouette per explicit
                    request to match Bolt/Uber's marker style, replacing the
                    emoji glyph this used before. Rotates to face the
                    driver's actual heading, which also makes a separate
                    heading-line indicator redundant (one rotated icon reads
                    more clearly than a dot + a separate direction line) —
                    matches how Waze/Google Maps show a single rotated car
                    glyph. Unlike the emoji it replaces, an SVG shape IS
                    tintable, so the body itself now carries the busy/
                    available/stale status color directly (solid color car,
                    same as Bolt's own live-map pins) instead of needing a
                    separate colored ring around a fixed glyph. */}
                <g
                  // !d.stale check restored — a stale position's heading
                  // could be significantly outdated (the driver may have
                  // long since turned or stopped), so this matches the old
                  // heading-line indicator's own deliberate exclusion
                  // rather than rotating the icon to a potentially
                  // misleading direction for data that's no longer fresh.
                  transform={d.pos.heading != null && !d.stale ? `rotate(${d.pos.heading})` : undefined}
                  style={{ transition: "transform .4s ease" }}
                >
                  {/* Single shared opacity for the whole car — FOUND VIA
                      AUDIT: body/windshield previously carried two
                      independently-chosen stale ratios (0.65/1 vs 0.55/0.9)
                      for what's meant to be the same "dim when stale"
                      signal, risking drift if one is ever tweaked without
                      the other. */}
                  <rect x={-6.5} y={-11} width={13} height={22} rx={5.5} fill={color} stroke={COLORS.panel} strokeWidth={1.5} opacity={d.stale ? 0.6 : 1} />
                  <rect x={-4} y={-6.5} width={8} height={6.5} rx={2} fill={COLORS.panel} opacity={d.stale ? 0.6 : 1} />
                </g>
                {/* Name label above pin */}
                <text x={0} y={-14} fontSize={9} fontWeight={700} fill={COLORS.chalk}
                  textAnchor="middle" style={{ pointerEvents: "none" }}>
                  {d.name.split(" ")[0]}
                </text>
              </g>
            );
          })}
          </svg>
        </div>
      </Card>
      </div>

      {selected && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
              {showVehicleDetail && <div style={{ fontSize: 10, color: COLORS.ghost }}>{selected.vehicle}</div>}
            </div>
            <StateBadge state={selected.stale ? "OFFLINE" : selected.state} />
          </div>
          {selected.pos ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 10 }}>
              <span><span style={{ color: COLORS.ghost }}>UPDATED: </span>{timeSinceLabel(selected.pos.updated_at)}</span>
              {selected.pos.speed_kmh != null && <span><span style={{ color: COLORS.ghost }}>SPEED: </span>{Math.round(selected.pos.speed_kmh)} km/h</span>}
              {selected.pos.accuracy_m != null && <span><span style={{ color: COLORS.ghost }}>ACCURACY: </span>±{Math.round(selected.pos.accuracy_m)}m</span>}
            </div>
          ) : (
            <span style={{ fontSize: 10, color: COLORS.ghost }}>No position data yet.</span>
          )}
          {selected.trip && (
            <div style={{ fontSize: 10, color: COLORS.mist }}>On trip {selected.trip.trip_id} — {selected.trip.agent_ids?.length || 1} passenger{(selected.trip.agent_ids?.length || 1) !== 1 ? "s" : ""}</div>
          )}
        </Card>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <SectionHeader label="All Drivers" />
        <div style={{ display: "flex", gap: 6 }}>
          {/* FOUND VIA /code-review (9th pass): SHOW ALL used to
              unconditionally clear the ENTIRE hidden set, asymmetric with
              HIDE ALL's own search-scoping fix right below — searching
              "north", hiding just those matches, then later searching
              something else and hitting SHOW ALL would un-hide every
              driver hidden all session, not just the current search's.
              Now scoped to filteredDriverPoints on both sides. */}
          <Button
            title="SHOW ALL" variant="ghost" size="sm"
            disabled={!filteredDriverPoints.some(d => hiddenDriverIds.has(d.driverId))}
            onClick={() => setHiddenDriverIds(prev => {
              const next = new Set(prev);
              filteredDriverPoints.forEach(d => next.delete(d.driverId));
              return next;
            })}
          />
          {/* FOUND VIA /code-review (8th pass): used to hide the whole
              fleet (driverPoints) regardless of an active search, so
              searching down to a few drivers then hitting HIDE ALL wiped
              every pin on the map instead of just the searched ones —
              defeating the point of scoping HIDE ALL to what's actually
              shown in the (possibly search-filtered) list right above
              it. Unions into the existing hidden set rather than
              replacing it, so drivers hidden outside the current search
              stay hidden too. */}
          {/* FOUND VIA /code-review (11th pass): had no disabled guard
              (unlike SHOW ALL right above), so clicking it when every
              filtered driver was already hidden still built and
              committed a brand-new Set with identical contents — a
              no-op re-render on every redundant click. */}
          <Button
            title="HIDE ALL" variant="ghost" size="sm"
            disabled={filteredDriverPoints.every(d => hiddenDriverIds.has(d.driverId))}
            onClick={() => {
              setHiddenDriverIds(prev => new Set([...prev, ...filteredDriverPoints.map(d => d.driverId)]));
              // FOUND VIA /code-review (9th pass): same stale-info-panel
              // hazard as the per-row eye-toggle above, but for the bulk
              // action — if the currently-selected driver falls within
              // the batch just hidden, clear the selection too.
              if (selectedDriverId && filteredDriverPoints.some(d => d.driverId === selectedDriverId)) setSelectedDriverId(null);
            }}
          />
        </div>
      </div>
      <input
        className="inp" value={mapSearchQuery} onChange={e => setMapSearchQuery(e.target.value)}
        placeholder="Search drivers or agents…" style={{ width: "100%", marginBottom: 8 }}
      />
      {filteredDriverPoints.map(d => {
        const isHidden = hiddenDriverIds.has(d.driverId);
        return (
        <div key={d.driverId} onClick={() => selectDriver(d.driverId)}
          style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 10, borderBottom: `1px solid ${COLORS.wire}`, background: d.driverId === selectedDriverId ? "rgba(245,166,35,.05)" : "transparent", opacity: isHidden ? 0.5 : 1 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: !d.pos || d.stale ? COLORS.ghost : d.state === DRIVER_STATE.BUSY ? COLORS.amber : COLORS.green, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700 }}>{d.name}</span>
              {/* Position/state dot above is unaffected by online/away — a driver
                  who's "away" (app backgrounded) still shows their real live
                  position and state normally; only this presence pill changes. */}
              {d.is_online && (
                d.is_away
                  ? <span style={{ fontSize: 8, color: COLORS.amber, fontWeight: 700, letterSpacing: .5, border: `1px solid ${COLORS.amber}`, borderRadius: 2, padding: "1px 4px" }}>AWAY</span>
                  : <span style={{ fontSize: 8, color: COLORS.green, fontWeight: 700, letterSpacing: .5, border: `1px solid ${COLORS.green}`, borderRadius: 2, padding: "1px 4px" }}>ONLINE</span>
              )}
            </div>
            <div style={{ fontSize: 9, color: COLORS.ghost }}>{d.pos ? timeSinceLabel(d.pos.updated_at) : "never reported"}</div>
          </div>
          <StateBadge state={!d.pos || d.stale ? "OFFLINE" : d.state} />
          {/* Visibility toggle — separate from the row's own select-and-jump
              click above (stopPropagation so tapping the eye doesn't also
              select/jump), hides just this driver's pin from the map
              without affecting the info panel or the list itself. */}
          <button
            onClick={(e) => { e.stopPropagation(); toggleDriverVisibility(d.driverId); }}
            title={isHidden ? "Show on map" : "Hide from map"}
            style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, padding: 4, lineHeight: 1, color: isHidden ? COLORS.ghost : COLORS.mist }}
          >{isHidden ? "🚫" : "👁"}</button>
        </div>
        );
      })}
      {/* FOUND VIA /code-review (6th pass): matchingAgents is forced to []
          whenever showAgentPins is false (no viewUsers permission), same
          as visibleAgentPoints above — without accounting for that here,
          an admin lacking that permission would see "no matches" even
          when a real agent match exists, just not shown to their tier. */}
      {mapSearchQueryTrimmed && filteredDriverPoints.length === 0 && matchingAgents.length === 0 && (
        <div style={{ fontSize: 10, color: COLORS.ghost, padding: 10 }}>
          {showAgentPins ? "No matching drivers or agents." : "No matching drivers."}
        </div>
      )}
      {matchingAgents.length > 0 && (
        <>
          <SectionHeader label="Matching Agents" />
          {matchingAgents.map(u => (
            <div key={u.id} onClick={() => focusOnAgent(u)}
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 10, borderBottom: `1px solid ${COLORS.wire}` }}>
              <span style={{ width: 8, height: 8, borderRadius: 4, background: COLORS.red, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 11, fontWeight: 700 }}>{u.name}</span>
                <div style={{ fontSize: 9, color: COLORS.ghost }}>{u.home_address?.label || u.home_address?.area || "Home address on file"}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function computeLiveSequenceForDriver(driverTrips, state) {
  const pickupStops = driverTrips.flatMap(trip =>
    (trip.pickup_sequence_coords || []).map((p, idx) => {
      const agentId = p.agent_id ?? trip.agent_ids?.[idx];
      const agentUser = state.users.find(u => String(u.id) === String(agentId));
      return {
        lat: p.lat, lng: p.lng, label: p.label || trip.custom_pickup,
        trip_id: trip.trip_id, agent_id: agentId,
        agent_name: agentUser?.name || trip.agent_name,
        done: !!(agentId != null && trip.completed_pickups?.some(c => String(c) === String(agentId))),
      };
    })
  );
  // ROOT-CAUSE FIX — this function backs AdminActiveTrips, whose own
  // on-screen copy explicitly promises "Live pickup/drop-off order
  // exactly as it appears on each driver's own navigation screen." It
  // never actually did: this is a wholly separate, pure-haversine
  // implementation (no TomTom call at all, unlike DriverNavTab's real
  // optimization) that anchored on defaultCompanyAnchor(state) — the
  // company OFFICE — exactly the same wrong-anchor bug just fixed in
  // DriverNavTab (commit d682f47, trip 211), except here there's no
  // TomTom step afterward to ever correct it, so the wrong order was
  // PERMANENT for this screen, not just a brief pre-TomTom flash. Same
  // fix: anchor on the last completed pickup (or the first pickup stop
  // before any are done), matching where the driver actually starts
  // drop-offs from.
  const lastPickupDone = [...pickupStops].reverse().find(s => s.done) || pickupStops[0];
  const lastPickupCoord = lastPickupDone ? { lat: lastPickupDone.lat, lng: lastPickupDone.lng } : null;
  const dropoffGroups = {};
  driverTrips.forEach(trip => {
    let dropCoords = trip.dropoff_sequence_coords || [];
    if (trip.direction === "OUTBOUND" && dropCoords.length < (trip.agent_ids?.length || 0)) {
      const derivedCoords = [...dropCoords];
      const coveredAgentIds = new Set(dropCoords.map(d => d.agent_id).filter(Boolean));
      (trip.agent_ids || []).forEach(agentId => {
        if (coveredAgentIds.has(agentId)) return;
        const agentUser = state.users.find(u => String(u.id) === String(agentId));
        if (agentUser?.home_address?.lat != null) {
          derivedCoords.push({ lat: agentUser.home_address.lat, lng: agentUser.home_address.lng, label: agentUser.home_address.label, agent_id: agentId, _derived: true });
        }
      });
      dropCoords = derivedCoords;
    }
    if (trip.direction === "OUTBOUND" && dropCoords.length > 1) {
      const anchor = lastPickupCoord || defaultCompanyAnchor(state);
      dropCoords = sortDropoffCoordsByProximity(dropCoords, anchor);
    }
    if (dropCoords.length === 0) return;
    dropCoords.forEach((coord, coordIdx) => {
      if (!coord) return;
      const key = `${parseFloat(coord.lat).toFixed(4)},${parseFloat(coord.lng).toFixed(4)}`;
      if (!dropoffGroups[key]) dropoffGroups[key] = { lat: coord.lat, lng: coord.lng, label: coord.label || trip.custom_dropoff, passengers: [], done: false };
      // dropoff_sequence_coords entries hydrated fresh from Supabase (the
      // normal case for essentially every real trip — see the DB-row
      // mapping that builds { lat, lng } with no agent_id) carry no
      // agent_id at all. The old code here special-cased ONLY coordIdx 0,
      // dumping every agent on the trip onto the first stop and leaving
      // every other untagged stop with zero passengers — which then read
      // as "done" via Array.every's vacuous truth on an empty array,
      // hiding real in-progress dropoffs from the admin's live view.
      // A single dropoff entry legitimately means "everyone drops here
      // together" (e.g. INBOUND to one shared office address) — that case
      // still assigns every agent. For a genuine multi-stop, untagged trip,
      // fall back to the same by-position convention already used
      // elsewhere in this codebase for this exact data shape (see e.g. the
      // dropCoord lookup in the CSV/passenger-list builder: find by
      // agent_id, else dropoff_sequence_coords[aidIdx], else [0]).
      const resolvedAgentIds = coord.agent_id
        ? [coord.agent_id]
        : dropCoords.length === 1
          ? (trip.agent_ids || [trip.agent_id]).filter(Boolean)
          : [trip.agent_ids?.[coordIdx]].filter(Boolean);
      resolvedAgentIds.forEach(aid => {
        const u = state.users.find(x => String(x.id) === String(aid));
        if (!dropoffGroups[key].passengers.find(p => String(p.id) === String(aid) && p.trip_id === trip.trip_id)) {
          dropoffGroups[key].passengers.push({ id: aid, name: u?.name || trip.agent_name, trip_id: trip.trip_id });
        }
      });
    });
  });
  const dropGroupList = Object.values(dropoffGroups);
  dropGroupList.forEach(group => {
    group.done = group.passengers.every(p => {
      const t = driverTrips.find(x => String(x.trip_id) === String(p.trip_id));
      return t && (t.completed_dropoffs || []).some(c => String(c) === String(p.id));
    });
  });
  // Deliberately returns dropGroupList UNSORTED — sequencing now happens in
  // ActiveDriverCard via the same useSortedDropoffs/TomTom path DriverNavTab
  // uses, not a synchronous haversine-only sort here (see that component's
  // comment for why: this function previously called sortDropoffsByProximity
  // directly, which is a pure greedy-nearest-neighbour heuristic with NO
  // real road-routing awareness — confirmed via trip 227, a real reported
  // case, to produce a genuinely bad tour: greedily chasing the single
  // nearest stop first can strand a stop in the opposite direction for a
  // huge backtracking final leg, exactly what happened there. This
  // function's caller explicitly promises to match "each driver's own
  // navigation screen" — which DOES call TomTom — so this needs to too.
  return { pickupStops, dropGroupList, lastPickupCoord };
}

function ActiveDriverCard({ ds, driverTrips, state }) {
  const driverUser = state.users.find(u => String(u.id) === String(ds.driver_id));
  const { pickupStops, dropGroupList, lastPickupCoord } = computeLiveSequenceForDriver(driverTrips, state);
  const allPickedUp = pickupStops.length > 0 && pickupStops.every(s => s.done);
  const direction = driverTrips[0]?.direction || "OUTBOUND";
  const tripKey = driverTrips.map(t => t.trip_id).join("-");
  const destination = direction === "INBOUND" ? defaultCompanyAnchor(state) : null;
  const departAtEpoch = driverTrips.map(t => t.scheduled_time_epoch).filter(Boolean).sort((a, b) => a - b)[0] ?? null;
  const navAnchor = lastPickupCoord || defaultCompanyAnchor(state);
  const dropGroupCoords = dropGroupList.map(g => ({ lat: g.lat, lng: g.lng }));
  // Called unconditionally (before any early return) — same rule as
  // DriverNavTab's identical call.
  const [tomtomSortedCoords] = useSortedDropoffs(dropGroupCoords, navAnchor, direction, tripKey, undefined, destination, departAtEpoch);
  let dropStops;
  if (tomtomSortedCoords && tomtomSortedCoords.length === dropGroupList.length) {
    const coordKey = c => `${parseFloat(c.lat).toFixed(4)},${parseFloat(c.lng).toFixed(4)}`;
    const groupByKey = Object.fromEntries(dropGroupList.map(g => [coordKey(g), g]));
    const reordered = tomtomSortedCoords.map(c => groupByKey[coordKey(c)]).filter(Boolean);
    const reorderedKeys = new Set(reordered.map(g => coordKey(g)));
    const missed = dropGroupList.filter(g => !reorderedKeys.has(coordKey(g)));
    dropStops = [...reordered, ...missed];
  } else {
    dropStops = sortDropoffsByProximity(dropGroupList, navAnchor);
  }
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 700 }}>{driverUser?.name || "Driver"}</span>
        {/* Real trip state, not a hardcoded IN_TRANSIT — this card now
            also shows a DRIVER_CONFIRMED driver who's started navigating
            to their first pickup but hasn't picked everyone up yet (see
            the widened filter above); showing "IN TRANSIT" for that case
            would misleadingly imply pickups are already done. */}
        <StateBadge state={driverTrips[0].state} />
      </div>
      <div style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase", letterSpacing: 1, marginTop: 6 }}>
        {allPickedUp ? "Drop-offs" : "Pickups"}
      </div>
      {!allPickedUp ? (
        pickupStops.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: i < pickupStops.length - 1 ? `1px solid ${COLORS.wire}` : "none" }}>
            <span style={{ width: 20, height: 20, borderRadius: 3, border: `1px solid ${s.done ? "rgba(29,185,84,.4)" : "rgba(245,166,35,.4)"}`, background: s.done ? "rgba(29,185,84,.15)" : "rgba(245,166,35,.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: s.done ? COLORS.green : COLORS.amber, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textDecoration: s.done ? "line-through" : "none", color: s.done ? COLORS.ghost : COLORS.chalk }}>{s.agent_name}</div>
              <div style={{ fontSize: 9, color: COLORS.ghost }}>{s.label}</div>
            </div>
            {s.done && <span style={{ fontSize: 9, color: COLORS.green }}>✓</span>}
          </div>
        ))
      ) : (
        dropStops.map((g, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: i < dropStops.length - 1 ? `1px solid ${COLORS.wire}` : "none" }}>
            <span style={{ width: 20, height: 20, borderRadius: 3, border: `1px solid ${g.done ? "rgba(29,185,84,.4)" : "rgba(232,58,58,.4)"}`, background: g.done ? "rgba(29,185,84,.15)" : "rgba(232,58,58,.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, color: g.done ? COLORS.green : COLORS.red, flexShrink: 0 }}>{i + 1}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, textDecoration: g.done ? "line-through" : "none", color: g.done ? COLORS.ghost : COLORS.chalk }}>
                {g.passengers.map(p => p.name).join(", ")}
              </div>
              <div style={{ fontSize: 9, color: COLORS.ghost }}>{g.label}</div>
            </div>
            {g.done && <span style={{ fontSize: 9, color: COLORS.green }}>✓</span>}
          </div>
        ))
      )}
    </Card>
  );
}

// Vector top-down car marker, rotated to heading — per explicit request,
// styled after the ride-hailing-app "car pin" look (Uber/Bolt-style live
// map marker): a tapered-nose car silhouette rather than a plain rounded
// rect, with a windshield band and a pair of headlight dots up front.
// Deliberately NOT shared with AdminLiveMap's own inline driver marker
// (same reasoning as this file's other AdminLiveMap-vs-GpsTrailModal
// duplication: touching AdminLiveMap's live, already-tested marker code
// carries more risk than the value of DRY-ing up a small shape) — this
// replay-only redesign intentionally diverges from it now.
function GpsTrailCarMarker({ x, y, heading, color }) {
  return (
    <g transform={`translate(${x},${y})`} style={{ filter: "drop-shadow(0 2px 3px rgba(0,0,0,.55))" }}>
      <g transform={heading != null ? `rotate(${heading})` : undefined} style={{ transition: "transform .15s linear" }}>
        <path d="M0,-12 C3.5,-12 6.2,-9.7 6.5,-6.2 L7,3 C7,7.2 4.8,9.6 0,10 C-4.8,9.6 -7,7.2 -7,3 L-6.5,-6.2 C-6.2,-9.7 -3.5,-12 0,-12 Z" fill={color} stroke={COLORS.panel} strokeWidth={1.3} />
        <path d="M-4.3,-6.3 C-4.3,-8.4 -2.4,-9.5 0,-9.5 C2.4,-9.5 4.3,-8.4 4.3,-6.3 L4,-1.8 L-4,-1.8 Z" fill={COLORS.panel} opacity={0.85} />
        <circle cx={-4.8} cy={-8.8} r={1} fill={COLORS.white} opacity={0.9} />
        <circle cx={4.8} cy={-8.8} r={1} fill={COLORS.white} opacity={0.9} />
      </g>
    </g>
  );
}

// Full-screen GPS trail map + playback — per explicit request ("all of
// it": both a static polyline overlay AND a scrubbable replay), opened
// from TripDetailRow once a trail has been fetched. Self-contained,
// hand-rolled SVG map matching AdminLiveMap's own approach (this
// codebase's established pattern — "a separate hand-rolled SVG map, not
// Leaflet" — rather than sharing one map implementation across very
// different use cases: a live, auto-refreshing fleet view vs. a static,
// scrubbable historical replay). Reuses the same low-level projection/
// tile primitives (projectToSvg, LiveMapTiles, lonLatToWorldPixel) so the
// two maps look and feel consistent, but keeps its own viewport/pan/zoom
// state rather than sharing AdminLiveMap's component-internal handlers.
function GpsTrailModal({ trail: rawTrail, tripId, direction, stops = [], pickupTimestamps, dropoffTimestamps, pickupCoords, onClose }) {
  const W = 900, H = 600;
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const pinchRef = useRef(null); // tracks 2-finger pinch state, same as AdminLiveMap

  // Crop the raw driver_position_log trail down to the pickup→last-dropoff
  // window — per explicit request ("gps trail should show from the pickup
  // to the last drop off"), via the shared cropTrailToPickupWindow
  // (TransitOS_web.jsx) — also used by computeActualRouteKm for the real
  // driven-distance calculation. Lenient mode here (the default): falls
  // back to showing more of the trail rather than less when the data
  // itself doesn't cooperate, since an admin looking at a map benefits
  // from seeing what's recorded even if the crop couldn't be fully
  // trusted — unlike computeActualRouteKm's strict mode, this is just a
  // display, not a figure driver pay depends on.
  // startTs/endTs are primitives (not the pickupTimestamps/dropoffTimestamps
  // object refs, which get rebuilt on every state refetch) so this memo
  // only recomputes when the actual confirm times change, not on every
  // unrelated poll — same reasoning as the trail-projection memo below.
  const pickupTsValues = Object.values(pickupTimestamps || {}).filter(v => typeof v === "number");
  const dropoffTsValues = Object.values(dropoffTimestamps || {}).filter(v => typeof v === "number");
  const startTs = pickupTsValues.length ? Math.min(...pickupTsValues) : null;
  const endTs = dropoffTsValues.length ? Math.max(...dropoffTsValues) : null;
  // tripId, not pickupCoords, gates this memo — FOUND VIA /code-review:
  // pickup_sequence_coords is rebuilt with a new array reference by
  // tripRowToApp on every state refetch/poll, same problem the
  // startTs/endTs-as-primitives trick already exists to avoid for
  // pickupTimestamps/dropoffTimestamps. A trip's pickup coordinates
  // never change once booked, and this modal is remounted fresh per
  // trip (tripId is constant for its whole lifetime), so tripId is a
  // stable, correct proxy — using the array reference directly would
  // have silently re-run the full crop (including the per-point haversine
  // spatial scan) on every background poll while the modal stayed open.
  const trail = React.useMemo(
    () => cropTrailToPickupWindow(rawTrail, pickupTimestamps, dropoffTimestamps, pickupCoords),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawTrail, startTs, endTs, tripId]
  );

  // Fit the viewport to the trail's own bounds on open — same
  // pick-a-zoom-that-fits approach as AdminLiveMap's fitAllDrivers, just
  // centered on this one trip's points instead of every currently-
  // reporting driver. Manual min/max loop, NOT Math.min(...lats) — FOUND
  // VIA /code-review: spreading a long trail (driver_position_log rows
  // persist for a 2-month retention window; a trip that never gets
  // marked complete keeps logging for days/weeks, easily tens of
  // thousands of rows) as call arguments risks "Maximum call stack size
  // exceeded" in V8 — the exact same fix already applied elsewhere in
  // this codebase for a dense TomTom polyline, for the identical reason.
  const initialViewport = React.useMemo(() => {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of trail) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    // Stop markers (drop-offs for OUTBOUND, pickups for INBOUND) also count
    // toward the fit — a stop a little off the recorded trail (GPS drift,
    // or the driver's last few points before stopping never got logged)
    // would otherwise land outside the initial view.
    for (const s of stops) {
      if (s.lat == null || s.lng == null) continue;
      if (s.lat < minLat) minLat = s.lat;
      if (s.lat > maxLat) maxLat = s.lat;
      if (s.lng < minLng) minLng = s.lng;
      if (s.lng > maxLng) maxLng = s.lng;
    }
    const centerLat = (minLat + maxLat) / 2, centerLng = (minLng + maxLng) / 2;
    let zoom = 16;
    for (; zoom > 3; zoom--) {
      const p1 = lonLatToWorldPixel(minLng, maxLat, zoom);
      const p2 = lonLatToWorldPixel(maxLng, minLat, zoom);
      const spanX = Math.abs(p2.x - p1.x), spanY = Math.abs(p2.y - p1.y);
      if (spanX < W * 0.75 && spanY < H * 0.75) break;
    }
    return { centerLat, centerLng, zoom };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [viewport, setViewport] = useState(initialViewport);
  const fitToTrail = () => setViewport(initialViewport);
  const zoomIn = () => setViewport(v => ({ ...v, zoom: Math.min(18, v.zoom + 1) }));
  const zoomOut = () => setViewport(v => ({ ...v, zoom: Math.max(3, v.zoom - 1) }));

  // Drag-to-pan + 2-finger pinch-to-zoom — same math as AdminLiveMap's
  // identical handlers, scoped to this component's own viewport state
  // rather than shared with it. FOUND VIA /code-review: an earlier
  // version of this component dropped pinch-zoom despite claiming "same
  // math ... identical handlers" — a real touch-UX gap versus the live
  // map for a feature meant to be reviewed in the field.
  const handlePointerDown = (e) => {
    if (e.touches && e.touches.length === 2) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      pinchRef.current = { startDist: dist, startZoom: viewport.zoom };
      dragRef.current = null;
      return;
    }
    pinchRef.current = null;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    dragRef.current = { startScreenX: clientX, startScreenY: clientY, startCenterLat: viewport.centerLat, startCenterLng: viewport.centerLng };
  };
  const handlePointerMove = (e) => {
    if (e.touches && e.touches.length === 2 && pinchRef.current) {
      const t0 = e.touches[0], t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const ratio = dist / pinchRef.current.startDist;
      const newZoom = Math.max(3, Math.min(18, pinchRef.current.startZoom + Math.log2(ratio)));
      setViewport(v => ({ ...v, zoom: newZoom }));
      return;
    }
    if (!dragRef.current) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scaleX = W / rect.width, scaleY = H / rect.height;
    const dxScreen = clientX - dragRef.current.startScreenX;
    const dyScreen = clientY - dragRef.current.startScreenY;
    const startCenterPx = lonLatToWorldPixel(dragRef.current.startCenterLng, dragRef.current.startCenterLat, viewport.zoom);
    const newCenterPx = { x: startCenterPx.x - dxScreen * scaleX, y: startCenterPx.y - dyScreen * scaleY };
    const newCenterLonLat = worldPixelToLonLat(newCenterPx.x, newCenterPx.y, viewport.zoom);
    setViewport(v => ({ ...v, centerLat: newCenterLonLat.lat, centerLng: newCenterLonLat.lon }));
  };
  const handlePointerUp = () => { dragRef.current = null; pinchRef.current = null; };

  // Wheel-zoom needs a native, non-passive listener — same reasoning as
  // AdminLiveMap's identical effect (React's onWheel is passive by
  // default since React 17, so e.preventDefault() inside it silently
  // fails to stop the page underneath from scrolling too).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const handleWheel = (e) => {
      e.preventDefault();
      setViewport(v => ({ ...v, zoom: Math.max(3, Math.min(18, v.zoom + (e.deltaY < 0 ? 0.5 : -0.5))) }));
    };
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, []);

  // Playback — fixed animation speed (one recorded point every 300ms at
  // 1x, per explicit request to slow the default down from an earlier
  // 150ms), NOT scaled to the real ~25s gap between samples: at real
  // elapsed time a full trip's replay would take as long as the trip
  // itself, which defeats the point of a scrubbable replay. Stops
  // automatically at the last point rather than looping, matching how a
  // video's "play" naturally ends rather than restarting on its own.
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  // Speed toggle (1x/2x) — per explicit request. Just halves the per-point
  // delay rather than skipping points, so 2x still visits every recorded
  // point, just twice as fast.
  const [speed, setSpeed] = useState(1);
  useEffect(() => {
    if (!playing) return;
    if (currentIndex >= trail.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setCurrentIndex(i => Math.min(i + 1, trail.length - 1)), 300 / speed);
    return () => clearTimeout(t);
  }, [playing, currentIndex, trail.length, speed]);
  // Rewind/forward — jump by ~5% of the trail per tap (minimum 1 point),
  // per explicit request for video-style transport controls alongside
  // play/pause and the scrub slider. Scales with trail length rather
  // than a fixed point count, since trails range from a handful of
  // points to several thousand.
  const skipAmount = Math.max(1, Math.round(trail.length * 0.05));
  const skipBack = () => { setPlaying(false); setCurrentIndex(i => Math.max(0, i - skipAmount)); };
  const skipForward = () => { setPlaying(false); setCurrentIndex(i => Math.min(trail.length - 1, i + skipAmount)); };

  const current = trail[currentIndex];
  // Memoized on [trail, viewport] — FOUND VIA /code-review (both this
  // session's manual pass and an independent /code-review run flagged
  // the same thing): re-projecting every trail point on every render
  // was real, measurable waste on two hot paths — every 150ms playback
  // tick, and every pointermove event while drag-panning — both firing
  // far more often than [trail, viewport] actually changes.
  const { polylinePoints, startPt, endPt, stopPts } = React.useMemo(() => {
    const pts = trail.map(p => projectToSvg(p.lat, p.lng, W, H, viewport));
    return {
      polylinePoints: pts.map(pt => `${pt.x},${pt.y}`).join(" "),
      startPt: pts[0] || null,
      endPt: pts.length > 0 ? pts[pts.length - 1] : null,
      // Drop-off stops for OUTBOUND, pickup stops for INBOUND — per
      // explicit request ("the outbound trip all the drop offs must be
      // included ... inbound trip all the pickups must be included").
      // Projected here alongside the trail itself so they pan/zoom in
      // lockstep and don't get recomputed on every playback tick.
      stopPts: stops.filter(s => s.lat != null && s.lng != null).map((s, i) => ({ ...projectToSvg(s.lat, s.lng, W, H, viewport), label: s.label, index: i })),
    };
  }, [trail, viewport, stops]);
  const currentPos = current ? projectToSvg(current.lat, current.lng, W, H, viewport) : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 300, background: COLORS.bg, display: "flex", flexDirection: "column", paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`, flexShrink: 0 }}>
        <div>
          <div style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 800 }}>GPS TRAIL — TRIP {tripId}</div>
          <div style={{ fontSize: 9, color: COLORS.ghost }}>
            {trail.length} points{stopPts.length > 0 ? ` · ${stopPts.length} ${direction === "OUTBOUND" ? "drop-off" : "pickup"}${stopPts.length === 1 ? "" : "s"}` : ""} · drag or pinch to pan/zoom, scroll or +/− also works
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button title="🎯" variant="ghost" size="sm" onClick={fitToTrail} style={{ width: 36 }} />
          <Button title="−" variant="ghost" size="sm" onClick={zoomOut} style={{ width: 36 }} />
          <Button title="+" variant="ghost" size="sm" onClick={zoomIn} style={{ width: 36 }} />
          <Button title="✕ CLOSE" variant="ghost" size="sm" onClick={onClose} />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <svg
          ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", touchAction: "none", cursor: "grab" }}
          onMouseDown={handlePointerDown} onMouseMove={handlePointerMove} onMouseUp={handlePointerUp} onMouseLeave={handlePointerUp}
          onTouchStart={handlePointerDown} onTouchMove={handlePointerMove} onTouchEnd={handlePointerUp}
        >
          <rect x={0} y={0} width={W} height={H} fill={COLORS.surface} />
          <LiveMapTiles width={W} height={H} viewport={viewport} />
          {/* Full trail — the "static overlay" half of the request, always
              visible regardless of playback position. */}
          <polyline points={polylinePoints} fill="none" stroke={COLORS.blue} strokeWidth={3} strokeOpacity={0.75} strokeLinecap="round" strokeLinejoin="round" />
          {/* Stop markers — drop-offs for OUTBOUND, pickups for INBOUND
              (per explicit request), numbered in sequence order. Distinct
              purple so they read separately from the green/red start/end
              trail endpoints, which mark the GPS log itself rather than a
              scheduled stop. */}
          {stopPts.map(pt => (
            <g key={pt.index}>
              <circle cx={pt.x} cy={pt.y} r={7} fill={COLORS.purple} stroke={COLORS.panel} strokeWidth={1.5} />
              <text x={pt.x} y={pt.y} textAnchor="middle" dominantBaseline="central" fontSize={8} fontWeight={800} fill={COLORS.white} style={{ pointerEvents: "none" }}>{pt.index + 1}</text>
              {pt.label && <title>{pt.label}</title>}
            </g>
          ))}
          {/* Start/end markers so the trail's direction is obvious even
              before pressing play. */}
          {startPt && <circle cx={startPt.x} cy={startPt.y} r={5} fill={COLORS.green} stroke={COLORS.panel} strokeWidth={1.5} />}
          {endPt && <circle cx={endPt.x} cy={endPt.y} r={5} fill={COLORS.red} stroke={COLORS.panel} strokeWidth={1.5} />}
          {/* Current scrub position — the "replay" half of the request. */}
          {currentPos && <GpsTrailCarMarker x={currentPos.x} y={currentPos.y} heading={current.heading} color={COLORS.amber} />}
        </svg>
      </div>
      <div style={{ padding: "10px 14px", background: COLORS.panel, borderTop: `1px solid ${COLORS.wire}`, flexShrink: 0, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button title="⏮" variant="ghost" size="sm" onClick={() => { setPlaying(false); setCurrentIndex(0); }} style={{ width: 36 }} disabled={trail.length <= 1} />
          <Button title="◀◀" variant="ghost" size="sm" onClick={skipBack} style={{ width: 40 }} disabled={trail.length <= 1} />
          <Button title={playing ? "⏸" : "▶"} variant="amber" size="sm" onClick={() => setPlaying(p => !p)} style={{ width: 44 }} disabled={trail.length <= 1} />
          <Button title="▶▶" variant="ghost" size="sm" onClick={skipForward} style={{ width: 40 }} disabled={trail.length <= 1} />
          <Button title="⏭" variant="ghost" size="sm" onClick={() => { setPlaying(false); setCurrentIndex(trail.length - 1); }} style={{ width: 36 }} disabled={trail.length <= 1} />
          <Button title={`${speed}x`} variant="ghost" size="sm" onClick={() => setSpeed(s => (s === 1 ? 2 : 1))} style={{ width: 36 }} disabled={trail.length <= 1} />
          <input
            type="range" min={0} max={Math.max(0, trail.length - 1)} value={currentIndex}
            onChange={e => { setPlaying(false); setCurrentIndex(Number(e.target.value)); }}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 9, color: COLORS.ghost, whiteSpace: "nowrap" }}>{currentIndex + 1} / {trail.length}</span>
        </div>
        <div style={{ display: "flex", gap: 14, fontSize: 10, color: COLORS.chalk }}>
          <span><span style={{ color: COLORS.ghost }}>TIME: </span>{fmtSastDateTime(current?.recorded_at) || "—"}</span>
          {current?.speed_kmh != null && <span><span style={{ color: COLORS.ghost }}>SPEED: </span>{Math.round(current.speed_kmh)} km/h</span>}
        </div>
      </div>
    </div>
  );
}

function AdminActiveTrips({ state }) {
  // Was an unmemoized O(drivers×trips) scan (activeDrivers' .filter, each
  // running its own .some over every trip) PLUS a second full re-filter of
  // every trip per active driver, all recomputed inline on every render —
  // flagged by a prior session's performance audit but left unfixed as
  // "cheap at current fleet size," then reconfirmed by a later resource-
  // usage audit as still-unfixed, quick-to-fix waste. Since this component
  // has no local state of its own, every one of these renders is driven
  // purely by `state` changing (i.e. every debounced refetch, fleet-wide,
  // for as long as this admin tab stays mounted) — memoizing keeps the
  // O(drivers×trips) work tied to the SAME state actually changing size
  // (driver_status/trips), not to unrelated parent re-renders.
  const { activeDrivers, driverTripsById } = React.useMemo(() => {
    // FOUND VIA DIRECT USER REPORT ("driver already started the trip but i
    // cant see active trips in admin"): this only ever matched IN_TRANSIT,
    // which a trip doesn't reach until EVERY passenger has been picked up
    // — a driver who tapped Start Trip and is actively navigating to their
    // FIRST pickup stays DRIVER_CONFIRMED the whole way there, and was
    // invisible here despite genuinely being "out on the road," which is
    // exactly what this tab's own description claims to show ("once a
    // driver has actually started driving"). There's no dedicated
    // trip-started flag/timestamp, but route_total_km is a reliable
    // existing stand-in: it's null until TRIP/RECORD_ROUTE runs, and
    // that's the ONE thing Start Trip actually does server-side (see
    // handleStartTrip) — a DRIVER_CONFIRMED trip with a real
    // route_total_km has definitely been started, not merely accepted.
    const inTransitTrips = state.trips.filter(t =>
      t.state === TRIP_STATE.IN_TRANSIT || (t.state === TRIP_STATE.DRIVER_CONFIRMED && t.route_total_km != null)
    );
    const byId = new Map();
    for (const t of inTransitTrips) {
      const key = String(t.driver_id);
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(t);
    }
    return {
      activeDrivers: state.driver_status.filter(ds => byId.has(String(ds.driver_id))),
      driverTripsById: byId,
    };
  }, [state.driver_status, state.trips]);
  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>ACTIVE TRIPS</div>
      <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2, marginBottom: 12 }}>
        Live pickup/drop-off order exactly as it appears on each driver's own navigation
        screen — this can differ from the planned dispatch order once a driver has
        actually started driving.
      </div>
      {activeDrivers.length === 0 ? (
        <Empty icon="🚦" text="No drivers currently on a live route" />
      ) : activeDrivers.map(ds => (
        <ActiveDriverCard key={ds.driver_id} ds={ds} driverTrips={driverTripsById.get(String(ds.driver_id)) || []} state={state} />
      ))}
    </div>
  );
}

function DriverStatsCard({ driverId, allTrips }) {
  const stats = computeDriverStats(driverId, allTrips);
  if (stats.total === 0) return (
    <div style={{ fontSize: 9, color: COLORS.ghost, padding: "4px 0" }}>No trip history yet.</div>
  );
  const rate = stats.completionRate;
  const rateColor = rate == null ? COLORS.ghost : rate >= 0.9 ? COLORS.green : rate >= 0.7 ? COLORS.amber : COLORS.red;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
      {[
        ["COMPLETION", rate != null ? `${Math.round(rate * 100)}%` : "—", rateColor],
        ["TRIPS", stats.completed, COLORS.chalk],
        ["REJECTIONS", stats.rejections, stats.rejections > 0 ? COLORS.red : COLORS.ghost],
        ["NO-SHOW TRIPS", stats.noShowTrips, stats.noShowTrips > 0 ? COLORS.amber : COLORS.ghost],
        ["AVG PAX", stats.avgPassengers != null ? stats.avgPassengers.toFixed(1) : "—", COLORS.ghost],
      ].map(([label, val, color]) => (
        <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 3, padding: "4px 10px", minWidth: 70 }}>
          <div style={{ fontSize: 8, color: COLORS.ghost, letterSpacing: 0.8 }}>{label}</div>
          <div style={{ fontSize: 14, fontWeight: 800, color, fontFamily: FONTS.head }}>{val}</div>
        </div>
      ))}
    </div>
  );
}

function DriverSafetyModal({ driverId, driverName, onClose }) {
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [scorecard, setScorecard] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const toMs = Date.now();
    const fromMs = toMs - windowDays * 24 * 60 * 60 * 1000;
    fetchDriverSafetyHistory({ driverId, fromMs, toMs })
      .then(({ trips, notifications }) => { if (!cancelled) setScorecard(computeDriverSafetyScorecard(trips, notifications)); })
      .catch(() => { if (!cancelled) setScorecard(computeDriverSafetyScorecard([], [])); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [driverId, windowDays]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "flex-end", justifyContent: "center" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ width: "100%", maxWidth: 480, background: COLORS.panel, borderTopLeftRadius: 12, borderTopRightRadius: 12, border: `1px solid ${COLORS.wire}`, borderBottom: "none", padding: 20, display: "flex", flexDirection: "column", gap: 12, maxHeight: "85vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: COLORS.amber, letterSpacing: 1 }}>🛡 SAFETY SCORECARD — {driverName}</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.ghost, fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Button title="30 DAYS" variant={windowDays === 30 ? "amber" : "ghost"} size="sm" onClick={() => setWindowDays(30)} />
          <Button title="90 DAYS" variant={windowDays === 90 ? "amber" : "ghost"} size="sm" onClick={() => setWindowDays(90)} />
        </div>
        {loading ? (
          <div style={{ fontSize: 10, color: COLORS.ghost }}>Loading…</div>
        ) : scorecard.tripsInWindow === 0 ? (
          <div style={{ fontSize: 10, color: COLORS.ghost }}>No completed trips in this window.</div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {[
              ["TRIPS", scorecard.tripsInWindow, COLORS.chalk],
              ["SPEEDING ALERTS", scorecard.speedingAlerts, scorecard.speedingAlerts > 0 ? COLORS.red : COLORS.ghost],
              ["ROUTE DEVIATIONS", scorecard.routeDeviations, scorecard.routeDeviations > 0 ? COLORS.amber : COLORS.ghost],
              ["NO-SHOWS", scorecard.noShows, scorecard.noShows > 0 ? COLORS.amber : COLORS.ghost],
              ["AVG RATING", scorecard.avgRating != null ? `${scorecard.avgRating.toFixed(1)}★ (${scorecard.ratingCount})` : "—", COLORS.ghost],
            ].map(([label, val, color]) => (
              <div key={label} style={{ background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 3, padding: "4px 10px", minWidth: 90 }}>
                <div style={{ fontSize: 8, color: COLORS.ghost, letterSpacing: 0.8 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 800, color, fontFamily: FONTS.head }}>{val}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AdminDrivers({ state, user, dispatch }) {
  // Which trip cards are expanded, per driver. Collapsed by default —
  // a driver with several active trips otherwise dumps a wall of detail
  // (pickup, dropoffs, Waze buttons) for every single one at once. Keyed
  // by trip_id so expansion state persists correctly even as the trips
  // list itself re-sorts/refreshes underneath.
  const [expandedTripIds, setExpandedTripIds] = useState(new Set());
  const toggleTripExpanded = (tripId) => {
    setExpandedTripIds(prev => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId); else next.add(tripId);
      return next;
    });
  };
  // Same "full" question the Dashboard asks — whether a driver is at
  // capacity RIGHT NOW (today), not across every date they happen to
  // have any assignment on (a driver booked solid on 4 different future
  // days of one agent's week isn't "full" today).
  const todayStr = sastTodaySlashStr();
  // Viewer sees driver name + vehicle registration only — no phone, no
  // home address, no live status, no active-route detail. Full tier
  // (Fleet Ops / Standard) still sees everything, same as before.
  const fullView = hasAdminPermission(user, "viewDriverProfiles");
  const [shiftEditorFor, setShiftEditorFor] = React.useState(null);
  const [docEditorFor, setDocEditorFor] = React.useState(null);
  const [safetyModalFor, setSafetyModalFor] = React.useState(null);
  // Per-driver card collapse — each card's detail (docs/hours/stats
  // summaries, action buttons, full active-route list) previously always
  // rendered in full for every driver at once, a real wall of content on
  // a fleet with more than a few drivers. Starts expanded to match
  // existing behavior exactly, toggled by tapping the driver's own
  // header row — same pattern already used in AdminTrips/DriverTripsTab.
  const [collapsedDrivers, setCollapsedDrivers] = React.useState(new Set());
  const toggleDriverCollapsed = (driverId) => {
    setCollapsedDrivers(prev => {
      const next = new Set(prev);
      if (next.has(driverId)) next.delete(driverId); else next.add(driverId);
      return next;
    });
  };

  if (!fullView) {
    return (
      <div className="pad">
        <SectionHeader label={`Drivers (${state.driver_status.length})`} />
        {state.driver_status.length === 0 ? <Empty icon="◉" text="No drivers registered" /> : state.driver_status.map(ds => {
          const driverUser = state.users.find(u => String(u.id) === String(ds.driver_id));
          return (
            <Card key={ds.driver_id}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <DriverAvatar name={driverUser?.name} size={40} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 800 }}>{driverUser?.name}</span>
                    <span style={{ width: 7, height: 7, borderRadius: 4, background: !ds.is_online ? COLORS.ghost : ds.is_away ? COLORS.amber : COLORS.green, flexShrink: 0 }} title={!ds.is_online ? "Offline" : ds.is_away ? "Away" : "Online"} />
                  </div>
                  <div style={{ fontSize: 10, color: COLORS.mist, marginTop: 2 }}>{ds.vehicle}</div>
                  {/* Online now means "actively in the app," away means "logged in
                      but app backgrounded" — live position elsewhere is unaffected
                      by either, only this presence label. */}
                  <div style={{ fontSize: 9, color: !ds.is_online ? COLORS.ghost : ds.is_away ? COLORS.amber : COLORS.green, marginTop: 2, fontWeight: 700, letterSpacing: .5 }}>{!ds.is_online ? "○ OFFLINE" : ds.is_away ? "◐ AWAY" : "● ONLINE"}</div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    );
  }

  return (
    <div className="pad">
      <SectionHeader label={`Drivers (${state.driver_status.length})`} />
      {state.driver_status.length === 0 ? <Empty icon="◉" text="No drivers registered" /> : state.driver_status.map(ds => {
        const driverUser = state.users.find(u => String(u.id) === String(ds.driver_id));
        const load = getDriverLoad(state, ds.driver_id, todayStr);
        const driverCapacityList = ds.capacity || DRIVER_CAPACITY;
        const full = load >= driverCapacityList;
        const activeTrips = state.trips.filter(t => String(t.driver_id) === String(ds.driver_id) && ![TRIP_STATE.ARCHIVED_COMPLETED, TRIP_STATE.ARCHIVED_CANCELLED].includes(t.state)).sort((a, b) => (a.pickup_order_num || 99) - (b.pickup_order_num || 99));
        const isDriverCollapsed = collapsedDrivers.has(ds.driver_id);
        return (
          <Card key={ds.driver_id}>
            <div
              onClick={() => toggleDriverCollapsed(ds.driver_id)}
              style={{ display: "flex", gap: 12, alignItems: "flex-start", cursor: "pointer" }}
            >
              <DriverAvatar name={driverUser?.name} size={46} />
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 10, color: COLORS.ghost, flexShrink: 0 }}>{isDriverCollapsed ? "▸" : "▾"}</span>
                  <span style={{ fontFamily: FONTS.head, fontSize: 16, fontWeight: 800 }}>{driverUser?.name}</span>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: !ds.is_online ? COLORS.ghost : ds.is_away ? COLORS.amber : COLORS.green, flexShrink: 0 }} title={!ds.is_online ? "Offline" : ds.is_away ? "Away" : "Online"} />
                  <span style={{ fontSize: 9, color: !ds.is_online ? COLORS.ghost : ds.is_away ? COLORS.amber : COLORS.green, fontWeight: 700, letterSpacing: .5 }}>{!ds.is_online ? "OFFLINE" : ds.is_away ? "AWAY" : "ONLINE"}</span>
                </div>
                <div style={{ fontSize: 10, color: COLORS.mist, marginTop: 2 }}>{ds.vehicle}</div>
                {!isDriverCollapsed && (
                  <>
                <div style={{ fontSize: 10, color: COLORS.ghost }}>{ds.phone}</div>
                {driverUser?.home_address && (
                  <div style={{ fontSize: 10, color: COLORS.teal, marginTop: 2 }}>🏠 Lives in {driverUser.home_address.area || driverUser.home_address.label}</div>
                )}
                <div onClick={e => e.stopPropagation()} style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <Button title={ds.availability_schedule?.length > 0 ? `⏱ SHIFTS (${ds.availability_schedule.length} blocks)` : "⏱ SET SHIFTS"} variant="ghost" size="sm"
                    onClick={() => setShiftEditorFor(ds.driver_id)} />
                  <Button title="🖨 WAYBILL" variant="ghost" size="sm"
                    onClick={() => printWaybill(driverUser, ds, state.trips, state.users, todayStr)} />
                  <Button title="📄 DOCS" variant="ghost" size="sm"
                    onClick={() => setDocEditorFor(ds.driver_id)} />
                  <Button title="🛡 SAFETY" variant="ghost" size="sm"
                    onClick={() => setSafetyModalFor(ds.driver_id)} />
                </div>
                <DriverDocSummary ds={ds} />
                <DriverHoursSummary driverId={ds.driver_id} trips={state.trips} />
                <div style={{ fontSize: 7, color: COLORS.ghost, marginTop: 1, fontStyle: "italic" }}>estimated from trip activity, not clock-in/out</div>
                {docEditorFor === ds.driver_id && (
                  <div onClick={e => e.stopPropagation()}><DriverDocEditor ds={ds} dispatch={dispatch} onClose={() => setDocEditorFor(null)} /></div>
                )}
                {safetyModalFor === ds.driver_id && (
                  <div onClick={e => e.stopPropagation()}><DriverSafetyModal driverId={ds.driver_id} driverName={driverUser?.name || "Driver"} onClose={() => setSafetyModalFor(null)} /></div>
                )}
                <DriverStatsCard driverId={ds.driver_id} allTrips={state.trips} />
                {(() => { const r = driverAvgRating(ds.driver_id, state.trips); return r ? (
                  <div style={{ fontSize: 10, color: COLORS.amber, marginTop: 4 }}>
                    {"⭐".repeat(Math.round(r.avg))} {r.avg.toFixed(1)} avg ({r.count} rating{r.count !== 1 ? "s" : ""})
                  </div>
                ) : null; })()}
                {shiftEditorFor === ds.driver_id && (
                  <div onClick={e => e.stopPropagation()}><DriverShiftEditor ds={ds} dispatch={dispatch} onClose={() => setShiftEditorFor(null)} /></div>
                )}
                  </>
                )}
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                {/* Bug found via direct user report: this used to render
                    BOTH a green "AVAILABLE" badge (from ds.state, which is
                    auto-computed purely from whether the driver has an
                    active trip) AND a separate red "UNAVAILABLE" tag (from
                    ds.is_unavailable, a driver's own manual "don't assign
                    me" toggle) at the same time — the two flags are
                    independent, so a driver with zero active trips who'd
                    also manually gone unavailable showed as both available
                    and unavailable simultaneously. is_unavailable is the
                    more specific, deliberately-set reason a driver can't
                    be assigned, so it now takes priority in the single
                    badge shown, ahead of the auto-computed AVAILABLE/BUSY
                    state (FULLY_BOOKED still wins over everything — a
                    driver at capacity can't take more work either way). */}
                <StateBadge state={full ? "FULLY_BOOKED" : ds.is_unavailable ? "UNAVAILABLE" : ds.state} />
              </div>
            </div>
            <CapacityBar load={load} capacity={driverCapacityList} />
            {!isDriverCollapsed && (activeTrips.length > 0 ? (
              <>
                <SectionHeader label="Active Route" />
                {activeTrips.map(trip => {
                  const pickupCoord = trip.pickup_sequence_coords?.[0];
                  const isExpanded = expandedTripIds.has(trip.trip_id);
                  return (
                    <div key={trip.trip_id} style={{ paddingTop: 10, borderTop: `1px solid ${COLORS.wire}` }}>
                      <div
                        onClick={() => toggleTripExpanded(trip.trip_id)}
                        style={{ display: "flex", gap: 12, alignItems: "center", cursor: "pointer" }}
                      >
                        <div style={{ width: 26, height: 26, borderRadius: 4, border: "1px solid rgba(29,185,84,.3)", background: "rgba(29,185,84,.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                          <span style={{ fontSize: 11, color: COLORS.green, fontWeight: 800 }}>{trip.pickup_order_num}</span>
                        </div>
                        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontSize: 11, fontWeight: 700 }}>{trip.trip_id} · {trip.agent_ids?.length || 1} passenger{(trip.agent_ids?.length || 1) !== 1 ? "s" : ""}</span>
                          <StateBadge state={trip.state} />
                        </div>
                        <span style={{ fontSize: 12, color: COLORS.ghost, flexShrink: 0 }}>{isExpanded ? "▲" : "▼"}</span>
                      </div>
                      {isExpanded && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8, paddingLeft: 38 }}>
                          <span style={{ fontSize: 10 }}><span style={{ color: COLORS.green }}>◉ </span>{trip.custom_pickup}</span>
                          {/* Per-agent dropoffs with TomTom road-optimal ordering */}
                          <AdminTripDropoffs trip={trip} state={state} />
                          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                            {pickupCoord && <Button title="🧭 PICKUP" variant="waze" size="sm" onClick={(e) => { e.stopPropagation(); smartOpenWaze(pickupCoord.lat, pickupCoord.lng, trip.custom_pickup, trip.pickup_is_manual); }} />}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ) : <span style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", padding: 8 }}>No active trips — driver available</span>)}
          </Card>
        );
      })}
    </div>
  );
}

function UserProfilePanel({ u, driverStatus, state }) {
  const branch = u.branch_id ? companyById(state, u.branch_id) : null;
  const campaign = u.campaign_id ? (state.campaigns || []).find(c => String(c.id) === String(u.campaign_id)) : null;
  const myTrips = state.trips.filter(t => t.agent_ids?.some(id => String(id) === String(u.id)) || String(t.driver_id) === String(u.id));
  const activeTrips = myTrips.filter(t => ![TRIP_STATE.ARCHIVED_COMPLETED, TRIP_STATE.ARCHIVED_CANCELLED].includes(t.state));
  const completedTrips = myTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED);
  const cancelledTrips = myTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_CANCELLED);

  const Row = ({ label, children }) => (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: `1px solid ${COLORS.wire}` }}>
      <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>{label}</span>
      <span style={{ fontSize: 10, color: COLORS.chalk, textAlign: "right" }}>{children}</span>
    </div>
  );

  return (
    <Card>
      <SectionHeader label="Profile" />
      <Row label="FULL NAME">{u.name}</Row>
      <Row label="ROLE"><RoleBadge role={u.role} /></Row>
      <Row label="STAFF NUMBER">{u.staff_number || "—"}</Row>
      <Row label="USERNAME (LOGIN)">{u.auth?.login || "—"}</Row>

      {(u.role === ROLE.AGENT || u.role === ROLE.DRIVER) && (
        <>
          <Row label="HOME ADDRESS">{u.home_address?.label || "Not on file"}</Row>
          <Row label="HOME AREA">{u.home_address?.area || "—"}</Row>
        </>
      )}

      {u.role === ROLE.AGENT && (
        <>
          <Row label="COMPANY">{branch?.label || u.branch_id || "—"}</Row>
          <Row label="CAMPAIGN / PROJECT">{campaign?.name || (u.campaign_id ? `#${u.campaign_id} (deleted?)` : "None assigned")}</Row>
        </>
      )}

      {u.role === ROLE.DRIVER && (
        <>
          <Row label="COMPANY">{branch?.label || u.branch_id || "—"}</Row>
          <Row label="VEHICLE">{driverStatus?.vehicle || "—"}</Row>
          <Row label="CONTACT PHONE">{driverStatus?.phone || "—"}</Row>
          {/* Same fix as AdminDrivers' list-row badge — a driver's manual
              is_unavailable toggle must take priority over the
              auto-computed AVAILABLE/BUSY state, or this shows "AVAILABLE"
              for a driver who deliberately opted out of new assignments. */}
          <Row label="CURRENT STATE"><StateBadge state={driverStatus?.is_unavailable ? "UNAVAILABLE" : (driverStatus?.state || DRIVER_STATE.AVAILABLE)} /></Row>
        </>
      )}

      {u.role === ROLE.ADMIN && (
        <>
          <Row label="ADMIN LEVEL">{ADMIN_LEVEL_LABEL[u.admin_level] || "—"}</Row>
          <Row label="COMPANIES">
            {(u.scoped_company_ids || []).length === 0
              ? "None assigned"
              : u.scoped_company_ids.map(id => companyById(state, id)?.label || id).join(", ")}
          </Row>
        </>
      )}

      {(u.role === ROLE.AGENT || u.role === ROLE.DRIVER) && (
        <>
          <Row label="ACTIVE TRIPS (LIVE WINDOW)">{activeTrips.length}</Row>
          <Row label="COMPLETED TRIPS (LIVE WINDOW)">{completedTrips.length}</Row>
          <Row label="CANCELLED TRIPS (LIVE WINDOW)">{cancelledTrips.length}</Row>
        </>
      )}

      {u.role === ROLE.AGENT && (u.branch_history || []).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <SectionHeader label="Company History" />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {u.branch_history.map((h, i) => {
              const oldBranch = companyById(state, h.branch_id);
              return (
                <div key={i} style={{ fontSize: 9, color: COLORS.ghost, background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 3, padding: 8 }}>
                  <div style={{ color: COLORS.chalk, fontWeight: 700 }}>{oldBranch?.label || h.branch_id}</div>
                  <div style={{ marginTop: 2 }}>{h.reason}</div>
                  <div style={{ marginTop: 2, color: COLORS.dim }}>{h.changed_at}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

function EditUserPanel({ user, driverStatus, dispatch, state, onClose }) {
  const [form, setForm] = useState({
    name: user.name, staffNumber: user.staff_number || "", phone: user.phone || "",
    vehicle: driverStatus?.vehicle || "",
    capacity: driverStatus?.capacity || DRIVER_CAPACITY,
    homeStreet: user.home_address?.label || "", homeArea: user.home_address?.area || "",
    homeCoord: user.home_address ? { lat: user.home_address.lat, lng: user.home_address.lng } : null,
    branchId: user.branch_id || null,
    campaignId: user.campaign_id || null,
    adminLevel: user.admin_level || ADMIN_LEVEL.VIEWER,
    scopedCompanyIds: user.scoped_company_ids || [],
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Live preview of the >40 km branch-reassignment rule, computed from
  // whatever address is currently in the form (not necessarily saved yet),
  // so the admin sees the warning before committing the change.
  const branchDistanceKm = (() => {
    if (!form.homeCoord) return null;
    const branch = companyById(state, form.branchId);
    if (!branch || branch.lat == null) return null;
    return haversineKm(form.homeCoord.lat, form.homeCoord.lng, branch.lat, branch.lng) * ROAD_FACTOR;
  })();
  const willFlagFarReassignment = form.branchId !== user.branch_id && branchDistanceKm != null && branchDistanceKm > 40;

  const [saveError, setSaveError] = useState(null);
  const save = async () => {
    if (!form.name) return;
    // See AdminUsers' create-form submit() for the full rationale — a
    // Viewer admin with zero companies checked fails CLOSED (sees
    // nothing), so editing an existing Viewer down to zero companies
    // silently locks them out with no error anywhere explaining why.
    if (user.role === ROLE.ADMIN && form.adminLevel === ADMIN_LEVEL.VIEWER && form.scopedCompanyIds.length === 0) {
      setSaveError("Select at least one company for a Viewer admin — without one, they won't be able to see any data.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await dispatch({
        type: "ADMIN/UPDATE_USER", user_id: user.id,
        name: form.name,
        login: form.name, // username is always kept in sync with full name
        staff_number: form.staffNumber || undefined,
        // Password mirrors the staff number (the app's credential model),
        // but only re-synced when the staff number ACTUALLY changed —
        // previously this was sent on every save, so any unrelated edit
        // (name fix, address confirmation, branch move) silently reset
        // the password back to the staff number, clobbering a password
        // someone had set directly in the database. Undefined = keep
        // existing in both backends.
        pass: (form.staffNumber && form.staffNumber !== (user.staff_number || "")) ? form.staffNumber : undefined,
        vehicle: user.role === ROLE.DRIVER ? form.vehicle : undefined,
        phone: form.phone,
        capacity: user.role === ROLE.DRIVER ? form.capacity : undefined,
        // Only sent when the admin actually confirmed a new address via
        // the search — undefined means "leave unchanged" in both backends.
        // Previously this sent null whenever homeCoord was null, so
        // saving ANY edit (even just a name fix) while the address field
        // was empty or typed-but-unconfirmed silently WIPED the person's
        // home address — including label-only bulk-imported addresses
        // that were sitting in the DB awaiting confirmation.
        home_address: ((user.role === ROLE.AGENT || user.role === ROLE.DRIVER) && form.homeCoord)
          ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng }
          : undefined,
        branch_id: (user.role === ROLE.AGENT || user.role === ROLE.DRIVER) ? form.branchId : undefined,
        campaign_id: user.role === ROLE.AGENT ? form.campaignId : undefined,
        admin_level: user.role === ROLE.ADMIN ? form.adminLevel : undefined,
        scoped_company_ids: user.role === ROLE.ADMIN ? form.scopedCompanyIds : undefined,
      });
      onClose();
    } catch (e) {
      setSaveError(e.message || "Couldn't save changes — please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ borderColor: COLORS.amber2, background: "rgba(245,166,35,.03)" }}>
      <SectionHeader label={`Edit — ${user.role}`} />
      <TextField label="Full Name" value={form.name} onChange={e => set("name", e.target.value)} />
      <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Username is always the full name — currently "{form.name || user.name}"</span>
      <TextField label="Staff Number (also used as password)" value={form.staffNumber} onChange={e => set("staffNumber", e.target.value)} placeholder="e.g. AG1004" />
      <TextField label="Cellphone Number" value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="07x xxx xxxx" />
      {user.role === ROLE.AGENT && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <SectionHeader label="Home Address (Cape Town)" />
            <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
              preConfirmed={form.homeCoord ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null}
              onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: confirmed ? coord : null }))} />
          </div>

          <SectionHeader label="Company" />
          {(state?.companies || []).length === 0 ? (
            <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet — add one from Manage Companies before assigning agents.</span>
          ) : (
            <select className="inp" value={form.branchId || ""} onChange={e => set("branchId", e.target.value || null)} style={{ width: "100%" }}>
              <option value="">— None —</option>
              {state.companies
                // Active companies, plus whichever one this agent is
                // CURRENTLY on even if it's since been deactivated — an
                // admin editing this agent shouldn't see their existing
                // assignment silently vanish from the list.
                .filter(c => c.active || String(c.id) === String(user.branch_id))
                .map(c => <option key={c.id} value={c.id}>{c.name}{!c.active ? " (inactive)" : ""}</option>)}
            </select>
          )}
          {branchDistanceKm != null && (
            <span style={{ fontSize: 9, color: willFlagFarReassignment ? COLORS.red : COLORS.ghost }}>
              {branchDistanceKm.toFixed(1)} km from home address
              {willFlagFarReassignment ? " — exceeds 40 km, previous company will be kept on file" : ""}
            </span>
          )}

          <SectionHeader label="Campaign / Project" />
          {(state?.campaigns || []).length === 0 ? (
            <span style={{ fontSize: 9, color: COLORS.ghost }}>No campaigns have been added yet.</span>
          ) : (
            <select className="inp" value={form.campaignId || ""} onChange={e => set("campaignId", e.target.value || null)} style={{ width: "100%" }}>
              <option value="">— None —</option>
              {state.campaigns.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          )}
          {(user.branch_history || []).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, background: COLORS.surface, borderRadius: 4, padding: 10, border: `1px solid ${COLORS.wire}` }}>
              <span style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase", letterSpacing: 1 }}>Company History</span>
              {user.branch_history.map((h, i) => {
                const b = companyById(state, h.branch_id);
                return <span key={i} style={{ fontSize: 9, color: COLORS.chalk }}>• {b?.label || h.branch_id} — {h.changed_at}</span>;
              })}
            </div>
          )}
        </>
      )}
      {user.role === ROLE.DRIVER && (
        <>
          <TextField label="Vehicle" value={form.vehicle} onChange={e => set("vehicle", e.target.value)} placeholder="Toyota Hiace - CA 000-000" />
          <TextField label="Vehicle Capacity (seats)" type="number" min="1" value={form.capacity} onChange={e => set("capacity", e.target.value === "" ? "" : parseInt(e.target.value, 10) || 1)} placeholder="4" />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <SectionHeader label="Home Area (Cape Town)" />
            <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Used by admins to see which area this driver lives in when assigning trips.</span>
            <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
              preConfirmed={form.homeCoord ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null}
              onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: confirmed ? coord : null }))} />
          </div>
          <SectionHeader label="Company" />
          {(state?.companies || []).length === 0 ? (
            <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet — add one from Manage Companies before assigning drivers.</span>
          ) : (
            <select className="inp" value={form.branchId || ""} onChange={e => set("branchId", e.target.value || null)} style={{ width: "100%" }}>
              <option value="">— None —</option>
              {state.companies
                .filter(c => c.active || String(c.id) === String(user.branch_id))
                .map(c => <option key={c.id} value={c.id}>{c.name}{!c.active ? " (inactive)" : ""}</option>)}
            </select>
          )}
        </>
      )}
      {user.role === ROLE.ADMIN && (
        <>
          <SectionHeader label="Admin Level" />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Object.values(ADMIN_LEVEL).map(lvl => (
              <Button key={lvl} title={ADMIN_LEVEL_LABEL[lvl]} size="sm" variant={form.adminLevel === lvl ? "amber" : "ghost"} onClick={() => set("adminLevel", lvl)} full />
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <SectionHeader label="Companies (optional)" />
            <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>
              {form.adminLevel === ADMIN_LEVEL.VIEWER
                ? "If any are checked, this Viewer only sees agents, drivers on their trips, trips, tickets, and alerts belonging to the selected companies. Leave all unchecked for unrestricted (all-company) Viewer access."
                : "A label for which companies this admin manages — Fleet Ops and Standard admins always see every company's data regardless of what's checked here; this doesn't restrict anything for them."}
            </span>
            {(state?.companies || []).length === 0 ? (
              <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet.</span>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {state.companies
                  .filter(c => c.active || (user.scoped_company_ids || []).includes(c.id))
                  .map(c => {
                    const checked = form.scopedCompanyIds.includes(c.id);
                    return (
                      <div key={c.id} onClick={() => set("scopedCompanyIds", checked ? form.scopedCompanyIds.filter(id => id !== c.id) : [...form.scopedCompanyIds, c.id])}
                        style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                        <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${checked ? COLORS.amber : COLORS.wire}`, background: checked ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{checked && "✓"}</span>
                        <span style={{ fontSize: 11, color: COLORS.chalk }}>{c.name}{!c.active ? " (inactive)" : ""}</span>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        </>
      )}
      {saveError && <span style={{ fontSize: 10, color: COLORS.red }}>{saveError}</span>}
      <div style={{ display: "flex", gap: 8 }}>
        <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
        <Button title={saving ? "SAVING…" : "SAVE CHANGES"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={saving} loading={saving} />
      </div>
    </Card>
  );
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip, \n handles the line break */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => cell.trim() !== ""));
}

function usersToCsv(users, driverStatusList) {
  const headers = [
    "Full Name", "Role", "Staff Number", "Login (username)", "Password (hint)",
    "Admin Level", "Home Address", "Home Area", "Home Lat", "Home Lng", "Company",
    "Vehicle", "Phone",
  ];
  const rows = users.map(u => {
    const ds = u.role === ROLE.DRIVER ? driverStatusList.find(d => String(d.driver_id) === String(u.id)) : null;
    return [
      // Login comes from the account's real auth field, not the name —
      // the name only matches the DEFAULT at creation time; an account
      // whose username an admin later changed would otherwise export
      // the wrong login. The password column is a static onboarding
      // hint now that passwords are salted-hashed — the actual value is
      // deliberately unrecoverable from any export.
      u.name, u.role, u.staff_number || "", u.auth?.login ?? u.name, "(staff number, unless changed)",
      u.admin_level || "", u.home_address?.label || "", u.home_address?.area || "",
      u.home_address?.lat ?? "", u.home_address?.lng ?? "", u.branch_id || "",
      ds?.vehicle || "", ds?.phone || "",
    ];
  });
  const csv = [headers, ...rows].map(r => r.map(csvEscapeCell).join(",")).join("\r\n");
  return "\uFEFF" + csv;
}

function downloadCsv(csvContent, filename) {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseUsersCsv(text, companies = []) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { records: [], errors: ["File appears to be empty or has no data rows."] };
  const headerRow = rows[0].map(h => h.trim().toLowerCase());
  const col = (name) => headerRow.indexOf(name.toLowerCase());
  const idxName = col("full name"), idxRole = col("role"), idxStaff = col("staff number");
  const idxAddr = col("home address"), idxArea = col("home area"), idxBranch = col("company") !== -1 ? col("company") : col("branch");
  const idxVehicle = col("vehicle"), idxPhone = col("phone");

  const errors = [];
  if (idxName === -1) errors.push('Missing required column "Full Name".');
  if (idxRole === -1) errors.push('Missing required column "Role".');
  if (idxStaff === -1) errors.push('Missing required column "Staff Number".');
  if (errors.length) return { records: [], errors };

  const records = [];
  rows.slice(1).forEach((r, i) => {
    const rowNum = i + 2; // +2: 1-indexed, plus the header row itself
    const name = (r[idxName] || "").trim();
    const role = (r[idxRole] || "").trim().toUpperCase();
    const staffNumber = (r[idxStaff] || "").trim();
    if (!name || !role || !staffNumber) {
      errors.push(`Row ${rowNum}: missing Full Name, Role, or Staff Number — skipped.`);
      return;
    }
    if (![ROLE.AGENT, ROLE.DRIVER].includes(role)) {
      errors.push(`Row ${rowNum}: Role "${role}" must be AGENT or DRIVER — skipped. (Admin accounts can't be bulk-created for security reasons — create those individually.)`);
      return;
    }
    // Branch (company) accepts the internal id, the company name, or
    // either address's area — case/spacing insensitive — since a real
    // spreadsheet will contain whatever the admin naturally typed, not
    // an internal id. Unrecognized values error the row rather than
    // silently creating an agent tied to a company that doesn't exist
    // (who then can't book at all, with no hint why).
    const rawBranch = idxBranch !== -1 ? (r[idxBranch] || "").trim() : "";
    let branchId = "";
    if (rawBranch) {
      const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, "");
      const match = companies.find(c =>
        norm(c.id) === norm(rawBranch) || norm(c.name) === norm(rawBranch) ||
        norm(c.address?.area) === norm(rawBranch)
      );
      if (!match && (role === ROLE.AGENT || role === ROLE.DRIVER)) {
        errors.push(`Row ${rowNum}: Company "${rawBranch}" not recognized — use ${companies.length ? companies.map(c => `"${c.name}"`).join(" or ") : "a company added under Manage Companies"}. Row skipped.`);
        return;
      }
      branchId = match?.id || "";
    }
    records.push({
      rowNum, name, role, staffNumber,
      homeAddress: idxAddr !== -1 ? (r[idxAddr] || "").trim() : "",
      homeArea: idxArea !== -1 ? (r[idxArea] || "").trim() : "",
      branchId,
      vehicle: idxVehicle !== -1 ? (r[idxVehicle] || "").trim() : "",
      phone: idxPhone !== -1 ? (r[idxPhone] || "").trim() : "",
    });
  });
  return { records, errors };
}

function BulkUserImportPanel({ state, dispatch, onClose, onDone }) {
  const [fileName, setFileName] = useState(null);
  const [parsed, setParsed] = useState(null); // { records, errors }
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState(null); // { succeeded, failed: [{row, reason}] }
  const fileInputRef = useRef(null);

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setResults(null);
    const reader = new FileReader();
    reader.onload = (ev) => setParsed(parseUsersCsv(String(ev.target.result), state?.companies || []));
    reader.readAsText(file);
  };

  const runImport = async () => {
    if (!parsed?.records?.length) return;
    setImporting(true);
    setProgress({ done: 0, total: parsed.records.length });
    const failed = [];
    let succeeded = 0;
    // Sequential, not Promise.all — each ADMIN/CREATE_USER call needs to
    // land before the next one for clean error attribution per row, and
    // this is an infrequent bulk-admin operation, not something latency-
    // sensitive enough to warrant the complexity of parallelizing it.
    for (const rec of parsed.records) {
      try {
        await dispatch({
          type: "ADMIN/CREATE_USER", name: rec.name, role: rec.role,
          staff_number: rec.staffNumber, vehicle: rec.vehicle, phone: rec.phone,
          auth: { login: rec.name, pass: rec.staffNumber },
          // No coordinates from the CSV — home_address is only set if a
          // label was actually provided, and even then with lat/lng null
          // until an admin confirms it via the address search (see
          // comment on parseUsersCsv above for why).
          home_address: rec.homeAddress ? { label: rec.homeAddress, area: rec.homeArea || "Cape Town", lat: null, lng: null } : null,
          branch_id: (rec.role === ROLE.AGENT || rec.role === ROLE.DRIVER) ? (rec.branchId || null) : undefined,
        });
        succeeded++;
      } catch (e) {
        failed.push({ row: rec.rowNum, name: rec.name, reason: e.message || "Unknown error" });
      }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setResults({ succeeded, failed });
    setImporting(false);
    if (failed.length === 0) onDone?.();
  };

  return (
    <Card>
      <SectionHeader label="Bulk Import Users (CSV)" />
      <div style={{ fontSize: 9, color: COLORS.ghost }}>
        Required columns: <b>Full Name, Role (AGENT/DRIVER), Staff Number</b>. Optional: Home Address, Home Area, Company, Vehicle, Phone.
        Home addresses aren't geocoded automatically — edit each agent afterward to confirm their exact pickup point via address search.
        Admin accounts can't be bulk-created; add those individually under Users.
      </div>

      <input ref={fileInputRef} type="file" accept=".csv" onChange={handleFile} style={{ display: "none" }} />
      <Button title={fileName ? `📄 ${fileName}` : "CHOOSE CSV FILE"} variant="ghost" onClick={() => fileInputRef.current?.click()} />

      {parsed && parsed.errors.length > 0 && (
        <div style={{ background: "rgba(220,53,69,.08)", border: "1px solid rgba(220,53,69,.3)", borderRadius: 4, padding: 10, maxHeight: 140, overflowY: "auto" }}>
          {parsed.errors.map((e, i) => <div key={i} style={{ fontSize: 10, color: COLORS.red }}>{e}</div>)}
        </div>
      )}

      {parsed && parsed.records.length > 0 && !results && (
        <>
          <div style={{ fontSize: 10, color: COLORS.chalk }}>{parsed.records.length} valid row{parsed.records.length !== 1 ? "s" : ""} ready to import.</div>
          {importing && <div style={{ fontSize: 10, color: COLORS.ghost }}>Importing {progress.done}/{progress.total}…</div>}
          <Button title={importing ? "IMPORTING…" : `IMPORT ${parsed.records.length} USER${parsed.records.length !== 1 ? "S" : ""}`} variant="amber" onClick={runImport} disabled={importing} />
        </>
      )}

      {results && (
        <div>
          <div style={{ fontSize: 11, color: COLORS.green, fontWeight: 700 }}>✓ {results.succeeded} user{results.succeeded !== 1 ? "s" : ""} created</div>
          {results.failed.length > 0 && (
            <>
              <div style={{ fontSize: 11, color: COLORS.red, fontWeight: 700, marginTop: 6 }}>✗ {results.failed.length} failed</div>
              {results.failed.map((f, i) => <div key={i} style={{ fontSize: 9, color: COLORS.red }}>Row {f.row} ({f.name}): {f.reason}</div>)}
            </>
          )}
        </div>
      )}

      <Button title="CLOSE" variant="ghost" onClick={onClose} />
    </Card>
  );
}

function CompanyManagerPanel({ state, dispatch, onClose }) {
  const emptyForm = { name: "", street: "", area: "", coord: null };
  const [newCo, setNewCo] = useState(emptyForm);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editCo, setEditCo] = useState(emptyForm);

  const [companyError, setCompanyError] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const toAddressObj = (street, area, coord) => coord ? { label: street, area, lat: coord.lat, lng: coord.lng } : null;

  const addCompany = async () => {
    if (!newCo.name.trim()) return;
    const address = toAddressObj(newCo.street, newCo.area, newCo.coord);
    if (!address) {
      setCompanyError("Pick the address from the search results (not just typed) before adding a company.");
      return;
    }
    setAdding(true);
    setCompanyError(null);
    try {
      await dispatch({ type: "ADMIN/CREATE_COMPANY", name: newCo.name.trim(), address });
      setNewCo(emptyForm);
    } catch (e) {
      setCompanyError(e.message || "Couldn't add the company — please try again.");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (c) => {
    setEditingId(c.id);
    setEditCo({
      name: c.name,
      street: c.address?.label || "", area: c.address?.area || "", coord: c.address ? { lat: c.address.lat, lng: c.address.lng, area: c.address.area } : null,
    });
  };

  const saveEdit = async (id) => {
    if (!editCo.name.trim()) return;
    setCompanyError(null);
    try {
      await dispatch({
        type: "ADMIN/UPDATE_COMPANY", company_id: id, name: editCo.name.trim(),
        address: toAddressObj(editCo.street, editCo.area, editCo.coord),
      });
      setEditingId(null);
    } catch (e) {
      setCompanyError(e.message || "Couldn't update the company — please try again.");
    }
  };

  const toggleActive = async (c) => {
    setCompanyError(null);
    try {
      await dispatch({ type: "ADMIN/UPDATE_COMPANY", company_id: c.id, active: !c.active });
    } catch (e) {
      setCompanyError(e.message || "Couldn't update the company — please try again.");
    }
  };

  const deleteCompany = async (c) => {
    setDeletingId(c.id);
    setCompanyError(null);
    try {
      await dispatch({ type: "ADMIN/DELETE_COMPANY", company_id: c.id });
      setConfirmingDeleteId(null);
    } catch (e) {
      setCompanyError(e.message || "Couldn't delete the company — please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  // Single address field — used for both the "add new company" form and
  // the inline edit form below, so the entry UI is defined once.
  const AddressField = ({ value, onChange }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: .5 }}>ADDRESS</span>
      <StreetInput value={value.street} placeholder="e.g. 65 Voortrekker Road, Maitland"
        preConfirmed={value.coord ? { label: value.street, area: value.area, lat: value.coord.lat, lng: value.coord.lng } : null}
        onChange={({ street, area, coord, confirmed }) => onChange({ ...value, street, area,
          // Only replace the existing coord when the user actually
          // confirmed a NEW selection from search results — StreetInput
          // fires onChange with coord:null on every keystroke while
          // typing (before a result is picked), which previously wiped
          // the company's real GPS coordinates the instant an admin
          // clicked into this field at all, even to save an unrelated
          // change like the company name. Keeping the prior coord until
          // a genuinely new one is confirmed prevents that.
          coord: confirmed ? coord : value.coord })} />
      <span style={{ fontSize: 8, color: COLORS.dim }}>Pick from the search results so the coordinates are set, not just typed text.</span>
    </div>
  );

  return (
    <Card>
      <SectionHeader label="Manage Companies" />
      <TextField label="New Company Name" value={newCo.name} onChange={e => setNewCo(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Telus Bellville" />
      <AddressField value={newCo} onChange={setNewCo} />
      <Button title={adding ? "ADDING…" : "+ ADD COMPANY"} variant="amber" size="sm" onClick={addCompany} disabled={adding || !newCo.name.trim()} />
      {companyError && <span style={{ fontSize: 10, color: COLORS.red }}>{companyError}</span>}

      {(state.companies || []).length === 0 ? (
        <span style={{ fontSize: 10, color: COLORS.ghost }}>No companies yet — add one above.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {state.companies.map(c => (
            <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10, border: `1px solid ${COLORS.wire}`, borderRadius: 4, opacity: c.active ? 1 : .5 }}>
              {editingId === c.id ? (
                <>
                  <input className="inp" value={editCo.name} onChange={e => setEditCo(f => ({ ...f, name: e.target.value }))} autoFocus />
                  <AddressField value={editCo} onChange={setEditCo} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setEditingId(null)} />
                    <Button title="SAVE" variant="amber" size="sm" style={{ flex: 1 }} onClick={() => saveEdit(c.id)} />
                  </div>
                </>
              ) : confirmingDeleteId === c.id ? (
                <>
                  <span style={{ fontSize: 10, color: COLORS.red }}>Delete "{c.name}"? Agents assigned to it must be reassigned first.</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setConfirmingDeleteId(null)} />
                    <Button title={deletingId === c.id ? "…" : "CONFIRM"} variant="danger" size="sm" style={{ flex: 1 }} onClick={() => deleteCompany(c)} disabled={deletingId === c.id} />
                  </div>
                </>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 11, fontWeight: 700 }}>{c.name}</span>
                    {!c.active && <span style={{ fontSize: 8, color: COLORS.ghost, border: `1px solid ${COLORS.wire}`, borderRadius: 2, padding: "2px 5px" }}>INACTIVE</span>}
                    <Button title="✎" variant="ghost" size="sm" onClick={() => startEdit(c)} />
                    <Button title={c.active ? "DEACTIVATE" : "REACTIVATE"} variant="ghost" size="sm" onClick={() => toggleActive(c)} />
                    <Button title="🗑" variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(c.id)} />
                  </div>
                  <div style={{ fontSize: 9, color: COLORS.teal }}>{c.address?.label || "—"}</div>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <Button title="CLOSE" variant="ghost" onClick={onClose} />
    </Card>
  );
}

function CampaignManagerPanel({ state, dispatch, onClose }) {
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");

  const [campaignError, setCampaignError] = useState(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const deleteCampaign = async (c) => {
    setDeletingId(c.id);
    setCampaignError(null);
    try {
      await dispatch({ type: "ADMIN/DELETE_CAMPAIGN", campaign_id: c.id });
      setConfirmingDeleteId(null);
    } catch (e) {
      setCampaignError(e.message || "Couldn't delete the campaign — please try again.");
    } finally {
      setDeletingId(null);
    }
  };

  const addCampaign = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    setCampaignError(null);
    try {
      await dispatch({ type: "ADMIN/CREATE_CAMPAIGN", name: newName.trim() });
      setNewName("");
    } catch (e) {
      setCampaignError(e.message || "Couldn't add the campaign — please try again.");
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async (id) => {
    if (!editName.trim()) return;
    setCampaignError(null);
    try {
      await dispatch({ type: "ADMIN/UPDATE_CAMPAIGN", campaign_id: id, name: editName.trim() });
      setEditingId(null);
    } catch (e) {
      setCampaignError(e.message || "Couldn't rename the campaign — please try again.");
    }
  };

  const toggleActive = async (c) => {
    setCampaignError(null);
    try {
      await dispatch({ type: "ADMIN/UPDATE_CAMPAIGN", campaign_id: c.id, active: !c.active });
    } catch (e) {
      setCampaignError(e.message || "Couldn't update the campaign — please try again.");
    }
  };

  return (
    <Card>
      <SectionHeader label="Manage Campaigns / Projects" />
      <div style={{ display: "flex", gap: 8 }}>
        <TextField label="New Campaign Name" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Vodacom Support" style={{ flex: 1 }} />
      </div>
      <Button title={adding ? "ADDING…" : "+ ADD CAMPAIGN"} variant="amber" size="sm" onClick={addCampaign} disabled={adding || !newName.trim()} />
      {campaignError && <span style={{ fontSize: 10, color: COLORS.red }}>{campaignError}</span>}

      {(state.campaigns || []).length === 0 ? (
        <span style={{ fontSize: 10, color: COLORS.ghost }}>No campaigns yet — add one above.</span>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {state.campaigns.map(c => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 8, border: `1px solid ${COLORS.wire}`, borderRadius: 4, opacity: c.active ? 1 : .5 }}>
              {editingId === c.id ? (
                <>
                  <input className="inp" value={editName} onChange={e => setEditName(e.target.value)} style={{ flex: 1 }} autoFocus />
                  <Button title="SAVE" variant="amber" size="sm" onClick={() => saveEdit(c.id)} />
                  <Button title="✕" variant="ghost" size="sm" onClick={() => setEditingId(null)} />
                </>
              ) : confirmingDeleteId === c.id ? (
                <>
                  <span style={{ flex: 1, fontSize: 10, color: COLORS.red }}>Delete "{c.name}"? Agents assigned to it must be reassigned first.</span>
                  <Button title="CANCEL" variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(null)} />
                  <Button title={deletingId === c.id ? "…" : "CONFIRM"} variant="danger" size="sm" onClick={() => deleteCampaign(c)} disabled={deletingId === c.id} />
                </>
              ) : (
                <>
                  <span style={{ flex: 1, fontSize: 11, fontWeight: 700 }}>{c.name}</span>
                  {!c.active && <span style={{ fontSize: 8, color: COLORS.ghost, border: `1px solid ${COLORS.wire}`, borderRadius: 2, padding: "2px 5px" }}>INACTIVE</span>}
                  <Button title="✎" variant="ghost" size="sm" onClick={() => { setEditingId(c.id); setEditName(c.name); }} />
                  <Button title={c.active ? "DEACTIVATE" : "REACTIVATE"} variant="ghost" size="sm" onClick={() => toggleActive(c)} />
                  <Button title="🗑" variant="ghost" size="sm" onClick={() => setConfirmingDeleteId(c.id)} />
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <Button title="CLOSE" variant="ghost" onClick={onClose} />
    </Card>
  );
}

function AdminUsers({ state, dispatch, user }) {
  const [show, setShow] = useState(false);
  const [editingId, setEditingId] = useState(null);
  // editingId = which row is expanded to show its profile; editModeId =
  // which expanded row (if any) has switched into the editable form.
  // Separate from editingId so tapping a row always opens the read-only
  // profile first — edit is an explicit, secondary action from there.
  const [editModeId, setEditModeId] = useState(null);
  const canCreateAgentsDrivers = hasAdminPermission(user, "manageAgentsDrivers");
  const canManageAdmins = hasAdminPermission(user, "manageAdmins");
  const canCreateAnything = canCreateAgentsDrivers || canManageAdmins;

  // Multi-select delete — a Set so toggling a row on tap is a plain
  // add/delete rather than an indexOf/splice dance (same pattern as the
  // Dispatch tab's multi-select). Deliberately separate from editingId:
  // selection mode and the single-row edit panel are two different
  // interactions and shouldn't fight over the same row's expanded state.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteResults, setDeleteResults] = useState(null);
  // Search/filter — genuinely missing before (a flat, unfiltered list
  // of every user in the whole system), found during a scan for real
  // friction points and built per explicit approval. Matches on name,
  // staff number, or role (typing "driver"/"admin"/"agent" filters by
  // role too, a natural thing to want on a screen mixing all three).
  const [userSearch, setUserSearch] = useState("");
  const filteredUsers = userSearch.trim().length >= 1
    ? state.users.filter(u => {
        const q = userSearch.trim().toLowerCase();
        return u.name.toLowerCase().includes(q) || (u.staff_number || "").toLowerCase().includes(q) || u.role.toLowerCase().includes(q);
      })
    : state.users;
  const toggleSelected = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedIds(new Set()); setConfirmingDelete(false); setDeleteResults(null); };
  const runDelete = async () => {
    setDeleting(true);
    try {
      const results = await dispatch({ type: "ADMIN/DELETE_USERS", user_ids: [...selectedIds], acting_admin_id: user.id });
      setDeleteResults(results || []);
      // Only clear selection for accounts that actually got deleted —
      // refused ones (active trip history, self-delete, permission)
      // stay checked so the admin can see exactly which rows the
      // results list below refers to, instead of the whole selection
      // vanishing and leaving them to match names against ids by memory.
      const deletedIds = new Set((results || []).filter(r => r.ok).map(r => r.id));
      setSelectedIds(prev => new Set([...prev].filter(id => !deletedIds.has(id))));
    } catch (e) {
      setDeleteResults([{ ok: false, reason: e.message || "Delete failed — please try again." }]);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const [form, setForm] = useState({ name: "", staffNumber: "", role: ROLE.AGENT, vehicle: "", phone: "", homeStreet: "", homeArea: "", homeCoord: null, homeConfirmed: false, branchId: null, campaignId: null, adminLevel: ADMIN_LEVEL.VIEWER, scopedCompanyIds: [] });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const [submitError, setSubmitError] = useState(null);
  const submit = async () => {
    if (!form.name || !form.staffNumber) return;
    // A Viewer admin created with zero companies checked isn't a
    // no-op — getAdminCompanyIds fails CLOSED for that case (sees
    // NOTHING, not everything, per the fail-open bug fixed elsewhere
    // this session), so this silently produces a Viewer account that
    // can never see any data at all, with no error anywhere to explain
    // why. Catch it here instead of leaving the admin to discover it
    // only when the new Viewer logs in and reports an empty portal.
    if (form.role === ROLE.ADMIN && form.adminLevel === ADMIN_LEVEL.VIEWER && form.scopedCompanyIds.length === 0) {
      setSubmitError("Select at least one company for a Viewer admin — without one, they won't be able to see any data.");
      return;
    }
    setSubmitError(null);
    try {
      await dispatch({
        type: "ADMIN/CREATE_USER", name: form.name, role: form.role, vehicle: form.vehicle, phone: form.phone,
        staff_number: form.staffNumber,
        auth: { login: form.name, pass: form.staffNumber }, // username = full name, password = staff number
        home_address: ((form.role === ROLE.AGENT || form.role === ROLE.DRIVER) && form.homeCoord) ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null,
        branch_id: (form.role === ROLE.AGENT || form.role === ROLE.DRIVER) ? form.branchId : undefined,
        campaign_id: form.role === ROLE.AGENT ? form.campaignId : undefined,
        admin_level: form.role === ROLE.ADMIN ? form.adminLevel : undefined,
        scoped_company_ids: form.role === ROLE.ADMIN ? form.scopedCompanyIds : undefined,
      });
      setForm({ name: "", staffNumber: "", role: ROLE.AGENT, vehicle: "", phone: "", homeStreet: "", homeArea: "", homeCoord: null, homeConfirmed: false, branchId: null, campaignId: null, adminLevel: ADMIN_LEVEL.VIEWER, scopedCompanyIds: [] });
      setShow(false);
    } catch (e) {
      setSubmitError(e.message || "Couldn't create the account — please try again.");
    }
  };

  // A STANDARD admin can create agents/drivers but never admins, even if
  // they somehow force the role selector open — filter the actual choices
  // offered rather than relying on the button being hidden.
  const availableRoles = [
    ...(canCreateAgentsDrivers ? [ROLE.AGENT, ROLE.DRIVER] : []),
    ...(canManageAdmins ? [ROLE.ADMIN] : []),
  ];

  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showCampaigns, setShowCampaigns] = useState(false);
  const [showCompanies, setShowCompanies] = useState(false);
  const closeAllPanels = () => { setShow(false); setShowBulkImport(false); setShowCampaigns(false); setShowCompanies(false); setEditingId(null); setEditModeId(null); };

  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <SectionHeader label="User Registry" />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {hasAdminPermission(user, "exportCsv") && <Button title="⬇ EXPORT CSV" variant="ghost" size="sm" onClick={() => downloadCsv(usersToCsv(state.users, state.driver_status), `users_${new Date().toISOString().slice(0, 10)}.csv`)} />}
          {canCreateAnything && <Button title="🏢 COMPANIES" variant="ghost" size="sm" onClick={() => { const next = !showCompanies; closeAllPanels(); setShowCompanies(next); }} />}
          {canCreateAnything && <Button title="🏷 CAMPAIGNS" variant="ghost" size="sm" onClick={() => { const next = !showCampaigns; closeAllPanels(); setShowCampaigns(next); }} />}
          {canCreateAnything && <Button title="⬆ BULK IMPORT" variant="ghost" size="sm" onClick={() => { const next = !showBulkImport; closeAllPanels(); setShowBulkImport(next); }} />}
          {canCreateAnything && <Button title="+ CREATE USER" variant="amber" size="sm" onClick={() => { const next = !show; closeAllPanels(); setShow(next); }} />}
          {canCreateAnything && (
            selectMode
              ? <Button title="✕ CANCEL SELECT" variant="ghost" size="sm" onClick={exitSelectMode} />
              : <Button title="☑ SELECT" variant="ghost" size="sm" onClick={() => { closeAllPanels(); setSelectMode(true); }} />
          )}
        </div>
      </div>
      {showCompanies && canCreateAnything && (
        <CompanyManagerPanel state={state} dispatch={dispatch} onClose={() => setShowCompanies(false)} />
      )}
      {showCampaigns && canCreateAnything && (
        <CampaignManagerPanel state={state} dispatch={dispatch} onClose={() => setShowCampaigns(false)} />
      )}
      {showBulkImport && canCreateAnything && (
        <BulkUserImportPanel state={state} dispatch={dispatch} onClose={() => setShowBulkImport(false)} onDone={() => setShowBulkImport(false)} />
      )}
      {selectMode && (
        <div style={{ background: "rgba(245,166,35,.08)", border: "1px solid rgba(245,166,35,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={{ fontSize: 10, color: COLORS.mist }}>Tap accounts below to select them. {selectedIds.size} selected.</span>
          {deleteResults && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {deleteResults.map((r, i) => (
                <span key={i} style={{ fontSize: 10, color: r.ok ? COLORS.green : COLORS.red }}>
                  {r.ok ? "✓" : "✗"} {r.name || "Account"}{!r.ok && r.reason ? ` — ${r.reason}` : ""}
                </span>
              ))}
            </div>
          )}
          {!confirmingDelete ? (
            <Button title={`🗑 DELETE SELECTED (${selectedIds.size})`} variant="danger" size="sm" onClick={() => setConfirmingDelete(true)} disabled={selectedIds.size === 0} />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span style={{ fontSize: 10, color: COLORS.chalk }}>
                Delete {selectedIds.size} account{selectedIds.size !== 1 ? "s" : ""}? This can't be undone. Accounts with any trip history will be refused automatically rather than deleted.
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setConfirmingDelete(false)} />
                <Button title={deleting ? "DELETING…" : "CONFIRM DELETE"} variant="danger" size="sm" style={{ flex: 1 }} onClick={runDelete} disabled={deleting} loading={deleting} />
              </div>
            </div>
          )}
        </div>
      )}
      {show && canCreateAnything && (
        <Card>
          <TextField label="Full Name" value={form.name} onChange={e => set("name", e.target.value)} />
          <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Username will be the full name above</span>
          <SectionHeader label="Role" />
          <div style={{ display: "flex", gap: 8 }}>
            {availableRoles.map(r => <Button key={r} title={r} size="sm" variant={form.role === r ? "amber" : "ghost"} onClick={() => set("role", r)} style={{ flex: 1 }} />)}
          </div>
          <TextField label="Staff Number (also used as password)" value={form.staffNumber} onChange={e => set("staffNumber", e.target.value)} placeholder="e.g. AG1004" />
          <TextField label="Cellphone Number" value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="07x xxx xxxx" />
          {form.role === ROLE.AGENT && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <SectionHeader label="Home Address (Cape Town)" />
                <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
                  onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: coord, homeConfirmed: !!confirmed }))} />
              </div>
              <SectionHeader label="Company" />
              {(state?.companies || []).length === 0 ? (
                <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet — add one from Manage Companies before creating agent accounts.</span>
              ) : (
                <select className="inp" value={form.branchId || ""} onChange={e => set("branchId", e.target.value || null)} style={{ width: "100%" }}>
                  <option value="">— None —</option>
                  {(isMasterAdmin(user, state.companies) ? state.companies : (state.companies || []).filter(c => getAdminCompanyIds(user, state.companies).includes(c.id))).filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <SectionHeader label="Campaign / Project" />
              {(state?.campaigns || []).length === 0 ? (
                <span style={{ fontSize: 9, color: COLORS.ghost }}>No campaigns have been added yet.</span>
              ) : (
                <select className="inp" value={form.campaignId || ""} onChange={e => set("campaignId", e.target.value || null)} style={{ width: "100%" }}>
                  <option value="">— None —</option>
                  {state.campaigns.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </>
          )}
          {form.role === ROLE.DRIVER && (
            <>
              <TextField label="Vehicle" value={form.vehicle} onChange={e => set("vehicle", e.target.value)} placeholder="Toyota Hiace - CA 000-000" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <SectionHeader label="Home Area (Cape Town)" />
                <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Used by admins to see which area a driver lives in when assigning trips.</span>
                <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
                  onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: coord, homeConfirmed: !!confirmed }))} />
              </div>
              <SectionHeader label="Company" />
              {(state?.companies || []).length === 0 ? (
                <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet — add one from Manage Companies before creating driver accounts.</span>
              ) : (
                <select className="inp" value={form.branchId || ""} onChange={e => set("branchId", e.target.value || null)} style={{ width: "100%" }}>
                  <option value="">— None —</option>
                  {state.companies.filter(c => c.active).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </>
          )}
          {form.role === ROLE.ADMIN && (
            <>
              <SectionHeader label="Admin Level" />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {Object.values(ADMIN_LEVEL).map(lvl => (
                  <Button key={lvl} title={ADMIN_LEVEL_LABEL[lvl]} size="sm" variant={form.adminLevel === lvl ? "amber" : "ghost"} onClick={() => set("adminLevel", lvl)} full />
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <SectionHeader label="Companies (optional)" />
                <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>
                  {form.adminLevel === ADMIN_LEVEL.VIEWER
                    ? "If any are checked, this Viewer only sees agents, drivers on their trips, trips, tickets, and alerts belonging to the selected companies. Leave all unchecked for unrestricted (all-company) Viewer access."
                    : "A label for which companies this admin manages — Fleet Ops and Standard admins always see every company's data regardless of what's checked here; this doesn't restrict anything for them."}
                </span>
                {(state?.companies || []).length === 0 ? (
                  <span style={{ fontSize: 9, color: COLORS.ghost }}>No companies have been added yet.</span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {state.companies.filter(c => c.active).map(c => {
                      const checked = form.scopedCompanyIds.includes(c.id);
                      return (
                        <div key={c.id} onClick={() => set("scopedCompanyIds", checked ? form.scopedCompanyIds.filter(id => id !== c.id) : [...form.scopedCompanyIds, c.id])}
                          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <span style={{ width: 15, height: 15, borderRadius: 3, border: `1px solid ${checked ? COLORS.amber : COLORS.wire}`, background: checked ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: COLORS.ink, flexShrink: 0 }}>{checked && "✓"}</span>
                          <span style={{ fontSize: 11, color: COLORS.chalk }}>{c.name}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
          {submitError && <span style={{ fontSize: 10, color: COLORS.red }}>{submitError}</span>}
          <div style={{ display: "flex", gap: 8 }}>
            <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={() => setShow(false)} />
            <Button title="CREATE →" variant="amber" style={{ flex: 1 }} onClick={submit} />
          </div>
        </Card>
      )}
      <TextField label="Search by name, staff number, or role" value={userSearch} onChange={e => setUserSearch(e.target.value)} placeholder="e.g. Nomsa Dlamini, AG1001, or driver" />
      <Card body={false}>
        {filteredUsers.length === 0 ? (
          <Empty icon="👤" text={`No users match "${userSearch}"`} />
        ) : filteredUsers.map(u => {
          const isExpanded = editingId === u.id;
          const isEditingThisRow = isExpanded && editModeId === u.id;
          const driverStatus = u.role === ROLE.DRIVER ? state.driver_status.find(d => String(d.driver_id) === String(u.id)) : null;
          // Editing an admin needs manageAdmins; editing an agent/driver
          // just needs manageAgentsDrivers — mirrors the server-side check
          // in ADMIN/UPDATE_USER, so the UI doesn't offer an edit action
          // that would just get rejected anyway. Viewing the profile has
          // no such gate — any admin who can see the Users tab at all
          // can see full account details; only WRITING requires the
          // extra permission.
          const canEditThisUser = u.role === ROLE.ADMIN ? canManageAdmins : canCreateAgentsDrivers;
          const isSelf = String(u.id) === String(user.id);
          // Same permission tiering as ADMIN/DELETE_USERS' per-target
          // check — a STANDARD admin can select agents/drivers but not
          // other admins; disabling those rows here means the confirm
          // step never shows a selection that the backend would just
          // refuse anyway.
          const canDeleteThisUser = !isSelf && (u.role === ROLE.ADMIN ? canManageAdmins : canCreateAgentsDrivers);
          const isSelected = selectedIds.has(u.id);
          const rowClick = selectMode
            ? () => { if (canDeleteThisUser) toggleSelected(u.id); }
            : () => { setEditingId(isExpanded ? null : u.id); setEditModeId(null); setShow(false); };
          return (
            <React.Fragment key={u.id}>
              <div onClick={rowClick}
                style={{ cursor: (selectMode ? canDeleteThisUser : true) ? "pointer" : "default", opacity: selectMode && !canDeleteThisUser ? .4 : 1, display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: isExpanded ? "none" : `1px solid ${COLORS.wire}`, background: isExpanded ? "rgba(245,166,35,.05)" : isSelected ? "rgba(220,53,69,.06)" : "transparent" }}>
                {selectMode && (
                  <span style={{ width: 16, height: 16, borderRadius: 3, border: `1px solid ${isSelected ? COLORS.red : COLORS.wire}`, background: isSelected ? COLORS.red : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, color: "#fff", flexShrink: 0 }}>{isSelected && "✓"}</span>
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700 }}>{u.name}{isSelf && selectMode && <span style={{ color: COLORS.ghost, fontWeight: 400 }}> (you)</span>}</div>
                  <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 1 }}>Staff #: {u.staff_number || "—"}</div>
                  {u.role === ROLE.AGENT && u.home_address && <div style={{ fontSize: 9, color: COLORS.green, marginTop: 2 }}>📍 {u.home_address.label}</div>}
                  {u.role === ROLE.DRIVER && driverStatus?.vehicle && <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>🚐 {driverStatus.vehicle}</div>}
                  {u.role === ROLE.ADMIN && u.admin_level && <div style={{ fontSize: 9, color: COLORS.amber, marginTop: 2 }}>{ADMIN_LEVEL_LABEL[u.admin_level]}</div>}
                </div>
                <RoleBadge role={u.role} />
                {!selectMode && <span style={{ color: COLORS.ghost, fontSize: 11 }}>{isExpanded ? "▲" : "▾"}</span>}
              </div>
              {isExpanded && !selectMode && (
                <div style={{ padding: "0 12px 12px", borderBottom: `1px solid ${COLORS.wire}`, display: "flex", flexDirection: "column", gap: 10 }}>
                  {isEditingThisRow ? (
                    <EditUserPanel user={u} driverStatus={driverStatus} dispatch={dispatch} state={state} onClose={() => setEditModeId(null)} />
                  ) : (
                    <>
                      <UserProfilePanel u={u} driverStatus={driverStatus} state={state} />
                      {canEditThisUser && <Button title="✎ EDIT ACCOUNT" variant="ghost" size="sm" onClick={() => setEditModeId(u.id)} />}
                    </>
                  )}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </Card>
    </div>
  );
}

function AdminContacts({ state, dispatch, user, call }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [dmMessages, setDmMessages] = useState([]);
  const [loadingDm, setLoadingDm] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Inbox of existing conversations — the real gap this was missing:
  // an admin could only ever START a conversation by searching someone
  // out, never see one that another admin (or agent/driver) started
  // WITH them. fetchMyConversations is already genuinely role-agnostic
  // (built for the agent/driver MessagesTab), reused here as-is.
  const [conversations, setConversations] = useState(null); // null = loading
  const loadConversations = useCallback(async () => {
    if (!supabase) { setConversations([]); return; }
    try {
      const convos = await fetchMyConversations(user.id, state.users);
      setConversations(convos.sort((a, b) => Number(b.last_ts_epoch) - Number(a.last_ts_epoch)));
    } catch (e) {
      setConversations([]);
    }
  }, [user.id, state.users]);
  useEffect(() => { loadConversations(); }, [loadConversations, state._dmVersion]);

  // Directory now includes admins too, per explicit decision — excluding
  // the current admin themselves, since messaging/calling yourself isn't
  // meaningful.
  const directory = state.users.filter(u => (u.role === ROLE.AGENT || u.role === ROLE.DRIVER || u.role === ROLE.ADMIN) && u.id !== user.id);
  const matches = query.trim().length >= 1
    ? directory.filter(u => u.name.toLowerCase().includes(query.trim().toLowerCase()) || (u.staff_number || "").toLowerCase().includes(query.trim().toLowerCase()))
    : directory;

  const selected = selectedId ? state.users.find(u => String(u.id) === String(selectedId)) : null;

  const openConversation = async (u) => {
    setSelectedId(u.id);
    setQuery("");
    setLoadingDm(true);
    // Mark all unread DIRECT_MESSAGE notifications for this admin as read
    // the moment they open a conversation — same as MessagesTab (agents/
    // drivers) does on mount. Without this the Contacts badge and the
    // AlertsTab DIRECT_MESSAGE entry persist forever.
    const dmNotifs = state.notifications.filter(
      n => n.type === "DIRECT_MESSAGE" && !n.read && n.for_user_ids?.some(id => String(id) === String(user.id))
    );
    dmNotifs.forEach(n => dispatch({ type: "NOTIF/MARK_READ", id: n.id }).catch(() => {}));
    try {
      const msgs = await fetchDirectMessages(user.id, u.id);
      setDmMessages(msgs);
    } catch (e) {
      setDmMessages([]);
    } finally {
      setLoadingDm(false);
    }
  };

  // Reload the open conversation thread whenever a new DM arrives
  // (state._dmVersion increments on every direct_messages realtime event).
  // Without this, a new message from the other person only appears after
  // the admin closes and reopens the conversation.
  useEffect(() => {
    if (!selectedId || !supabase) return;
    fetchDirectMessages(user.id, selectedId).then(setDmMessages).catch(() => {});
  }, [state._dmVersion, selectedId, user.id]);

  const send = async () => {
    if (!text.trim() || !selected || sending) return;
    setSending(true);
    try {
      await dispatch({ type: "DM/SEND", sender_id: user.id, sender_name: user.name, sender_role: ROLE.ADMIN, recipient_id: selected.id, message: text.trim() });
      setText("");
      // DM/SEND doesn't trigger a refetch (direct_messages isn't part of
      // the main sync cycle) — re-fetch just this conversation so the new
      // message shows up immediately.
      const msgs = await fetchDirectMessages(user.id, selected.id);
      setDmMessages(msgs);
      loadConversations(); // also refresh the inbox list's preview/order
    } catch (e) {
      // The global toast wrapper already told the user the send failed
      // (and re-threw) — without this catch that re-throw escaped the
      // onClick as an unhandled promise rejection. Text deliberately
      // stays in the input so they can just hit send again.
      console.warn("[Contacts] DM send failed:", e.message);
    } finally {
      // Previously this only ran after a successful send — a failed
      // dispatch (now that dispatch throws) left sending stuck true
      // forever, permanently disabling the send button. The global toast
      // wrapper already tells the user it failed; this just makes sure
      // they can try again.
      setSending(false);
    }
  };

  return (
    <div className="pad">
      <SectionHeader label="Contacts" />
      <div style={{ fontSize: 10, color: COLORS.ghost, marginBottom: 4 }}>
        Message or call any agent, driver, or fellow admin directly — not tied to a specific trip, works at any time.
      </div>

      {!selected && conversations !== null && conversations.length > 0 && (
        <>
          <SectionHeader label="Recent Conversations" />
          <Card body={false}>
            {conversations.map(c => {
              const cUser = state.users.find(u => String(u.id) === String(c.counterpart_id));
              return (
                <div key={c.counterpart_id} onClick={() => openConversation({ id: c.counterpart_id, name: c.counterpart_name, role: cUser?.role })} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 10, borderBottom: `1px solid ${COLORS.wire}` }}>
                  <DriverAvatar name={c.counterpart_name} isOnline={cUser?.is_online} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 700 }}>{c.counterpart_name}</div>
                    <div style={{ fontSize: 9, color: COLORS.ghost, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {String(c.last_sender_id) === String(user.id) ? "You: " : ""}{c.last_message}
                    </div>
                  </div>
                  {cUser && <RoleBadge role={cUser.role} />}
                </div>
              );
            })}
          </Card>
        </>
      )}

      <TextField label="Search by name or staff number" value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. Nomsa Dlamini or DR2001" />

      {!selected && (
        <Card body={false}>
          {matches.length === 0 ? <Empty icon="💬" text="No matches" /> : matches.slice(0, 30).map(u => (
            <div key={u.id} onClick={() => openConversation(u)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: 10, borderBottom: `1px solid ${COLORS.wire}` }}>
              <DriverAvatar name={u.name} isOnline={u.is_online} size={30} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700 }}>{u.name}</div>
                <div style={{ fontSize: 9, color: COLORS.ghost }}>Staff #: {u.staff_number || "—"}</div>
              </div>
              <RoleBadge role={u.role} />
            </div>
          ))}
        </Card>
      )}

      {selected && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <DriverAvatar name={selected.name} isOnline={selected.is_online} size={36} />
              <div>
                <div style={{ fontFamily: FONTS.head, fontSize: 14, fontWeight: 700 }}>{selected.name}</div>
                <RoleBadge role={selected.role} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {call && (
                <Button
                  title="📞 CALL" variant="green" size="sm"
                  onClick={() => call.startCall({ id: selected.id, name: selected.name }, null)}
                  disabled={call.callState !== CALL_STATE.IDLE}
                />
              )}
              <Button title="✕" variant="ghost" size="sm" onClick={() => { setSelectedId(null); setDmMessages([]); }} />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 320, overflowY: "auto", marginTop: 8 }}>
            {loadingDm && <span style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", padding: 12 }}>Loading conversation…</span>}
            {!loadingDm && dmMessages.length === 0 && <span style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", padding: 12 }}>No messages yet — say hello.</span>}
            {dmMessages.map(m => {
              const mine = String(m.sender_id) === String(user.id);
              return (
                <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "82%", borderRadius: 6, padding: 9, background: mine ? "rgba(45,140,240,.15)" : COLORS.surface, border: `1px solid ${mine ? "rgba(45,140,240,.3)" : COLORS.wire}` }}>
                  <div style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, marginBottom: 3 }}>{m.sender_name} · {m.ts}</div>
                  <div style={{ fontSize: 11 }}>{m.text}</div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
            <input className="inp" style={{ flex: 1 }} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && !sending && send()} placeholder="Type a message…" disabled={sending} />
            <Button title="SEND" variant="amber" size="sm" onClick={send} disabled={sending || !text.trim()} />
          </div>
        </Card>
      )}
    </div>
  );
}

function AdminTickets({ state, dispatch, user }) {
  const [filterStatus, setFilterStatus] = useState("OPEN");
  const [expandedId, setExpandedId] = useState(null);
  const [replyText, setReplyText] = useState("");
  const [savingId, setSavingId] = useState(null);
  const canAction = hasAdminPermission(user, "manageTrips");

  const filtered = filterStatus === "ALL" ? state.tickets : state.tickets.filter(t => t.status === filterStatus);
  const openCount = state.tickets.filter(t => t.status === "OPEN").length;

  const filedByName = (ticket) => {
    const found = state.users.find(u => String(u.id) === String(ticket.agent_id));
    if (found) return found.name;
    // Only reachable if the user record is genuinely missing (e.g.
    // deleted account) — falls back to a role-aware label instead of
    // always saying "Agent", since this same lookup now serves driver
    // tickets too.
    return `${ticket.role === ROLE.DRIVER ? "Driver" : "Agent"} ${ticket.agent_id}`;
  };
  const STATUS_COLOR = { OPEN: COLORS.amber, IN_PROGRESS: COLORS.blue2, RESOLVED: COLORS.green };

  const [ticketActionError, setTicketActionError] = useState(null);

  const setStatus = async (ticketId, status) => {
    setSavingId(ticketId);
    setTicketActionError(null);
    try {
      await dispatch({ type: "TICKET/UPDATE", ticket_id: ticketId, status, admin_id: user.id });
    } catch (e) {
      setTicketActionError(e.message || "Couldn't update the ticket — please try again.");
    } finally {
      setSavingId(null);
    }
  };

  const sendReply = async (ticketId) => {
    if (!replyText.trim()) return;
    setSavingId(ticketId);
    setTicketActionError(null);
    try {
      await dispatch({ type: "TICKET/UPDATE", ticket_id: ticketId, admin_reply: replyText.trim(), admin_id: user.id, status: "IN_PROGRESS" });
      setReplyText("");
    } catch (e) {
      setTicketActionError(e.message || "Couldn't send the reply — please try again.");
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="pad">
      <SectionHeader label={`Tickets ${openCount > 0 ? `(${openCount} open)` : ""}`} />
      {ticketActionError && (
        <div style={{ background: "rgba(220,53,69,.08)", border: "1px solid rgba(220,53,69,.3)", borderRadius: 4, padding: 10 }}>
          <span style={{ fontSize: 11, color: COLORS.red }}>{ticketActionError}</span>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {["OPEN", "IN_PROGRESS", "RESOLVED", "ALL"].map(s => (
          <Button key={s} size="sm" variant={filterStatus === s ? "amber" : "ghost"} title={s.replace("_", " ")} onClick={() => setFilterStatus(s)} />
        ))}
      </div>

      {filtered.length === 0 ? <Empty icon="🎫" text="No tickets" /> : filtered.map(t => {
        const isExpanded = expandedId === t.id;
        const trip = t.trip_id ? state.trips.find(x => String(x.trip_id) === String(t.trip_id)) : null;
        return (
          <Card key={t.id}>
            <div onClick={() => { setExpandedId(isExpanded ? null : t.id); setReplyText(""); }} style={{ cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700 }}>{t.category}</div>
                <div style={{ fontSize: 10, color: COLORS.ghost, display: "flex", alignItems: "center", gap: 6 }}>
                  {filedByName(t)} <RoleBadge role={t.role} /> · {epochToDisplay(t.created_at)}
                </div>
              </div>
              <span style={{ fontSize: 8, fontWeight: 700, color: STATUS_COLOR[t.status], border: `1px solid ${STATUS_COLOR[t.status]}`, borderRadius: 2, padding: "2px 6px" }}>{t.status.replace("_", " ")}</span>
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5 }}>{t.message}</div>
            {t.trip_id && (
              <div style={{ fontSize: 10, color: COLORS.teal }}>
                Re: Trip {t.trip_id}{trip ? ` — Driver: ${state.users.find(u => String(u.id) === String(trip.driver_id))?.name || "unassigned"}` : ""}
              </div>
            )}
            {(t.replies && t.replies.length > 0 ? t.replies : t.admin_reply ? [{ admin_name: null, message: t.admin_reply, ts: t.updated_at }] : []).map((r, i) => (
              <div key={i} style={{ background: COLORS.surface, borderRadius: 4, padding: 10 }}>
                <div style={{ fontSize: 9, color: COLORS.amber, fontWeight: 700, marginBottom: 3 }}>
                  {r.admin_name ? `REPLY — ${r.admin_name}` : "REPLY"}{r.ts ? ` — ${epochToDisplay(r.ts)}` : ""}
                </div>
                <div style={{ fontSize: 11 }}>{r.message}</div>
              </div>
            ))}
            {isExpanded && canAction && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, borderTop: `1px solid ${COLORS.wire}`, paddingTop: 10 }}>
                <textarea
                  className="inp" rows={3} value={replyText} onChange={e => setReplyText(e.target.value)}
                  placeholder="Reply to the agent…" style={{ width: "100%", resize: "vertical", fontFamily: "inherit" }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button title={savingId === t.id ? "SENDING…" : "SEND REPLY"} variant="amber" size="sm" onClick={() => sendReply(t.id)} disabled={savingId === t.id || !replyText.trim()} />
                  {t.status !== "IN_PROGRESS" && <Button title="MARK IN PROGRESS" variant="ghost" size="sm" onClick={() => setStatus(t.id, "IN_PROGRESS")} disabled={savingId === t.id} />}
                  {t.status !== "RESOLVED" && <Button title="MARK RESOLVED" variant="ghost" size="sm" onClick={() => setStatus(t.id, "RESOLVED")} disabled={savingId === t.id} />}
                  {t.status === "RESOLVED" && <Button title="RE-OPEN" variant="ghost" size="sm" onClick={() => setStatus(t.id, "OPEN")} disabled={savingId === t.id} />}
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function AdminNotifs({ state, user, dispatch, onJumpToTrip }) {
  const [filterDate, setFilterDate] = useState(""); // "" = show all, else YYYY-MM-DD
  const [selectMode, setSelectMode] = useState(false);
  const [selectedNotifIds, setSelectedNotifIds] = useState(new Set());
  const [confirmingDeleteNotifs, setConfirmingDeleteNotifs] = useState(false);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  const [deletingNotifs, setDeletingNotifs] = useState(false);
  const toggleNotifSelect = (id) => {
    setSelectedNotifIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => { setSelectMode(false); setSelectedNotifIds(new Set()); setConfirmingDeleteNotifs(false); setConfirmingDeleteAll(false); };
  const deleteSelectedNotifs = async () => {
    setDeletingNotifs(true);
    try {
      await dispatch({ type: "NOTIF/DELETE_SELECTED", ids: [...selectedNotifIds], admin: true });
      exitSelectMode();
    } catch (e) {
      console.warn("[AdminNotifs] delete failed:", e.message);
    } finally {
      setDeletingNotifs(false);
    }
  };
  const deleteAllNotifs = async () => {
    setDeletingNotifs(true);
    try {
      // Delete ALL visible notifications (filtered view or all)
      const idsToDelete = adminNotifs.map(n => n.id);
      await dispatch({ type: "NOTIF/DELETE_SELECTED", ids: idsToDelete, admin: true });
      exitSelectMode();
    } catch (e) {
      console.warn("[AdminNotifs] delete all failed:", e.message);
    } finally {
      setDeletingNotifs(false);
    }
  };
  const adminNotifsAll = state.notifications.filter(n =>
    (n.for_roles?.includes(ROLE.ADMIN) || !n.for_roles?.length) &&
    (!n.for_user_ids?.length || n.for_user_ids.some(id => String(id) === String(user.id)))
  );
  const adminNotifs = filterDate
    ? adminNotifsAll.filter(n => {
        if (n.ts_epoch == null) return false;
        const d = new Date(n.ts_epoch);
        const dayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return dayStr === filterDate;
      })
    : adminNotifsAll;
  const unread = adminNotifsAll.filter(n => !n.read).length;
  const unreadInView = adminNotifs.filter(n => !n.read).length;
  const allSelected = adminNotifs.length > 0 && adminNotifs.every(n => selectedNotifIds.has(n.id));
  // COMPLIANCE_DISTANCE/COMPLIANCE_OVERLOAD/SOS_ALERT/SPEED_ANOMALY/
  // ROUTE_DEVIATION are all fired with for_roles:[ROLE.ADMIN] (checkComplianceTriggers,
  // the SOS button, and the driver-safety speed/deviation trackers) — they
  // DO reach this admin notification list, but were missing here even
  // though AlertsTab's own icon map (agent/driver-facing, which never
  // actually receives these admin-only types) already had icons defined
  // for all 5 — apparent copy/paste drift when those features were built.
  // Without this, each fell back to the generic "◈" diamond, including
  // SOS_ALERT — the one type where a distinctive icon matters most for an
  // admin scanning a notification list. Icons reused from AlertsTab's map.
  const ICONS = { TRIP_BOOKED: "📋", DRIVER_ASSIGNED: "🚗", TRIP_CONFIRMED: "🔔", IN_TRANSIT: "🚦", TRIP_COMPLETED: "🏁", DRIVER_FULLY_BOOKED: "⚠", TRIP_ACCEPTED: "✅", TRIP_DECLINED: "🚫", UPCOMING_TRIP: "⏰", LONG_DISTANCE_TRIP: "📏", LATE_BOOKING: "⏰", BRANCH_REASSIGNED_FAR: "📍", TRIP_CANCELLED: "✕", TICKET_OPENED: "🎫", TICKET_UPDATED: "🎫", BOOKING_EXCEPTION: "⚠", DRIVER_REMOVED: "🔄", TRIP_DELAY: "⏱", TRIP_UPDATED: "✎", ROUTE_EXCEEDS_POLICY: "📏", NO_SHOW: "🚫", TRIP_LATE_START: "⏰", LATE_CANCELLATION: "✕", DIRECT_MESSAGE: "💬", TRIP_DISPUTE: "⚠", APP_CRASH: "💥", DRIVER_DOCUMENT_EXPIRY: "📄", COMPLIANCE_DISTANCE: "📏", COMPLIANCE_OVERLOAD: "⚠", SOS_ALERT: "🚨", SPEED_ANOMALY: "⚡", ROUTE_DEVIATION: "📍", COMPANY_ANNOUNCEMENT: "📢", DRIVER_HOURS_WARNING: "⏳", DRIVER_SHIFT_DURATION_WARNING: "🛌", TRIP_UNASSIGNED_APPROACHING: "🚫", TRIP_STUCK_IN_TRANSIT: "🚦", TICKET_STALE: "🎫", DISPUTE_STALE: "⚠" };
  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>ALERTS</div>
          {unread > 0 && (
            <div style={{ fontSize: 10, color: COLORS.amber, marginTop: 2 }}>
              {unread} unread{filterDate && unreadInView !== unread ? ` (${unreadInView} on this day)` : ""}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {adminNotifsAll.length > 0 && (
            <Button title={selectMode ? "CANCEL" : "SELECT"} variant="ghost" size="sm" onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))} />
          )}
          {selectMode && adminNotifs.length > 0 && (
            <Button title={allSelected ? "DESELECT ALL" : "SELECT ALL"} variant="ghost" size="sm"
              onClick={() => setSelectedNotifIds(allSelected ? new Set() : new Set(adminNotifs.map(n => n.id)))} />
          )}
          {adminNotifs.length > 0 && !selectMode && (
            confirmingDeleteAll ? (
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: COLORS.chalk }}>Delete all {adminNotifs.length}?</span>
                <Button title="CANCEL" variant="ghost" size="sm" onClick={() => setConfirmingDeleteAll(false)} />
                <Button title={deletingNotifs ? "DELETING…" : `DELETE ALL ${adminNotifs.length}`} variant="danger" size="sm" onClick={deleteAllNotifs} disabled={deletingNotifs} loading={deletingNotifs} />
              </div>
            ) : (
              <Button title="🗑 DELETE ALL" variant="ghost" size="sm" onClick={() => setConfirmingDeleteAll(true)} />
            )
          )}
          {unread > 0 && !selectMode && !confirmingDeleteAll && <Button title={`CLEAR ALL${filterDate ? ` (${unread})` : ""}`} variant="ghost" size="sm" onClick={() => dispatch({ type: "NOTIF/MARK_ALL_READ", admin: true, actor_id: user.id }).catch(() => {})} />}
        </div>
      </div>
      {selectMode && selectedNotifIds.size > 0 && (
        confirmingDeleteNotifs ? (
          <div style={{ background: "rgba(232,58,58,.06)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 11, color: COLORS.chalk }}>Delete {selectedNotifIds.size} selected alert{selectedNotifIds.size !== 1 ? "s" : ""}? This can't be undone.</span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button title="CANCEL" variant="ghost" size="sm" style={{ flex: 1 }} onClick={() => setConfirmingDeleteNotifs(false)} />
              <Button title={deletingNotifs ? "DELETING…" : `DELETE ${selectedNotifIds.size}`} variant="danger" size="sm" style={{ flex: 1 }} onClick={deleteSelectedNotifs} disabled={deletingNotifs} loading={deletingNotifs} />
            </div>
          </div>
        ) : (
          <Button title={`🗑 DELETE ${selectedNotifIds.size} SELECTED`} variant="ghost" size="sm" onClick={() => setConfirmingDeleteNotifs(true)} style={{ alignSelf: "flex-start" }} />
        )
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <TextField label="Filter by day" type="date" value={filterDate} onChange={e => setFilterDate(e.target.value)} style={{ flex: 1 }} />
        {filterDate && <Button title="CLEAR FILTER" variant="ghost" size="sm" onClick={() => setFilterDate("")} />}
      </div>
      {filterDate && <div style={{ fontSize: 10, color: COLORS.ghost }}>{adminNotifs.length} alert{adminNotifs.length !== 1 ? "s" : ""} on this day</div>}
      {adminNotifs.length === 0 ? <Empty icon="◬" text={filterDate ? "No alerts on this day" : "No admin alerts"} /> : adminNotifs.map(n => (
        <div key={n.id} onClick={() => {
          if (selectMode) { toggleNotifSelect(n.id); return; }
          dispatch({ type: "NOTIF/MARK_READ", id: n.id }).catch(() => {});
          if (n.trip_id) onJumpToTrip?.(n.trip_id);
        }}
          style={{ cursor: "pointer", background: n.read ? COLORS.card : "rgba(245,166,35,.06)", border: `1px solid ${selectMode && selectedNotifIds.has(n.id) ? COLORS.amber : (n.read ? COLORS.wire : "rgba(245,166,35,.25)")}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {selectMode && (
              <span style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${selectedNotifIds.has(n.id) ? COLORS.amber : COLORS.wire}`, background: selectedNotifIds.has(n.id) ? COLORS.amber : "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, color: COLORS.ink, flexShrink: 0 }}>{selectedNotifIds.has(n.id) && "✓"}</span>
            )}
            <span style={{ fontSize: 14 }}>{ICONS[n.type] || "◈"}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.amber, letterSpacing: 1, textTransform: "uppercase", flex: 1 }}>{n.type.replace(/_/g, " ")}</span>
            {!n.read && <div style={{ width: 7, height: 7, borderRadius: 4, background: COLORS.amber }} />}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5 }}>{n.message}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 9, color: COLORS.dim }}>{n.ts}</div>
            {!selectMode && n.trip_id && <span style={{ fontSize: 9, color: COLORS.teal }}>→ View trip</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function AdminAIAssistant({ user }) {
  const [messages, setMessages] = useState([]); // [{ role: "user"|"assistant", content }]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  useEffect(() => { scrollRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const ask = async () => {
    const question = input.trim();
    if (!question || loading) return;
    setInput("");
    setError(null);
    const nextMessages = [...messages, { role: "user", content: question }];
    setMessages(nextMessages);
    setLoading(true);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-ops-assistant`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(_cachedSessionToken ? { Authorization: `Bearer ${_cachedSessionToken}` } : {}),
        },
        // Only the last few turns — matches the edge function's own cap,
        // no point sending more than it'll use.
        body: JSON.stringify({ question, history: nextMessages.slice(0, -1).slice(-6) }),
      });
      // This is a raw fetch to an edge function, not a supabase.from()
      // call — it doesn't go through the central global.fetch wrapper's
      // 401-retry/notifySessionExpired() handling, so that signal has to
      // be raised here explicitly. Without this, an admin whose token
      // expired mid-chat just saw a generic "Request failed (401)" error
      // bubble with no path back to a working session, unlike every other
      // screen in the app.
      if (res.status === 401 || res.status === 403) notifySessionExpired();
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setMessages(m => [...m, { role: "assistant", content: data.answer }]);
    } catch (e) {
      setError(e.message || "Couldn't reach the assistant — please try again.");
      // Roll back the optimistically-added question so a retry doesn't
      // duplicate it in the conversation history sent next time.
      setMessages(m => m.slice(0, -1));
      setInput(question);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>AI OPS ASSISTANT</div>
      <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2, marginBottom: 12 }}>
        Ask about today's active trips, driver status, or open tickets.
        Answers are generated from a live snapshot of current data only — not full trip history.
      </div>
      <Card style={{ display: "flex", flexDirection: "column", height: "60vh", minHeight: 360 }}>
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
          {messages.length === 0 ? (
            <Empty icon="🤖" text="Ask a question to get started, e.g. “which drivers are near their hours limit?”" />
          ) : messages.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              maxWidth: "85%", background: m.role === "user" ? "rgba(245,166,35,0.1)" : COLORS.surface,
              border: `1px solid ${m.role === "user" ? "rgba(245,166,35,0.3)" : COLORS.wire}`,
              borderRadius: 6, padding: "8px 12px", fontSize: 12, color: COLORS.chalk, whiteSpace: "pre-wrap",
            }}>
              {m.content}
            </div>
          ))}
          {loading && <div style={{ fontSize: 11, color: COLORS.ghost }}>Thinking…</div>}
          <div ref={scrollRef} />
        </div>
        {error && <div style={{ fontSize: 10, color: COLORS.red, marginTop: 8 }}>{error}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
            placeholder="Ask a question about live operations…"
            disabled={loading}
            style={{ flex: 1, background: COLORS.surface, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: "8px 10px", color: COLORS.chalk, fontSize: 12 }}
          />
          <Button title={loading ? "…" : "ASK"} onClick={ask} disabled={loading || !input.trim()} size="sm" />
        </div>
      </Card>
    </div>
  );
}

const ADMIN_NAV = [["dashboard", "◈", "Dashboard"], ["trips", "⊟", "All Bookings & Trips"], ["active", "🚦", "Active Trips"], ["dispatch", "⊕", "Dispatch"], ["map", "📍", "Live Map"], ["drivers", "◉", "Drivers"], ["users", "◐", "Users"], ["profiles", "🔍", "Search Profiles"], ["tickets", "🎫", "Tickets"], ["contacts", "💬", "Contacts"], ["history", "🕐", "History"], ["utilization", "📊", "Fleet Utilization"], ["activity", "📜", "Activity Log"], ["ai", "🤖", "AI Assistant"], ["portal", "🏢", "Client Portal"], ["notifs", "◬", "Alerts"]];

const ADMIN_LEVEL_LABEL = { FLEET_OPS: "Fleet Operations Administrator", STANDARD: "Control Admin", FINANCIAL: "Financial Administrator", VIEWER: "Viewer Administrator" };

export function AdminApp({ state, dispatch, user, notifClickHandlerRef }) {
  // Viewer Administrators don't get Dispatch or Users at all (per the
  // permission model — VIEWER has manageDispatch/manageAgentsDrivers/
  // manageAdmins all false), regardless of what tab they might try to
  // force via state — the tab content itself also checks permissions,
  // this just keeps the sidebar honest about what's actually usable.
  // Computed BEFORE the tab state below so a persisted/restored tab can
  // be validated against what THIS admin can actually see — restoring
  // someone into a tab their permissions no longer allow would show a
  // broken/blank screen instead of falling back to the default.
  const visibleNav = ADMIN_NAV.filter(([id]) => {
    // Note: VIEWER admins never reach AdminApp — they're routed to
    // ViewerPortal. Same for FINANCIAL — routed to FinancialPortal.
    if (id === "dispatch") return hasAdminPermission(user, "manageDispatch");
    if (id === "active") return hasAdminPermission(user, "manageDispatch");
    if (id === "users") return hasAdminPermission(user, "viewUsers");
    if (id === "contacts") return hasAdminPermission(user, "manageTrips");
    if (id === "utilization") return hasAdminPermission(user, "manageDispatch");
    if (id === "activity") return hasAdminPermission(user, "viewAuditLog");
    // Mirrors the ai-ops-assistant edge function's own server-side gate
    // (Fleet Ops/Standard only) — see that function's header comment.
    if (id === "ai") return hasAdminPermission(user, "manageDispatch");
    return true;
  });
  const [tab, setTab] = usePersistedTab("admin", user.id, "dashboard", visibleNav.map(t => t[0]));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isNarrow = useIsNarrowScreen();
  const notifCount = state.notifications.filter(n =>
    !n.read &&
    (n.for_roles?.includes(ROLE.ADMIN) || !n.for_roles?.length) &&
    (!n.for_user_ids?.length || n.for_user_ids.some(id => String(id) === String(user.id)))
  ).length;
  const call = useWebRTCCall(user);

  // Client-side half of the late-start warning, per explicit decision
  // (built alongside a server-side scheduled version too, so this gets
  // caught reliably even when nobody has the app open — see the
  // separate Edge Function package). Runs once immediately, then every
  // 10 minutes (widened from 5 — found via a dedicated API-call-volume
  // audit; these are compliance sweeps with hour-scale windows, not
  // something that needs sub-10-minute responsiveness, and every admin
  // session was independently running all five of these), so an admin
  // with the app open catches this without waiting on the server-side
  // schedule.
  //
  // TRIP/CHECK_UPCOMING_REMINDERS is now a ONE-SHOT-only dispatch below,
  // not repeated in the interval — same audit found this exact check was
  // ALSO independently repeating in every agent's and driver's own app
  // (see AgentApp/DriverApp), so N+M+K sessions were all redundantly
  // re-running the same global check every 5 minutes. Moved to a single
  // server-side cron (check-upcoming-reminders) that now runs it once,
  // reliably, regardless of who has the app open — this dispatch stays
  // only so an admin who just watched an agent enable REMIND sees instant
  // feedback rather than waiting up to 10 minutes for the cron.
  useEffect(() => {
    if (!supabase) return;
    dispatch({ type: "TRIP/CHECK_LATE_START" }).catch(() => {});
    dispatch({ type: "TRIP/CHECK_UPCOMING_REMINDERS" }).catch(() => {});
    // Document expiry is a fleet-wide compliance sweep (checks every
    // driver, not just the current session's own trips), so it belongs
    // here alongside the other admin-triggered periodic checks rather
    // than in every driver's own polling effect.
    dispatch({ type: "DRIVER/CHECK_DOCUMENT_EXPIRY" }).catch(() => {});
    dispatch({ type: "DRIVER/CHECK_HOURS_COMPLIANCE" }).catch(() => {});
    // Continuous-shift-duration compliance — see MAX_CONTINUOUS_SHIFT_HOURS'
    // own comment (TransitOS_web.jsx) for why this is a separate signal
    // from CHECK_HOURS_COMPLIANCE's cumulative trip-driving hours.
    dispatch({ type: "DRIVER/CHECK_SHIFT_DURATION" }).catch(() => {});
    // Same shape as CHECK_LATE_START — catches a booking that never even
    // got a driver, not just one whose confirmed driver hasn't started.
    dispatch({ type: "TRIP/CHECK_UNASSIGNED_APPROACHING" }).catch(() => {});
    // The other end of what CHECK_LATE_START covers — a trip that started
    // and never got marked complete.
    dispatch({ type: "TRIP/CHECK_STUCK_IN_TRANSIT" }).catch(() => {});
    // Re-escalation for tickets/disputes left open with no admin action —
    // previously fired one notification on open and never resurfaced.
    dispatch({ type: "TICKET/CHECK_STALE" }).catch(() => {});
    dispatch({ type: "TRIP/CHECK_STALE_DISPUTES" }).catch(() => {});
    const intervalId = setInterval(() => {
      dispatch({ type: "TRIP/CHECK_LATE_START" }).catch(() => {});
      dispatch({ type: "DRIVER/CHECK_DOCUMENT_EXPIRY" }).catch(() => {});
      dispatch({ type: "DRIVER/CHECK_HOURS_COMPLIANCE" }).catch(() => {});
      dispatch({ type: "DRIVER/CHECK_SHIFT_DURATION" }).catch(() => {});
      dispatch({ type: "TRIP/CHECK_UNASSIGNED_APPROACHING" }).catch(() => {});
      dispatch({ type: "TRIP/CHECK_STUCK_IN_TRANSIT" }).catch(() => {});
      dispatch({ type: "TICKET/CHECK_STALE" }).catch(() => {});
      dispatch({ type: "TRIP/CHECK_STALE_DISPUTES" }).catch(() => {});
    }, 10 * 60 * 1000);
    return () => clearInterval(intervalId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Tapping a notification about a specific trip now jumps straight to
  // it — mirrors the agent app's existing home-card-tap pattern.
  // Previously an admin notification only marked itself read and did
  // nothing else, even though most notification types already carry a
  // trip_id internally — reading "trip 87 booking exception" meant
  // manually going to All Bookings & Trips and finding it yourself.
  const [jumpTripId, setJumpTripId] = useState(null);

  // Register handler for NOTIFICATION_CLICKED messages from the
  // service worker — fired when a push notification is tapped. Routes
  // to the right screen: jump to the trip, switch to contacts for a
  // DM, or just bring the app to the right state for a call.
  useEffect(() => {
    if (!notifClickHandlerRef) return;
    notifClickHandlerRef.current = (data) => {
      if (data.tripId) {
        setJumpTripId(data.tripId);
        setTab("trips");
      } else if (data.notifType === "DIRECT_MESSAGE") {
        setTab("contacts");
      }
    };
    return () => { if (notifClickHandlerRef.current) notifClickHandlerRef.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifClickHandlerRef]);

  // A Viewer admin assigned to a specific company only sees that
  // company's agents (and whichever drivers actually serve them) and
  // trips — computed once here and threaded down to every tab, rather
  // than each screen re-deriving its own scoped view. Unscoped admins
  // (FLEET_OPS, STANDARD, or a Viewer with no company set) get the
  // identical state object back — scoping is strictly additive, it
  // never changes behavior for anyone it doesn't apply to.
  const scopedState = React.useMemo(() => {
    const adminCompanyIds = getAdminCompanyIds(user, state.companies);
    if (!adminCompanyIds.length) return state; // master admin or no restriction
    return {
      ...state,
      // Companies: admins only see their own company + its branches
      companies: (state.companies || []).filter(c => adminCompanyIds.some(id => String(id) === String(c.id))),
      users: scopeUsersToCompany(state.users, state.trips, adminCompanyIds),
      trips: scopeTripsToCompany(state.trips, state.users, adminCompanyIds),
      tickets: scopeTicketsToCompany(state.tickets, state.users, state.trips, adminCompanyIds),
      notifications: scopeNotificationsToCompany(state.notifications, state.trips, state.users, adminCompanyIds),
      driver_status: scopeDriverStatusToCompany(state.driver_status, state.trips, state.users, adminCompanyIds),
    };
  }, [state, user]);

  // Shared nav content — identical markup whether it's rendered as the
  // permanent wide-screen sidebar or the narrow-screen slide-in drawer,
  // so the two never drift apart into two different navs to maintain.
  const navContent = (
    <>
      <div style={{ padding: 16, borderBottom: `1px solid ${COLORS.wire}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <img src={LOGO_DATA_URI} alt="Pearce & Sons" style={{ height: 28, width: 28, objectFit: "contain" }} />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
          <RoleBadge role={ROLE.ADMIN} />
          {(() => {
            const adminIds = getAdminCompanyIds(user, state.companies);
            const isUnrestricted = adminIds.length === 0; // master or operator-scoped
            if (isUnrestricted) {
              return <span style={{ fontSize: 8, color: COLORS.amber, fontWeight: 700, letterSpacing: 0.5 }}>ALL COMPANIES</span>;
            }
            if (adminIds.length === 1) {
              const co = state.companies.find(c => String(c.id) === String(adminIds[0]));
              return <span style={{ fontSize: 8, color: COLORS.blue, fontWeight: 700, letterSpacing: 0.5 }}>{co?.name || "SCOPED"}</span>;
            }
            return <span style={{ fontSize: 8, color: COLORS.blue, fontWeight: 700, letterSpacing: 0.5 }} title={adminIds.map(id => state.companies.find(c=>String(c.id)===String(id))?.name||id).join(", ")}>{adminIds.length} COMPANIES</span>;
          })()}
        </div>
      </div>
      <div style={{ flex: 1, paddingTop: 12, overflowY: "auto" }}>
        {visibleNav.map(([id, icon, label]) => {
          const active = tab === id;
          const unreadDmCount = state.notifications.filter(n =>
            n.type === "DIRECT_MESSAGE" && !n.read && n.for_user_ids?.some(id => String(id) === String(user.id))
          ).length;
          const badge = id === "notifs" ? notifCount : id === "contacts" ? unreadDmCount : 0;
          return (
            <div key={id} onClick={() => { setTab(id); setDrawerOpen(false); }} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", cursor: "pointer", background: active ? "rgba(245,166,35,.06)" : "transparent", borderLeft: `2px solid ${active ? COLORS.amber : "transparent"}` }}>
              <span style={{ fontSize: 14, width: 16, textAlign: "center", color: COLORS.ghost }}>{icon}</span>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: active ? COLORS.amber : COLORS.ghost, flex: 1, textTransform: "uppercase" }}>{label}</span>
              {badge > 0 && <span style={{ background: COLORS.amber, borderRadius: 2, padding: "1px 5px", fontSize: 9, fontWeight: 800, color: "#000" }}>{badge}</span>}
            </div>
          );
        })}
      </div>
      <div style={{ padding: 16, borderTop: `1px solid ${COLORS.wire}`, display: "flex", flexDirection: "column", gap: 4 }}>
        <DriverAvatar name={user.name} size={32} />
        <span style={{ fontSize: 11, fontWeight: 700, marginTop: 6 }}>{user.name}</span>
        <span style={{ fontSize: 10, color: COLORS.ghost, marginBottom: 10 }}>{ADMIN_LEVEL_LABEL[user.admin_level] || "Administrator"}</span>
        <AlertSoundToggle />
        <BiometricEnrollButton user={user} />
        <Button title="LOGOUT" variant="ghost" size="sm" full onClick={() => dispatch({ type: "AUTH/LOGOUT" }).catch(() => {})} />
      </div>
    </>
  );

  const mainContent = (
    <div style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
      {tab === "dashboard" && <AdminDashboard state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "trips" && <AdminTrips state={scopedState} dispatch={dispatch} user={user} jumpTripId={jumpTripId} onJumpConsumed={() => setJumpTripId(null)} />}
      {tab === "active" && hasAdminPermission(user, "manageDispatch") && <AdminActiveTrips state={scopedState} />}
      {tab === "dispatch" && hasAdminPermission(user, "manageDispatch") && <AdminDispatch state={scopedState} dispatch={dispatch} />}
      {tab === "map" && <AdminLiveMap state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "drivers" && <AdminDrivers state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "users" && hasAdminPermission(user, "viewUsers") && <AdminUsers state={scopedState} dispatch={dispatch} user={user} />}
      {tab === "profiles" && <AdminProfileSearch state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "history" && <AdminHistory state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "utilization" && hasAdminPermission(user, "manageDispatch") && <AdminFleetUtilization state={scopedState} user={user} dispatch={dispatch} />}
      {tab === "activity" && hasAdminPermission(user, "viewAuditLog") && <AdminActivityLog />}
      {tab === "ai" && hasAdminPermission(user, "manageDispatch") && <AdminAIAssistant user={user} />}
      {tab === "portal" && <ClientPortalApp state={scopedState} dispatch={dispatch} user={{ ...user, is_master_client: isMasterAdmin(user, state.companies) }} />}
      {tab === "tickets" && <AdminTickets state={scopedState} dispatch={dispatch} user={user} />}
      {tab === "contacts" && hasAdminPermission(user, "manageTrips") && <AdminContacts state={scopedState} dispatch={dispatch} user={user} call={call} />}
      {tab === "notifs" && <AdminNotifs state={scopedState} user={user} dispatch={dispatch} onJumpToTrip={(tripId) => { setJumpTripId(tripId); setTab("trips"); }} />}
    </div>
  );

  if (!isNarrow) {
    // Wide screens: the original permanent sidebar, unchanged.
    return (
      <div style={{ display: "flex", minHeight: "100vh" }}>
        <div style={{ width: 220, flexShrink: 0, background: COLORS.panel, borderRight: `1px solid ${COLORS.wire}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
          {navContent}
        </div>
        {mainContent}
        <CallOverlay call={call} />
      </div>
    );
  }

  // Narrow (phone/tablet) screens: a compact top bar with a hamburger
  // button, and the same nav content sliding in as an overlay drawer
  // instead of permanently eating ~60% of a phone's width. This was the
  // single biggest mobile-usability gap in the admin app — a fixed
  // 220px sidebar left almost no room for content on a ~375px screen.
  const activeNavItem = visibleNav.find(([id]) => id === tab);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{
        position: "sticky", top: 0, zIndex: 40, background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`,
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
        paddingTop: "calc(12px + env(safe-area-inset-top, 0px))",
      }}>
        <button onClick={() => setDrawerOpen(true)} aria-label="Open menu" style={{ background: "transparent", border: `1px solid ${COLORS.wire}`, borderRadius: 4, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.chalk, fontSize: 16, flexShrink: 0 }}>
          ☰
        </button>
        <img src={LOGO_DATA_URI} alt="Pearce & Sons" style={{ height: 24, width: 24, objectFit: "contain", flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: COLORS.ghost, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {activeNavItem ? activeNavItem[2] : ""}
        </span>
        {notifCount > 0 && <span style={{ background: COLORS.amber, borderRadius: 2, padding: "1px 6px", fontSize: 9, fontWeight: 800, color: "#000", flexShrink: 0 }}>{notifCount}</span>}
      </div>
      {drawerOpen && (
        <>
          <div onClick={() => setDrawerOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: 49, animation: "fadeIn .15s ease" }} />
          <div style={{
            position: "fixed", top: 0, left: 0, bottom: 0, width: "min(280px, 84vw)", zIndex: 50,
            background: COLORS.panel, borderRight: `1px solid ${COLORS.wire}`, display: "flex", flexDirection: "column",
            paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)",
            boxShadow: "4px 0 24px rgba(0,0,0,.4)",
          }}>
            {navContent}
          </div>
        </>
      )}
      {mainContent}
      <CallOverlay call={call} />
    </div>
  );
}
