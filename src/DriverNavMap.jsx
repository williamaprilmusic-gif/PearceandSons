// Extracted from TransitOS_web.jsx into its own file so Leaflet (and this
// component) can be code-split out of the main bundle via React.lazy —
// this was the only place in the eagerly-loaded main chunk that pulled in
// Leaflet; AdminLiveMap (admin/AdminSection.jsx) uses its own hand-rolled
// SVG pan/zoom map, not Leaflet, and AdminSection.jsx itself is already
// lazy-loaded. Moving only this component (not the whole file) keeps the
// diff to exactly what needed to move — everything else it depends on
// stays in TransitOS_web.jsx, imported here the same way AdminSection.jsx
// already imports dozens of shared helpers from that file.
import { useState, useRef, useCallback, useEffect } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  COLORS, haversineKm, TOMTOM_API_KEY, TRAFFIC_INCIDENT_ICON, tomtomTrafficIncidents,
  tomtomNavRoute, HAZARD_CATEGORIES, HAZARD_CATEGORY_ICON,
} from "./TransitOS_web.jsx";

// Embedded in-app navigation — replaces the external Waze handoff for the
// driver's own active-navigation flow (see the memory note on this feature
// for the full architecture/fidelity decision: map + live position + text
// turn instructions, deliberately NOT voice guidance or full Waze parity,
// neither of which is realistically buildable in a web app).
// Deliberately remounts fresh every time the driver switches back to this
// tab (DriverNavTab conditionally mounts it, doesn't hide it via CSS) —
// simpler than caching state across mounts, avoids Leaflet's known
// zero-height-container gotcha from mounting behind display:none, and gets
// a genuinely fresh route/ETA each time rather than a stale cached one.
export function DriverNavMap({ destination, driverPosition, onExit, hazardReports, onReportHazard }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const routeLayerRef = useRef(null);
  const driverMarkerRef = useRef(null);
  const destMarkerRef = useRef(null);
  const hazardLayerRef = useRef(null);
  const trafficFlowLayerRef = useRef(null);
  const incidentLayerRef = useRef(null);
  const [route, setRoute] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentInstructionIdx, setCurrentInstructionIdx] = useState(0);
  const [followMode, setFollowMode] = useState(true);
  const [hazardReported, setHazardReported] = useState(false);
  const [showHazardPicker, setShowHazardPicker] = useState(false);
  // "Show traffic" toggle — defaults ON to match Waze's own always-on
  // traffic display, now that the TomTom Traffic product is confirmed
  // live on this account (see tomtomTrafficIncidents). Drives both the
  // colored flow-tile overlay and the incident markers together, since
  // the user's request treated "show traffic" as one concept.
  const [showTraffic, setShowTraffic] = useState(true);
  const [trafficIncidents, setTrafficIncidents] = useState([]);
  const lastRouteFetchAtRef = useRef(0);

  // Returns whether the fetch actually produced a route — the caller
  // (the effect below) needs this to know whether it's safe to leave
  // lastFetchedDestKeyRef pointing at this destination, or whether it
  // must clear it so a retry is possible. See that effect's own comment.
  const fetchRoute = useCallback(async (fromCoord) => {
    if (!fromCoord?.lat || !destination?.lat) return false;
    setLoading(true);
    setError(null);
    try {
      const r = await tomtomNavRoute(fromCoord, destination);
      if (!r) { setError("Couldn't calculate a route — check your connection."); return false; }
      setRoute(r);
      setCurrentInstructionIdx(0);
      lastRouteFetchAtRef.current = Date.now();
      return true;
    } catch (e) {
      setError(e.message || "Couldn't calculate a route.");
      return false;
    } finally {
      setLoading(false);
    }
  }, [destination?.lat, destination?.lng]);

  // Route fetch — both the initial one (once a starting GPS fix is
  // available) AND every subsequent one when `destination` itself changes.
  //
  // ROOT-CAUSE FIX — confirmed against a real production trip (multi-agent
  // OUTBOUND dropoffs at 3 genuinely different addresses): DriverNavTab
  // keeps ONE persistent <DriverNavMap> instance mounted across the whole
  // drop-off sequence (no `key` prop, so React reuses it and just updates
  // the `destination` prop each time confirmDropoff() advances navTarget
  // to the next stop) — it does NOT remount per stop. The old version of
  // this effect gated on `if (route) return`, i.e. "only ever fetch once,
  // no matter what" — so once the FIRST leg's route loaded, `route` was
  // permanently truthy and no later `destination` change ever triggered a
  // new fetch. The map, turn-by-turn instructions, and route polyline all
  // stayed frozen on the FIRST drop-off's route for the rest of the trip,
  // while `navTarget`/`destination` itself correctly advanced underneath —
  // a driver following the in-app nav would be silently kept on (or led
  // back toward) the first stop for every remaining drop-off. This is what
  // produced a real trip where all 3 agents' GPS-at-dropoff coordinates
  // landed at the same physical spot despite having 3 distinct addresses.
  //
  // Fixed by keying the fetch on a `destKey` fingerprint instead of "have
  // we ever fetched" — any change to destination now clears the stale
  // route immediately (so the UI shows "Calculating route…" for the new
  // leg rather than the previous leg's now-wrong route) and fetches fresh.
  const initialFetchInFlightRef = useRef(false);
  const lastFetchedDestKeyRef = useRef(null);
  useEffect(() => {
    if (!driverPosition?.lat || !destination?.lat) return;
    const destKey = `${destination.lat},${destination.lng}`;
    if (destKey === lastFetchedDestKeyRef.current || initialFetchInFlightRef.current) return;
    const isDestinationChange = lastFetchedDestKeyRef.current != null;
    lastFetchedDestKeyRef.current = destKey;
    initialFetchInFlightRef.current = true;
    if (isDestinationChange) {
      setRoute(null);
      setCurrentInstructionIdx(0);
    }
    // FOUND VIA A DEDICATED IMPROVEMENT AUDIT: lastFetchedDestKeyRef was
    // set to the new destKey unconditionally, BEFORE the fetch even
    // resolved — so a failed fetch (a brief signal drop right as a leg
    // starts, exactly this app's normal operating condition for a driver
    // on the road) permanently blocked any retry for that destination.
    // The guard above would keep bailing out on every later GPS tick
    // (driverPosition changes every few seconds while tracking is
    // active) since destKey still matched, leaving the driver stuck on
    // the red error banner with no recovery short of the destination
    // itself changing (advancing to the next stop). Clearing the ref on
    // a failed fetch lets the very next GPS tick retry automatically —
    // matches the Retry button below for immediate manual recovery too.
    fetchRoute(driverPosition).then(ok => {
      initialFetchInFlightRef.current = false;
      if (!ok) lastFetchedDestKeyRef.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverPosition?.lat, driverPosition?.lng, destination?.lat, destination?.lng, fetchRoute]);

  // Map init — once, on mount.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: false, attributionControl: true });
    map.setView([driverPosition?.lat || -33.9249, driverPosition?.lng || 18.4241], 15);
    L.tileLayer(`https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=${TOMTOM_API_KEY}`, {
      maxZoom: 22, attribution: "© TomTom",
    }).addTo(map);
    mapRef.current = map;
    // A driver manually panning/zooming turns off auto-follow, so the view
    // stops jumping back to their live position mid-look — the RECENTER
    // button below turns it back on.
    map.on("dragstart", () => setFollowMode(false));
    // Leaflet's classic zero-height-container gotcha — the flex layout
    // this mounts into may not have resolved its final height on the very
    // first paint, which Leaflet has no way to detect on its own.
    setTimeout(() => map.invalidateSize(), 100);
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle the colored traffic-flow tile overlay. Runs after the map-init
  // effect above in source order, so on first mount mapRef.current is
  // already set — same reasoning as the hazard-layer effect below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (showTraffic) {
      if (!trafficFlowLayerRef.current) {
        trafficFlowLayerRef.current = L.tileLayer(
          `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_API_KEY}`,
          { maxZoom: 22, opacity: 0.7 }
        );
      }
      trafficFlowLayerRef.current.addTo(map);
    } else if (trafficFlowLayerRef.current) {
      map.removeLayer(trafficFlowLayerRef.current);
    }
  }, [showTraffic]);

  // Fetch live traffic incidents (accidents/closures/jams/roadworks) in a
  // padded bounding box around the current route, refreshing periodically
  // since congestion changes faster than the route itself. Cleared
  // whenever traffic is toggled off or there's no route to bound around.
  useEffect(() => {
    if (!showTraffic || !route?.points?.length) { setTrafficIncidents([]); return; }
    let cancelled = false;
    const fetchIncidents = async () => {
      try {
        // Manual min/max loop rather than Math.min(...lats) — spreading a
        // dense polyline (a long route can carry tens of thousands of
        // TomTom points) as call arguments risks "Maximum call stack size
        // exceeded" in V8, which would silently stop traffic updates for
        // that leg since this runs inside a fire-and-forget interval.
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
        for (const p of route.points) {
          if (p.lat < minLat) minLat = p.lat;
          if (p.lat > maxLat) maxLat = p.lat;
          if (p.lng < minLng) minLng = p.lng;
          if (p.lng > maxLng) maxLng = p.lng;
        }
        const pad = 0.01; // ~1km buffer around the route
        const bounds = { minLat: minLat - pad, maxLat: maxLat + pad, minLng: minLng - pad, maxLng: maxLng + pad };
        const incidents = await tomtomTrafficIncidents(bounds);
        if (!cancelled) setTrafficIncidents(incidents);
      } catch (e) {
        console.warn("[DriverNavMap] traffic incident fetch failed:", e.message);
      }
    };
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 3 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTraffic, route]);

  // Draw/redraw live traffic-incident markers whenever the fetched list
  // changes. Same layer-group swap pattern as the hazard markers below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (incidentLayerRef.current) map.removeLayer(incidentLayerRef.current);
    const group = L.layerGroup();
    trafficIncidents.forEach(inc => {
      if (inc.lat == null || inc.lng == null) return;
      L.marker([inc.lat, inc.lng], {
        icon: L.divIcon({
          className: "", iconSize: [22, 22],
          html: `<div class="marker-pop" style="font-size:17px;line-height:22px;text-align:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))">${TRAFFIC_INCIDENT_ICON[inc.iconCategory] || "❗"}</div>`,
        }),
      }).bindPopup(
        `<b>${(inc.description || "").replace(/</g, "&lt;")}</b>` +
        (inc.from ? `<br>${inc.from.replace(/</g, "&lt;")}${inc.to ? " → " + inc.to.replace(/</g, "&lt;") : ""}` : "") +
        (inc.delaySec ? `<br><span style="opacity:.7">+${Math.round(inc.delaySec / 60)} min delay</span>` : "")
      ).addTo(group);
    });
    group.addTo(map);
    incidentLayerRef.current = group;
  }, [trafficIncidents]);

  // Draw/redraw driver-reported hazard markers whenever the list changes —
  // the in-house peer-to-peer alert system standing in for Waze's own
  // crowd-sourced reports, which have no accessible API for a third-party
  // app to pull from (Waze's only data-sharing program, the Connected
  // Citizens Program, is restricted to government transportation agencies
  // and isn't a real-time feed anyway — see project memory). Runs after
  // the map-init effect above in source order, so on first mount
  // mapRef.current is guaranteed to already be set by the time this runs,
  // same reasoning as the route-drawing effect right below.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (hazardLayerRef.current) map.removeLayer(hazardLayerRef.current);
    const group = L.layerGroup();
    (hazardReports || []).forEach(h => {
      if (h.lat == null || h.lng == null) return;
      const ageMin = Math.max(0, Math.round((Date.now() - h.created_at) / 60000));
      const ageLabel = ageMin < 60 ? `${ageMin}m ago` : `${Math.round(ageMin / 60)}h ago`;
      const isAdvisory = h.source === "admin";
      const catMeta = HAZARD_CATEGORIES.find(c => c.key === h.category);
      const markerIcon = isAdvisory ? "📢" : (HAZARD_CATEGORY_ICON[h.category] || "⚠️");
      L.marker([h.lat, h.lng], {
        icon: L.divIcon({
          className: "", iconSize: [26, 26],
          html: `<div class="marker-pop" style="font-size:20px;line-height:26px;text-align:center;filter:drop-shadow(0 1px 3px rgba(0,0,0,.6))">${markerIcon}</div>`,
        }),
      // Admin advisories show the actual message (an official company
      // communication, not a peer report) — driver hazard reports stay
      // anonymous per explicit decision, matching Waze's own reports,
      // which never name the reporter to other users. driver_id/
      // driver_name still get stored server-side either way (see
      // DRIVER/REPORT_HAZARD / ADMIN/POST_ROUTE_ADVISORY) for
      // accountability if ever needed, just not surfaced here.
      }).bindPopup(isAdvisory
        ? `<b>📢 Route Advisory</b><br>${h.note ? h.note.replace(/</g, "&lt;") : ""}<br><span style="opacity:.7">${ageLabel}</span>`
        : `<b>${markerIcon} ${catMeta?.label || "Hazard"} reported</b><br>${ageLabel}`
      ).addTo(group);
    });
    group.addTo(map);
    hazardLayerRef.current = group;
  }, [hazardReports]);

  // Draw/redraw the route line + destination pin whenever a route arrives.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !route?.points?.length) return;
    if (routeLayerRef.current) map.removeLayer(routeLayerRef.current);
    const latlngs = route.points.map(p => [p.lat, p.lng]);
    // opacity 0.85 here must match routeFadeIn's "to" keyframe value (see
    // global CSS) — the animation hands off to this static SVG attribute
    // once it finishes, so a mismatch would show as a visible opacity jump.
    routeLayerRef.current = L.polyline(latlngs, { color: "#2D8CF0", weight: 6, opacity: 0.85, className: "route-fade-in" }).addTo(map);
    // Move the existing pin rather than only ever placing it once — same
    // root cause as the route-fetch fix above: this instance persists
    // across the whole multi-stop drop-off sequence, so a stop-to-stop
    // destination change must actually relocate the marker, not leave it
    // stuck at the first stop while everything else moves on.
    if (destination?.lat) {
      if (destMarkerRef.current) {
        destMarkerRef.current.setLatLng([destination.lat, destination.lng]);
      } else {
        destMarkerRef.current = L.marker([destination.lat, destination.lng], {
          // glide-marker here too — this marker only ever calls
          // setLatLng() after creation (never setIcon()), so it doesn't
          // have the icon-recreation problem the driver marker had; the
          // CSS transition applies cleanly as-is.
          icon: L.divIcon({ className: "glide-marker", iconSize: [16, 16], html: `<div style="background:${COLORS.red};width:16px;height:16px;border-radius:50%;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>` }),
        }).addTo(map);
      }
    }
    map.fitBounds(routeLayerRef.current.getBounds(), { padding: [40, 40] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // Move (or create) the driver's own marker, and recenter while following.
  // Smooth glide between GPS ticks (per explicit request that the map
  // felt flat) — the marker is created ONCE, then subsequent ticks only
  // call setLatLng (Leaflet moves markers via an inline CSS transform on
  // the wrapper element, which .glide-marker's CSS transition now
  // animates) and rotate the EXISTING inner element directly, rather than
  // calling setIcon() every tick — setIcon() tears down and recreates the
  // marker's DOM node from scratch on every call, which would give the
  // browser a brand-new element with no "previous" position/rotation to
  // animate from, silently defeating the transition on every single tick.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !driverPosition?.lat) return;
    const latlng = [driverPosition.lat, driverPosition.lng];
    const heading = driverPosition.heading || 0;
    if (!driverMarkerRef.current) {
      // 3D-look nav puck (per explicit request, replacing the old flat
      // amber dot) — a static ground-shadow ellipse plus a gradient-shaded
      // car body for a glossy/raised look. The shadow is a SEPARATE layer
      // from the rotating car body: rotating a drop shadow along with
      // heading would swing it out to the side whenever the driver isn't
      // facing due north, which reads as broken rather than "3D." Only
      // the .car-rotate layer gets the heading transform — same glide
      // ("glide-marker" className, untouched) for position, just a
      // different inner structure than the old single-div marker, so the
      // rotate-on-tick code below now targets .car-rotate specifically
      // instead of the marker's firstElementChild.
      const icon = L.divIcon({
        className: "glide-marker", iconSize: [32, 32],
        html: `<div style="position:relative;width:32px;height:32px;">
          <div style="position:absolute;left:50%;top:22px;width:14px;height:5px;transform:translateX(-50%);border-radius:50%;background:radial-gradient(ellipse at center, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 75%);"></div>
          <div class="car-rotate" style="position:absolute;inset:0;transform:rotate(${heading}deg);transition:transform .4s ease;">
            <svg width="32" height="32" viewBox="0 0 32 32">
              <defs>
                <linearGradient id="navCarBody" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#FFD98A"/>
                  <stop offset="0.55" stop-color="${COLORS.amber}"/>
                  <stop offset="1" stop-color="${COLORS.amber2}"/>
                </linearGradient>
              </defs>
              <g transform="translate(16,16)">
                <path d="M0,-12 C3.5,-12 6.2,-9.7 6.5,-6.2 L7,3 C7,7.2 4.8,9.6 0,10 C-4.8,9.6 -7,7.2 -7,3 L-6.5,-6.2 C-6.2,-9.7 -3.5,-12 0,-12 Z" fill="url(#navCarBody)" stroke="#fff" stroke-width="1.5"/>
                <ellipse cx="-2" cy="-8" rx="2.4" ry="1.4" fill="#fff" opacity=".35"/>
                <path d="M-4.3,-6.3 C-4.3,-8.4 -2.4,-9.5 0,-9.5 C2.4,-9.5 4.3,-8.4 4.3,-6.3 L4,-1.8 L-4,-1.8 Z" fill="${COLORS.panel}" opacity=".88"/>
                <circle cx="-4.8" cy="-8.8" r="1" fill="#fff" opacity=".9"/>
                <circle cx="4.8" cy="-8.8" r="1" fill="#fff" opacity=".9"/>
              </g>
            </svg>
          </div>
        </div>`,
      });
      driverMarkerRef.current = L.marker(latlng, { icon }).addTo(map);
    } else {
      driverMarkerRef.current.setLatLng(latlng);
      const inner = driverMarkerRef.current.getElement()?.querySelector(".car-rotate");
      if (inner) inner.style.transform = `rotate(${heading}deg)`;
    }
    if (followMode) map.panTo(latlng, { animate: true });
  }, [driverPosition?.lat, driverPosition?.lng, driverPosition?.heading, followMode]);

  // Advance past each maneuver point the driver reaches, and re-route if
  // they've strayed far off the planned path. Simplified nearest-point
  // matching, not full route-snapping — matches the "text turn
  // instructions" fidelity this feature was deliberately scoped to.
  useEffect(() => {
    if (!route?.instructions?.length || !driverPosition?.lat) return;
    const PASS_THRESHOLD_KM = 0.04; // 40m — close enough to count as reached
    const REROUTE_THRESHOLD_KM = 0.4; // 400m off the planned route
    const REROUTE_COOLDOWN_MS = 30000;

    let idx = currentInstructionIdx;
    while (idx < route.instructions.length - 1) {
      const ins = route.instructions[idx];
      if (haversineKm(driverPosition.lat, driverPosition.lng, ins.lat, ins.lng) <= PASS_THRESHOLD_KM) idx++;
      else break;
    }
    if (idx !== currentInstructionIdx) setCurrentInstructionIdx(idx);

    let nearestKm = Infinity;
    for (const p of route.points) {
      const d = haversineKm(driverPosition.lat, driverPosition.lng, p.lat, p.lng);
      if (d < nearestKm) nearestKm = d;
      if (nearestKm <= REROUTE_THRESHOLD_KM) break;
    }
    if (nearestKm > REROUTE_THRESHOLD_KM && Date.now() - lastRouteFetchAtRef.current > REROUTE_COOLDOWN_MS) {
      fetchRoute(driverPosition);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driverPosition?.lat, driverPosition?.lng]);

  const currentInstruction = route?.instructions?.[currentInstructionIdx] || null;
  const distToNextKm = currentInstruction && driverPosition?.lat
    ? haversineKm(driverPosition.lat, driverPosition.lng, currentInstruction.lat, currentInstruction.lng) : null;
  const distToDestKm = driverPosition?.lat && destination?.lat
    ? haversineKm(driverPosition.lat, driverPosition.lng, destination.lat, destination.lng) : null;
  const fmtDist = (km) => km == null ? "—" : km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;

  // Current speed limit — live-verified against the real TomTom API
  // (sectionType=speedLimit on the same already-working routing call, no
  // extra account access needed — see tomtomNavRoute). Matches the
  // driver's live position to the nearest point on the route polyline,
  // then looks up which speed-limit section that point index falls
  // within. Recomputed fresh every render (driverPosition changes on
  // every GPS tick anyway) — a full scan of route.points is cheap at this
  // scale (typically a few hundred points for a single from→to leg).
  // Returns null (hides the badge) if the driver is genuinely off the
  // route entirely, matching the same 400m threshold used for rerouting.
  const currentSpeedLimitKmh = (() => {
    if (!route?.speedLimitSections?.length || !route?.points?.length || !driverPosition?.lat) return null;
    let nearestIdx = 0, nearestKm = Infinity;
    for (let i = 0; i < route.points.length; i++) {
      const d = haversineKm(driverPosition.lat, driverPosition.lng, route.points[i].lat, route.points[i].lng);
      if (d < nearestKm) { nearestKm = d; nearestIdx = i; }
    }
    if (nearestKm > 0.4) return null;
    const section = route.speedLimitSections.find(s => nearestIdx >= s.startPointIndex && nearestIdx <= s.endPointIndex);
    return section ? section.maxSpeedKmh : null;
  })();

  const MANEUVER_ICONS = {
    TURN_LEFT: "⬅", TURN_RIGHT: "➡", SHARP_LEFT: "↖", SHARP_RIGHT: "↗",
    BEAR_LEFT: "↖", BEAR_RIGHT: "↗", KEEP_LEFT: "↖", KEEP_RIGHT: "↗",
    STRAIGHT: "⬆", ARRIVE: "🏁", ARRIVE_LEFT: "🏁", ARRIVE_RIGHT: "🏁",
    ROUNDABOUT_CROSS: "↻", ROUNDABOUT_LEFT: "↻", ROUNDABOUT_RIGHT: "↻",
    UTURN_LEFT: "↩", UTURN_RIGHT: "↪",
  };

  return (
    <div style={{ position: "relative", height: "100%", minHeight: 320, display: "flex", flexDirection: "column" }}>
      <div ref={mapContainerRef} style={{ flex: 1, minHeight: 240, background: "#111" }} />
      {currentInstruction && (
        // key'd on the maneuver's identity so the slide-in animation
        // replays each time the CURRENT instruction actually changes
        // (a new turn), not just on this banner's first mount — without
        // a key React reuses the same DOM node across instruction
        // updates, and a CSS `animation` only ever plays once on an
        // element's initial insertion.
        <div key={`${currentInstructionIdx}-${currentInstruction.maneuver}`} className="nav-banner-in" style={{ position: "absolute", top: 10, left: 10, right: 54, background: "rgba(10,10,10,.92)", border: `1px solid ${COLORS.wire}`, borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, zIndex: 500 }}>
          <span style={{ fontSize: 26, flexShrink: 0 }}>{MANEUVER_ICONS[currentInstruction.maneuver] || "⬆"}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: COLORS.chalk }}>{currentInstruction.message}</div>
            {distToNextKm != null && <div style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>in {fmtDist(distToNextKm)}</div>}
          </div>
        </div>
      )}
      {/* Speed limit badge — standard real-road-sign styling (white disc,
          red ring, bold black number), positioned above the bottom control
          bar so it never overlaps either that or the top instruction
          banner. Hidden entirely when unknown/off-route rather than
          showing a stale or "—" placeholder. Key'd on the speed value so
          it pops in fresh each time the limit actually changes (a new
          road segment), not just on first appearance. */}
      {currentSpeedLimitKmh != null && (
        <div key={currentSpeedLimitKmh} className="badge-pop-in" style={{
          position: "absolute", bottom: 78, left: 10, zIndex: 500,
          width: 48, height: 48, borderRadius: "50%", background: "#fff", border: "5px solid #E23B3B",
          display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,.5)",
        }}>
          <span style={{ fontSize: 17, fontWeight: 800, color: "#111", lineHeight: 1 }}>{currentSpeedLimitKmh}</span>
        </div>
      )}
      <div style={{ position: "absolute", bottom: 10, left: 10, right: 10, display: "flex", gap: 8, zIndex: 500 }}>
        <div style={{ flex: 1, background: "rgba(10,10,10,.92)", border: `1px solid ${COLORS.wire}`, borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 9, color: COLORS.ghost, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{destination?.label || "Destination"}</div>
          <div style={{ fontSize: 14, fontWeight: 800, color: COLORS.chalk }}>
            {fmtDist(distToDestKm ?? route?.distanceKm)}
            {route?.etaMin != null && <span style={{ fontSize: 10, color: COLORS.ghost, fontWeight: 600 }}> · ~{route.etaMin} min</span>}
          </div>
        </div>
        {!followMode && (
          <button onClick={() => setFollowMode(true)} style={{ background: COLORS.amber, border: "none", borderRadius: 8, padding: "0 16px", color: "#000", fontWeight: 800, fontSize: 11, cursor: "pointer" }}>
            ⊙ RECENTER
          </button>
        )}
        {/* Two-tap hazard report, matching Waze's own report flow — tap
            the button to open a category icon picker, tap a category to
            submit immediately (no text entry, still safe to do without
            looking away from the road for more than an instant). */}
        {onReportHazard && (
          <div style={{ position: "relative" }}>
            {showHazardPicker && (
              <div style={{
                position: "absolute", bottom: "calc(100% + 8px)", right: 0,
                background: "rgba(10,10,10,.96)", border: `1px solid ${COLORS.wire}`, borderRadius: 10,
                padding: 8, display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end",
                width: "min(300px, calc(100vw - 24px))",
                boxShadow: "0 4px 16px rgba(0,0,0,.5)", zIndex: 700,
              }}>
                {HAZARD_CATEGORIES.map(c => (
                  <button
                    key={c.key}
                    onClick={() => {
                      onReportHazard(c.key);
                      setShowHazardPicker(false);
                      setHazardReported(true);
                      setTimeout(() => setHazardReported(false), 8000);
                    }}
                    style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, background: "none", border: "none", cursor: "pointer", padding: "5px 7px", borderRadius: 6 }}
                  >
                    <span style={{ fontSize: 22, lineHeight: 1 }}>{c.icon}</span>
                    <span style={{ fontSize: 8, color: COLORS.ghost, fontWeight: 700, whiteSpace: "nowrap" }}>{c.label}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              disabled={hazardReported || !driverPosition?.lat}
              onClick={() => setShowHazardPicker(v => !v)}
              style={{
                background: hazardReported ? "rgba(29,185,84,.15)" : showHazardPicker ? "rgba(245,166,35,.15)" : "rgba(10,10,10,.92)",
                border: `1px solid ${hazardReported ? COLORS.green : showHazardPicker ? COLORS.amber : COLORS.wire}`,
                borderRadius: 8, padding: "0 14px", color: hazardReported ? COLORS.green : COLORS.chalk,
                fontWeight: 800, fontSize: 11, cursor: hazardReported ? "default" : "pointer", whiteSpace: "nowrap",
              }}
            >
              {hazardReported ? "✓ REPORTED" : "⚠ REPORT"}
            </button>
          </div>
        )}
      </div>
      {loading && !route && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(10,10,10,.7)", zIndex: 600 }}>
          <span style={{ fontSize: 11, color: COLORS.ghost }}>Calculating route…</span>
        </div>
      )}
      {error && (
        <div style={{ position: "absolute", top: 10, left: 10, right: 54, background: "rgba(232,58,58,.15)", border: `1px solid ${COLORS.red}`, borderRadius: 8, padding: 10, zIndex: 500, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: 11, color: COLORS.red }}>{error}</span>
          {driverPosition?.lat && (
            <button
              onClick={() => { lastFetchedDestKeyRef.current = null; fetchRoute(driverPosition); }}
              style={{ flexShrink: 0, background: COLORS.red, color: "#fff", border: "none", borderRadius: 4, padding: "5px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}
            >RETRY</button>
          )}
        </div>
      )}
      <button
        onClick={() => setShowTraffic(s => !s)}
        title={showTraffic ? "Hide traffic" : "Show traffic"}
        style={{
          position: "absolute", top: 10, right: onExit ? 54 : 10,
          background: showTraffic ? "rgba(45,140,240,.25)" : "rgba(10,10,10,.85)",
          border: `1px solid ${showTraffic ? COLORS.blue : COLORS.wire}`,
          borderRadius: 20, width: 34, height: 34, fontSize: 15, cursor: "pointer", zIndex: 500,
        }}
      >
        🚦
      </button>
      {onExit && (
        <button onClick={onExit} style={{ position: "absolute", top: 10, right: 10, background: "rgba(10,10,10,.85)", border: `1px solid ${COLORS.wire}`, borderRadius: 20, width: 34, height: 34, color: COLORS.chalk, fontSize: 16, cursor: "pointer", zIndex: 500 }}>
          ✕
        </button>
      )}
    </div>
  );
}
