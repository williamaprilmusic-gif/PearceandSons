import React, { useState, useReducer, useEffect, useRef, useCallback } from "react";

/* ============================================================
   TransitOS — Corporate Transport Operations Platform (Web)
   Converted from the React Native version back to standard web
   React: View/Text/Pressable -> div/span/button, StyleSheet ->
   CSS-in-JS via a single injected <style> block, react-navigation
   -> simple useState-driven view switching, Waze Linking ->
   window.open, Supabase RN client -> Supabase JS web client.
   ============================================================ */

/* ---------- THEME ---------- */
const COLORS = {
  ink: "#0A0C0F", panel: "#0E1117", surface: "#141820", card: "#1A1F2A",
  rim: "#252D3A", wire: "#2E3847", dim: "#3D4A5C", ghost: "#4E5F74",
  mist: "#8B9BAF", fog: "#B0BEC8", chalk: "#D8E2EC", white: "#EEF2F7",
  amber: "#F5A623", amber2: "#E8911A", green: "#1DB954", green2: "#17A346",
  red: "#E83A3A", red2: "#C22E2E", blue: "#2D8CF0", blue2: "#1A6FCC",
  purple: "#7C4DFF", teal: "#00BCD4", black: "#000000",
};
const FONTS = { mono: "'JetBrains Mono', 'Courier New', monospace", head: "'Rajdhani', 'Arial Narrow', sans-serif" };

const STATE_BADGE_MAP = {
  UNASSIGNED_BOOKING: { bg: "rgba(78,95,116,0.2)",   fg: COLORS.ghost,  border: COLORS.wire,             label: "UNASSIGNED" },
  ASSIGNED:           { bg: "rgba(45,140,240,0.15)", fg: COLORS.blue,   border: "rgba(45,140,240,0.3)",  label: "ASSIGNED" },
  DRIVER_CONFIRMED:   { bg: "rgba(124,77,255,0.15)", fg: COLORS.purple, border: "rgba(124,77,255,0.3)",  label: "CONFIRMED" },
  IN_TRANSIT:         { bg: "rgba(245,166,35,0.15)", fg: COLORS.amber,  border: "rgba(245,166,35,0.3)",  label: "IN TRANSIT" },
  ARCHIVED_COMPLETED: { bg: "rgba(29,185,84,0.15)",  fg: COLORS.green,  border: "rgba(29,185,84,0.3)",   label: "ARCHIVED" },
  AVAILABLE:          { bg: "rgba(29,185,84,0.12)",  fg: COLORS.green,  border: "rgba(29,185,84,0.25)",  label: "AVAILABLE" },
  BUSY:               { bg: "rgba(245,166,35,0.12)", fg: COLORS.amber,  border: "rgba(245,166,35,0.25)", label: "BUSY" },
  FULLY_BOOKED:       { bg: "rgba(232,58,58,0.15)",  fg: COLORS.red,    border: "rgba(232,58,58,0.3)",   label: "FULLY BOOKED" },
};
const ROLE_BADGE_MAP = {
  ADMIN:  { bg: "rgba(124,77,255,0.15)", fg: COLORS.purple, border: "rgba(124,77,255,0.3)" },
  AGENT:  { bg: "rgba(45,140,240,0.15)", fg: COLORS.blue,   border: "rgba(45,140,240,0.3)" },
  DRIVER: { bg: "rgba(245,166,35,0.15)", fg: COLORS.amber,  border: "rgba(245,166,35,0.3)" },
};

const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { height: 100%; background: ${COLORS.ink}; }
body { font-family: ${FONTS.mono}; color: ${COLORS.chalk}; -webkit-font-smoothing: antialiased; }
button { font-family: inherit; cursor: pointer; }
input, select, textarea { font-family: inherit; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: ${COLORS.wire}; border-radius: 4px; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }

.app-root { min-height: 100vh; background: ${COLORS.ink}; }
.screen { min-height: 100vh; background: ${COLORS.ink}; display: flex; flex-direction: column; }
.pad { padding: 16px; display: flex; flex-direction: column; gap: 14px; max-width: 720px; width: 100%; margin: 0 auto; padding-bottom: 60px; }

.btn { border: 1px solid; border-radius: 4px; padding: 10px 16px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; transition: opacity .12s; }
.btn:hover { opacity: .88; }
.btn:disabled { opacity: .3; cursor: not-allowed; }
.btn-sm { padding: 7px 12px; font-size: 10px; }
.btn-full { width: 100%; }
.btn-amber  { background: ${COLORS.amber};  border-color: ${COLORS.amber2}; color: ${COLORS.ink}; }
.btn-green  { background: ${COLORS.green};  border-color: ${COLORS.green2}; color: ${COLORS.ink}; }
.btn-red, .btn-danger { background: ${COLORS.red}; border-color: ${COLORS.red2}; color: ${COLORS.white}; }
.btn-ghost  { background: transparent; border-color: ${COLORS.wire}; color: ${COLORS.fog}; }
.btn-blue   { background: ${COLORS.blue}; border-color: ${COLORS.blue2}; color: ${COLORS.white}; }
.btn-purple { background: ${COLORS.purple}; border-color: #6a3de8; color: ${COLORS.white}; }
.btn-waze   { background: #00CCFF; border-color: #00AAFF; color: #000; }

.card { background: ${COLORS.card}; border: 1px solid ${COLORS.wire}; border-radius: 4px; overflow: hidden; }
.card-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }

.field { display: flex; flex-direction: column; gap: 5px; }
.field-label { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; color: ${COLORS.mist}; text-transform: uppercase; }
.inp { background: ${COLORS.card}; border: 1px solid ${COLORS.wire}; border-radius: 3px; padding: 10px 12px; color: ${COLORS.chalk}; font-size: 12px; font-family: ${FONTS.mono}; outline: none; }
.inp:focus { border-color: ${COLORS.amber}; }
.inp.err { border-color: ${COLORS.red}; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

.state-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 2px; border: 1px solid; font-size: 9px; font-weight: 700; letter-spacing: 1.2px; font-family: ${FONTS.mono}; text-transform: uppercase; width: fit-content; }
.state-dot { width: 5px; height: 5px; border-radius: 3px; }
.role-badge { padding: 2px 7px; border-radius: 2px; border: 1px solid; font-size: 9px; font-weight: 700; letter-spacing: 1.5px; font-family: ${FONTS.mono}; width: fit-content; }

.sec-hdr { display: flex; align-items: center; gap: 10px; margin: 4px 0; }
.sec-hdr-txt { font-size: 9px; font-weight: 700; letter-spacing: 2px; color: ${COLORS.dim}; font-family: ${FONTS.mono}; text-transform: uppercase; white-space: nowrap; }
.sec-hdr-line { flex: 1; height: 1px; background: ${COLORS.wire}; }

.empty { display: flex; flex-direction: column; align-items: center; padding: 36px 0; gap: 10px; }
.empty-ico { font-size: 28px; opacity: .2; }
.empty-txt { font-size: 11px; color: ${COLORS.ghost}; letter-spacing: 1px; }

.gps-block { background: ${COLORS.surface}; border: 1px solid ${COLORS.wire}; border-radius: 3px; padding: 10px; display: flex; flex-direction: column; gap: 5px; }
.gps-row { display: flex; gap: 8px; font-size: 10px; }
.gps-key { color: ${COLORS.ghost}; width: 28px; }
.gps-val { color: ${COLORS.chalk}; }

.driver-av { background: ${COLORS.surface}; border: 1px solid ${COLORS.wire}; display: flex; align-items: center; justify-content: center; border-radius: 4px; font-family: ${FONTS.head}; font-weight: 700; color: ${COLORS.amber}; flex-shrink: 0; }

.cap-wrap { display: flex; flex-direction: column; gap: 4px; }
.cap-label-row { display: flex; justify-content: space-between; font-size: 9px; font-family: ${FONTS.mono}; }
.cap-track { height: 8px; background: ${COLORS.surface}; border-radius: 4px; overflow: hidden; border: 1px solid ${COLORS.wire}; }
.cap-fill { height: 100%; border-radius: 4px; transition: width .2s; }

.toast-stack { position: fixed; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 8px; width: 300px; z-index: 999; }
.toast { background: ${COLORS.card}; border: 1px solid ${COLORS.wire}; border-left: 3px solid; border-radius: 4px; padding: 12px; animation: fadeIn .2s ease; }
.toast-title { font-size: 11px; font-weight: 700; color: ${COLORS.chalk}; }
.toast-body { font-size: 10px; color: ${COLORS.mist}; margin-top: 3px; }

.loading-screen { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: ${COLORS.ink}; }
.spinner { width: 32px; height: 32px; border: 3px solid ${COLORS.wire}; border-top-color: ${COLORS.amber}; border-radius: 50%; animation: spin .8s linear infinite; }
`;

/* ---------- DATA LAYER (enums, state machine, address DB, geo helpers) ---------- */
// src/data/constants.js
// Enums, state machine, geo helpers, and the Cape Town address database.
// This file is pure JS — ported byte-for-byte from the web app's
// SECTION 1, 2, 4 (no DOM/CSS dependency existed there to begin with).

const ROLE = Object.freeze({ ADMIN: "ADMIN", AGENT: "AGENT", DRIVER: "DRIVER" });

const TRIP_STATE = Object.freeze({
  UNASSIGNED_BOOKING: "UNASSIGNED_BOOKING",
  ASSIGNED:           "ASSIGNED",
  DRIVER_CONFIRMED:   "DRIVER_CONFIRMED",
  IN_TRANSIT:         "IN_TRANSIT",
  ARCHIVED_COMPLETED: "ARCHIVED_COMPLETED",
});

const DRIVER_STATE = Object.freeze({ AVAILABLE: "AVAILABLE", BUSY: "BUSY" });

const DRIVER_CAPACITY = 4;
const CAPACITY_WARN_PCT = 0.75;

// ── State machine ──
const TRIP_TRANSITIONS = {
  // NOTE: ASSIGNED is a reserved intermediate state — the current reducer
  // (TRIP/ASSIGN_DRIVER) auto-confirms and jumps straight to DRIVER_CONFIRMED,
  // so ASSIGNED is never actually produced today. Kept in the state machine
  // and UI checks (StateBadge, active-trip filters) for forward compatibility
  // if a manual "awaiting driver confirmation" step is reintroduced later.
  [TRIP_STATE.UNASSIGNED_BOOKING]: [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED],
  [TRIP_STATE.ASSIGNED]:           [TRIP_STATE.DRIVER_CONFIRMED],
  [TRIP_STATE.DRIVER_CONFIRMED]:   [TRIP_STATE.IN_TRANSIT],
  [TRIP_STATE.IN_TRANSIT]:         [TRIP_STATE.ARCHIVED_COMPLETED],
  [TRIP_STATE.ARCHIVED_COMPLETED]: [],
};

function assertTripTransition(from, to) {
  if (!TRIP_TRANSITIONS[from] || !TRIP_TRANSITIONS[from].includes(to)) {
    throw new Error(`[SM] Trip: ${from} → ${to} ILLEGAL`);
  }
}

// ── Company drop-off locations ──
const COMPANY_LOCATIONS = [
  { id: "TELUS_MAITLAND",  label: "Telus Maitland",  address: "Maitland, Cape Town",  lat: -33.9302, lng: 18.4950, area: "Maitland",  isCompany: true },
  { id: "TELUS_WOODSTOCK", label: "Telus Woodstock", address: "Woodstock, Cape Town", lat: -33.9240, lng: 18.4430, area: "Woodstock", isCompany: true },
];

// ── Cape Town address database ──
const CPT_ADDRESS_DB = [
  // ── CBD / City Bowl ──
  { label: "Adderley Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9258, lng: 18.4232 },
  { label: "Buitenkant Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9310, lng: 18.4255 },
  { label: "Bree Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9235, lng: 18.4195 },
  { label: "Loop Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9225, lng: 18.4188 },
  { label: "Long Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9228, lng: 18.4192 },
  { label: "Wale Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9218, lng: 18.4168 },
  { label: "Strand Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9200, lng: 18.4215 },
  { label: "Thibault Square, Cape Town CBD", area: "Cape Town CBD", lat: -33.9255, lng: 18.4250 },
  { label: "Longmarket Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9245, lng: 18.4210 },
  { label: "Shortmarket Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9240, lng: 18.4200 },
  { label: "St Georges Mall, Cape Town CBD", area: "Cape Town CBD", lat: -33.9248, lng: 18.4228 },
  { label: "Parliament Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9265, lng: 18.4238 },
  { label: "Hout Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9230, lng: 18.4178 },
  { label: "Burg Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9242, lng: 18.4222 },
  { label: "Riebeeck Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9170, lng: 18.4225 },
  { label: "Castle Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9265, lng: 18.4255 },
  { label: "Darling Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9270, lng: 18.4245 },
  { label: "Plein Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9275, lng: 18.4225 },
  { label: "Roeland Street, Cape Town CBD", area: "Cape Town CBD", lat: -33.9300, lng: 18.4215 },
  // ── Gardens / Tamboerskloof / Sea Point ──
  { label: "Kloof Street, Gardens", area: "Gardens", lat: -33.9275, lng: 18.4182 },
  { label: "Orange Street, Gardens", area: "Gardens", lat: -33.9295, lng: 18.4145 },
  { label: "Government Avenue, Gardens", area: "Gardens", lat: -33.9285, lng: 18.4170 },
  { label: "Hatfield Street, Gardens", area: "Gardens", lat: -33.9300, lng: 18.4150 },
  { label: "Mill Street, Gardens", area: "Gardens", lat: -33.9320, lng: 18.4135 },
  { label: "Annandale Road, Gardens", area: "Gardens", lat: -33.9340, lng: 18.4090 },
  { label: "Upper Kloof Street, Tamboerskloof", area: "Tamboerskloof", lat: -33.9260, lng: 18.4170 },
  { label: "Park Road, Tamboerskloof", area: "Tamboerskloof", lat: -33.9290, lng: 18.4090 },
  { label: "Belvedere Avenue, Tamboerskloof", area: "Tamboerskloof", lat: -33.9320, lng: 18.4070 },
  { label: "De Lorentz Street, Tamboerskloof", area: "Tamboerskloof", lat: -33.9300, lng: 18.4110 },
  { label: "Camp Street, Tamboerskloof", area: "Tamboerskloof", lat: -33.9285, lng: 18.4145 },
  { label: "Regent Road, Sea Point", area: "Sea Point", lat: -33.9102, lng: 18.3888 },
  { label: "Main Road, Sea Point", area: "Sea Point", lat: -33.9115, lng: 18.3895 },
  { label: "High Level Road, Sea Point", area: "Sea Point", lat: -33.9085, lng: 18.3860 },
  { label: "Arthurs Road, Sea Point", area: "Sea Point", lat: -33.9145, lng: 18.3920 },
  { label: "Queens Road, Sea Point", area: "Sea Point", lat: -33.9180, lng: 18.3870 },
  { label: "Glengariff Road, Sea Point", area: "Sea Point", lat: -33.9120, lng: 18.3900 },
  { label: "Church Street, Sea Point", area: "Sea Point", lat: -33.9160, lng: 18.3930 },
  { label: "Springbok Road, Three Anchor Bay", area: "Three Anchor Bay", lat: -33.9080, lng: 18.3960 },
  // ── Green Point / De Waterkant / Mouille Point ──
  { label: "Somerset Road, Green Point", area: "Green Point", lat: -33.9055, lng: 18.4065 },
  { label: "Main Road, Green Point", area: "Green Point", lat: -33.9075, lng: 18.4020 },
  { label: "Three Anchor Bay Road, Green Point", area: "Green Point", lat: -33.9090, lng: 18.3990 },
  { label: "Fritz Sonnenberg Road, Green Point", area: "Green Point", lat: -33.9060, lng: 18.4045 },
  { label: "Hudson Street, De Waterkant", area: "De Waterkant", lat: -33.9190, lng: 18.4185 },
  { label: "Waterkant Street, De Waterkant", area: "De Waterkant", lat: -33.9195, lng: 18.4192 },
  { label: "Beach Road, Mouille Point", area: "Mouille Point", lat: -33.9020, lng: 18.4020 },
  // ── Bo-Kaap ──
  { label: "Wale Street, Bo-Kaap", area: "Bo-Kaap", lat: -33.9215, lng: 18.4128 },
  { label: "Chiappini Street, Bo-Kaap", area: "Bo-Kaap", lat: -33.9210, lng: 18.4118 },
  // ── Woodstock ──
  { label: "Victoria Road, Woodstock", area: "Woodstock", lat: -33.9238, lng: 18.4435 },
  { label: "Albert Road, Woodstock", area: "Woodstock", lat: -33.9242, lng: 18.4468 },
  { label: "Sir Lowry Road, Woodstock", area: "Woodstock", lat: -33.9255, lng: 18.4390 },
  { label: "Prince George Drive, Woodstock", area: "Woodstock", lat: -33.9260, lng: 18.4420 },
  { label: "Broadway, Woodstock", area: "Woodstock", lat: -33.9245, lng: 18.4455 },
  { label: "Roger Street, Woodstock", area: "Woodstock", lat: -33.9250, lng: 18.4480 },
  { label: "Tennant Street, Woodstock", area: "Woodstock", lat: -33.9220, lng: 18.4460 },
  { label: "Chapel Street, Woodstock", area: "Woodstock", lat: -33.9265, lng: 18.4445 },
  { label: "Aberdeen Street, Woodstock", area: "Woodstock", lat: -33.9255, lng: 18.4470 },
  // ── Salt River ──
  { label: "Lower Main Road, Salt River", area: "Salt River", lat: -33.9302, lng: 18.4793 },
  { label: "Upper Durban Road, Salt River", area: "Salt River", lat: -33.9295, lng: 18.4810 },
  { label: "Malta Road, Salt River", area: "Salt River", lat: -33.9315, lng: 18.4800 },
  { label: "Durham Avenue, Salt River", area: "Salt River", lat: -33.9310, lng: 18.4815 },
  { label: "Voortrekker Road, Salt River", area: "Salt River", lat: -33.9280, lng: 18.4830 },
  { label: "Foundry Road, Salt River", area: "Salt River", lat: -33.9320, lng: 18.4790 },
  { label: "Imam Haron Road, Salt River", area: "Salt River", lat: -33.9290, lng: 18.4805 },
  // ── Observatory ──
  { label: "Lower Main Road, Observatory", area: "Observatory", lat: -33.9380, lng: 18.4718 },
  { label: "Main Road, Observatory", area: "Observatory", lat: -33.9400, lng: 18.4710 },
  { label: "Station Road, Observatory", area: "Observatory", lat: -33.9392, lng: 18.4725 },
  { label: "Trill Road, Observatory", area: "Observatory", lat: -33.9405, lng: 18.4735 },
  { label: "Nuttall Road, Observatory", area: "Observatory", lat: -33.9385, lng: 18.4700 },
  { label: "Chapel Street, Observatory", area: "Observatory", lat: -33.9410, lng: 18.4715 },
  { label: "Anson Street, Observatory", area: "Observatory", lat: -33.9395, lng: 18.4730 },
  { label: "Milner Road, Observatory", area: "Observatory", lat: -33.9420, lng: 18.4690 },
  // ── Mowbray / Rosebank ──
  { label: "Main Road, Mowbray", area: "Mowbray", lat: -33.9510, lng: 18.4740 },
  { label: "Durban Road, Mowbray", area: "Mowbray", lat: -33.9498, lng: 18.4750 },
  { label: "Forest Road, Mowbray", area: "Mowbray", lat: -33.9490, lng: 18.4760 },
  { label: "St Andrews Road, Mowbray", area: "Mowbray", lat: -33.9520, lng: 18.4720 },
  { label: "Liesbeek Parkway, Rosebank", area: "Rosebank", lat: -33.9540, lng: 18.4690 },
  // ── Rondebosch ──
  { label: "Main Road, Rondebosch", area: "Rondebosch", lat: -33.9600, lng: 18.4730 },
  { label: "High Street, Rondebosch", area: "Rondebosch", lat: -33.9590, lng: 18.4718 },
  { label: "Campground Road, Rondebosch", area: "Rondebosch", lat: -33.9605, lng: 18.4745 },
  { label: "Belmont Road, Rondebosch", area: "Rondebosch", lat: -33.9620, lng: 18.4700 },
  { label: "Lower Campground Road, Rondebosch", area: "Rondebosch", lat: -33.9610, lng: 18.4750 },
  { label: "Klipfontein Road, Rondebosch", area: "Rondebosch", lat: -33.9580, lng: 18.4830 },
  // ── Newlands ──
  { label: "Newlands Avenue, Newlands", area: "Newlands", lat: -33.9700, lng: 18.4640 },
  { label: "Dean Street, Newlands", area: "Newlands", lat: -33.9715, lng: 18.4658 },
  { label: "Sandown Road, Newlands", area: "Newlands", lat: -33.9730, lng: 18.4620 },
  { label: "Kildare Road, Newlands", area: "Newlands", lat: -33.9690, lng: 18.4670 },
  // ── Claremont ──
  { label: "Main Road, Claremont", area: "Claremont", lat: -33.9858, lng: 18.4651 },
  { label: "Grove Avenue, Claremont", area: "Claremont", lat: -33.9845, lng: 18.4635 },
  { label: "Protea Road, Claremont", area: "Claremont", lat: -33.9862, lng: 18.4665 },
  { label: "Rosmead Avenue, Claremont", area: "Claremont", lat: -33.9848, lng: 18.4648 },
  { label: "Lansdowne Road, Claremont", area: "Claremont", lat: -33.9870, lng: 18.4690 },
  { label: "Dreyer Street, Claremont", area: "Claremont", lat: -33.9830, lng: 18.4640 },
  { label: "Aurora Street, Claremont", area: "Claremont", lat: -33.9855, lng: 18.4670 },
  { label: "Wilton Road, Claremont", area: "Claremont", lat: -33.9840, lng: 18.4655 },
  // ── Kenilworth ──
  { label: "Main Road, Kenilworth", area: "Kenilworth", lat: -33.9820, lng: 18.4750 },
  { label: "Rosmead Avenue, Kenilworth", area: "Kenilworth", lat: -33.9830, lng: 18.4762 },
  { label: "Heath Road, Kenilworth", area: "Kenilworth", lat: -33.9850, lng: 18.4775 },
  { label: "Royal Road, Kenilworth", area: "Kenilworth", lat: -33.9805, lng: 18.4730 },
  // ── Wynberg ──
  { label: "Main Road, Wynberg", area: "Wynberg", lat: -33.9958, lng: 18.4673 },
  { label: "Church Street, Wynberg", area: "Wynberg", lat: -33.9952, lng: 18.4665 },
  { label: "Wetton Road, Wynberg", area: "Wynberg", lat: -33.9942, lng: 18.4680 },
  { label: "Wolfe Street, Wynberg", area: "Wynberg", lat: -33.9975, lng: 18.4690 },
  { label: "Brodie Road, Wynberg", area: "Wynberg", lat: -33.9930, lng: 18.4650 },
  // ── Plumstead / Southfield / Diep River ──
  { label: "Wetton Road, Plumstead", area: "Plumstead", lat: -34.0000, lng: 18.4780 },
  { label: "Main Road, Plumstead", area: "Plumstead", lat: -34.0030, lng: 18.4760 },
  { label: "Victoria Road, Plumstead", area: "Plumstead", lat: -34.0050, lng: 18.4790 },
  { label: "Southfield Road, Southfield", area: "Southfield", lat: -33.9950, lng: 18.5000 },
  { label: "Main Road, Diep River", area: "Diep River", lat: -34.0220, lng: 18.4640 },
  { label: "Belvedere Road, Diep River", area: "Diep River", lat: -34.0250, lng: 18.4660 },
  // ── Pinelands ──
  { label: "Howard Drive, Pinelands", area: "Pinelands", lat: -33.9302, lng: 18.5050 },
  { label: "Jan Smuts Drive, Pinelands", area: "Pinelands", lat: -33.9310, lng: 18.5065 },
  { label: "Wilfred Street, Pinelands", area: "Pinelands", lat: -33.9318, lng: 18.5042 },
  { label: "Forest Drive, Pinelands", area: "Pinelands", lat: -33.9340, lng: 18.5080 },
  { label: "Central Square, Pinelands", area: "Pinelands", lat: -33.9355, lng: 18.5025 },
  // ── Maitland ──
  { label: "Voortrekker Road, Maitland", area: "Maitland", lat: -33.9320, lng: 18.5000 },
  { label: "Howard Drive, Maitland", area: "Maitland", lat: -33.9315, lng: 18.5018 },
  { label: "Albert Road, Maitland", area: "Maitland", lat: -33.9290, lng: 18.4990 },
  // ── Goodwood / Parow ──
  { label: "Voortrekker Road, Goodwood", area: "Goodwood", lat: -33.9050, lng: 18.5500 },
  { label: "Vasco Boulevard, Goodwood", area: "Goodwood", lat: -33.9080, lng: 18.5480 },
  { label: "Uitsig Road, Goodwood", area: "Goodwood", lat: -33.9020, lng: 18.5540 },
  { label: "Voortrekker Road, Parow", area: "Parow", lat: -33.9020, lng: 18.5850 },
  { label: "Station Road, Parow", area: "Parow", lat: -33.9015, lng: 18.5840 },
  { label: "Tallent Street, Parow", area: "Parow", lat: -33.9070, lng: 18.5890 },
  { label: "Hugo Street, Parow", area: "Parow", lat: -33.9000, lng: 18.5870 },
  // ── Bellville ──
  { label: "Voortrekker Road, Bellville", area: "Bellville", lat: -33.9000, lng: 18.6300 },
  { label: "Jip de Jager Drive, Bellville", area: "Bellville", lat: -33.8980, lng: 18.6288 },
  { label: "Dr Hertzog Boulevard, Bellville", area: "Bellville", lat: -33.9010, lng: 18.6315 },
  { label: "Kasselsvlei Road, Bellville", area: "Bellville", lat: -33.8988, lng: 18.6275 },
  { label: "Main Road, Bellville", area: "Bellville", lat: -33.9008, lng: 18.6298 },
  { label: "Edward Street, Bellville", area: "Bellville", lat: -33.8995, lng: 18.6320 },
  { label: "Carl Cronje Drive, Bellville", area: "Bellville", lat: -33.8920, lng: 18.6260 },
  { label: "Tyger Valley Road, Bellville", area: "Bellville", lat: -33.8730, lng: 18.6260 },
  { label: "Old Oak Road, Bellville", area: "Bellville", lat: -33.8960, lng: 18.6180 },
  // ── Athlone / Belgravia / Crawford ──
  { label: "Klipfontein Road, Athlone", area: "Athlone", lat: -33.9620, lng: 18.5150 },
  { label: "Belgravia Road, Athlone", area: "Athlone", lat: -33.9605, lng: 18.5138 },
  { label: "Repulse Road, Athlone", area: "Athlone", lat: -33.9590, lng: 18.5100 },
  { label: "Belgravia Road, Crawford", area: "Crawford", lat: -33.9700, lng: 18.4995 },
  { label: "Klipfontein Road, Crawford", area: "Crawford", lat: -33.9690, lng: 18.4960 },
  // ── Mitchells Plain ──
  { label: "Spine Road, Mitchells Plain", area: "Mitchells Plain", lat: -34.0306, lng: 18.6244 },
  { label: "Freedom Way, Mitchells Plain", area: "Mitchells Plain", lat: -34.0295, lng: 18.6230 },
  { label: "Tafelsig Road, Mitchells Plain", area: "Mitchells Plain", lat: -34.0315, lng: 18.6258 },
  { label: "Robert Sobukwe Road, Mitchells Plain", area: "Mitchells Plain", lat: -34.0302, lng: 18.6210 },
  { label: "Highlands Drive, Mitchells Plain", area: "Mitchells Plain", lat: -34.0380, lng: 18.6280 },
  { label: "Vanguard Drive, Mitchells Plain", area: "Mitchells Plain", lat: -34.0210, lng: 18.6090 },
  { label: "Eisleben Road, Mitchells Plain", area: "Mitchells Plain", lat: -34.0290, lng: 18.6220 },
  { label: "Merrydale Avenue, Mitchells Plain", area: "Mitchells Plain", lat: -34.0330, lng: 18.6160 },
  { label: "AZ Berman Drive, Mitchells Plain", area: "Mitchells Plain", lat: -34.0260, lng: 18.6190 },
  { label: "Weltevreden Road, Mitchells Plain", area: "Mitchells Plain", lat: -34.0340, lng: 18.6330 },
  // ── Khayelitsha ──
  { label: "Spine Road, Khayelitsha", area: "Khayelitsha", lat: -34.0414, lng: 18.6619 },
  { label: "Mew Way, Khayelitsha", area: "Khayelitsha", lat: -34.0420, lng: 18.6628 },
  { label: "Lansdowne Road, Khayelitsha", area: "Khayelitsha", lat: -34.0380, lng: 18.6720 },
  { label: "Steve Biko Road, Khayelitsha", area: "Khayelitsha", lat: -34.0460, lng: 18.6700 },
  { label: "Walter Sisulu Road, Khayelitsha", area: "Khayelitsha", lat: -34.0500, lng: 18.6750 },
  { label: "Ntlazane Street, Khayelitsha", area: "Khayelitsha", lat: -34.0440, lng: 18.6690 },
  { label: "Japhta Masemola Road, Khayelitsha", area: "Khayelitsha", lat: -34.0470, lng: 18.6730 },
  // ── Milnerton / Table View / Blouberg ──
  { label: "Otto Du Plessis Drive, Blouberg", area: "Blouberg", lat: -33.8070, lng: 18.4870 },
  { label: "Blaauwberg Road, Table View", area: "Table View", lat: -33.8270, lng: 18.4910 },
  { label: "Table View Main Road, Table View", area: "Table View", lat: -33.8260, lng: 18.4900 },
  { label: "Milnerton Road, Milnerton", area: "Milnerton", lat: -33.8680, lng: 18.4970 },
  { label: "Morningstar Drive, Milnerton", area: "Milnerton", lat: -33.8692, lng: 18.4985 },
  { label: "Bosmansdam Road, Milnerton", area: "Milnerton", lat: -33.8730, lng: 18.5040 },
  { label: "Royal Ascot Boulevard, Milnerton", area: "Milnerton", lat: -33.8650, lng: 18.5070 },
  { label: "Link Road, Table View", area: "Table View", lat: -33.8240, lng: 18.4870 },
  { label: "Marine Circle, Table View", area: "Table View", lat: -33.8210, lng: 18.4920 },
  // ── Stellenbosch ──
  { label: "Church Street, Stellenbosch", area: "Stellenbosch", lat: -33.9325, lng: 18.8651 },
  { label: "Main Road, Stellenbosch", area: "Stellenbosch", lat: -33.9318, lng: 18.8640 },
  { label: "Dorp Street, Stellenbosch", area: "Stellenbosch", lat: -33.9355, lng: 18.8605 },
  { label: "Bird Street, Stellenbosch", area: "Stellenbosch", lat: -33.9340, lng: 18.8625 },
  { label: "Andringa Street, Stellenbosch", area: "Stellenbosch", lat: -33.9365, lng: 18.8615 },
  { label: "Merriman Avenue, Stellenbosch", area: "Stellenbosch", lat: -33.9395, lng: 18.8580 },
  // ── Airport / Industria ──
  { label: "Modderdam Road, Airport Industria", area: "Airport Industria", lat: -33.9681, lng: 18.5942 },
  { label: "Airport Approach Road, Cape Town", area: "Airport Industria", lat: -33.9700, lng: 18.5958 },
  { label: "Bofors Circle, Epping Industria", area: "Epping Industria", lat: -33.9290, lng: 18.5290 },
  { label: "Epping Avenue, Epping", area: "Epping", lat: -33.9320, lng: 18.5320 },
  { label: "Ndabeni Road, Ndabeni", area: "Ndabeni", lat: -33.9210, lng: 18.5180 },
  { label: "Koeberg Road, Brooklyn", area: "Brooklyn", lat: -33.8980, lng: 18.4880 },
  // ── Muizenberg / Kalk Bay / Fish Hoek / Simon's Town ──
  { label: "Main Road, Muizenberg", area: "Muizenberg", lat: -34.1060, lng: 18.4720 },
  { label: "Main Road, Kalk Bay", area: "Kalk Bay", lat: -34.1300, lng: 18.4500 },
  { label: "Church Street, Kalk Bay", area: "Kalk Bay", lat: -34.1292, lng: 18.4490 },
  { label: "Main Road, Fish Hoek", area: "Fish Hoek", lat: -34.1370, lng: 18.4310 },
  { label: "St Georges Street, Simon's Town", area: "Simon's Town", lat: -34.1930, lng: 18.4380 },
  { label: "Main Road, Simon's Town", area: "Simon's Town", lat: -34.1925, lng: 18.4360 },
  // ── Hout Bay / Constantia ──
  { label: "Main Road, Hout Bay", area: "Hout Bay", lat: -34.0420, lng: 18.3530 },
  { label: "Disa River Road, Hout Bay", area: "Hout Bay", lat: -34.0398, lng: 18.3548 },
  { label: "Constantia Main Road, Constantia", area: "Constantia", lat: -34.0250, lng: 18.4280 },
  { label: "Spaanschemat River Road, Constantia", area: "Constantia", lat: -34.0210, lng: 18.4220 },
  // ── Camps Bay / Bantry Bay / Clifton ──
  { label: "Victoria Road, Camps Bay", area: "Camps Bay", lat: -33.9525, lng: 18.3775 },
  { label: "Camps Bay Drive, Camps Bay", area: "Camps Bay", lat: -33.9520, lng: 18.3790 },
  { label: "The Glen, Camps Bay", area: "Camps Bay", lat: -33.9510, lng: 18.3805 },
  { label: "Theresa Avenue, Camps Bay", area: "Camps Bay", lat: -33.9540, lng: 18.3815 },
  { label: "Kloof Road, Bantry Bay", area: "Bantry Bay", lat: -33.9210, lng: 18.3815 },
  { label: "Victoria Road, Clifton", area: "Clifton", lat: -33.9390, lng: 18.3760 },
  // ── Lansdowne / Hanover Park / Crawford ──
  { label: "Lansdowne Road, Lansdowne", area: "Lansdowne", lat: -33.9760, lng: 18.4980 },
  { label: "Wetton Road, Lansdowne", area: "Lansdowne", lat: -33.9790, lng: 18.4940 },
  { label: "Ferndale Road, Lansdowne", area: "Lansdowne", lat: -33.9740, lng: 18.4920 },
  { label: "Hanover Park Avenue, Hanover Park", area: "Hanover Park", lat: -34.0010, lng: 18.5320 },
  // ── Lavender Hill / Retreat / Steenberg / Tokai / Bergvliet ──
  { label: "Steenberg Road, Steenberg", area: "Steenberg", lat: -34.0610, lng: 18.4500 },
  { label: "Main Road, Retreat", area: "Retreat", lat: -34.0440, lng: 18.4730 },
  { label: "Prince George Drive, Lavender Hill", area: "Lavender Hill", lat: -34.0680, lng: 18.4670 },
  { label: "Ladies Mile Road, Bergvliet", area: "Bergvliet", lat: -34.0330, lng: 18.4570 },
  { label: "Tokai Road, Tokai", area: "Tokai", lat: -34.0480, lng: 18.4290 },
  // ── Philippi / Lentegeur / Strandfontein ──
  { label: "Lansdowne Road, Philippi", area: "Philippi", lat: -34.0080, lng: 18.5800 },
  { label: "AZ Berman Drive, Philippi", area: "Philippi", lat: -34.0120, lng: 18.5760 },
  { label: "Cape Flats Road, Strandfontein", area: "Strandfontein", lat: -34.0820, lng: 18.5790 },
  { label: "Spine Road, Lentegeur", area: "Lentegeur", lat: -34.0250, lng: 18.6390 },
  // ── Gugulethu / Nyanga ──
  { label: "NY1 Road, Gugulethu", area: "Gugulethu", lat: -33.9750, lng: 18.5780 },
  { label: "Lansdowne Road, Nyanga", area: "Nyanga", lat: -33.9990, lng: 18.5860 },
  { label: "Vanguard Drive, Nyanga", area: "Nyanga", lat: -33.9920, lng: 18.5800 },
  // ── Delft / Blue Downs / Eerste River ──
  { label: "Symphony Way, Delft", area: "Delft", lat: -33.9700, lng: 18.6400 },
  { label: "Stellenbosch Arterial, Blue Downs", area: "Blue Downs", lat: -33.9590, lng: 18.7080 },
  { label: "Old Faure Road, Eerste River", area: "Eerste River", lat: -33.8550, lng: 18.7280 },
  // ── Brackenfell / Kraaifontein / Kuils River ──
  { label: "Old Paarl Road, Brackenfell", area: "Brackenfell", lat: -33.8770, lng: 18.6750 },
  { label: "De Bron Road, Brackenfell", area: "Brackenfell", lat: -33.8800, lng: 18.6790 },
  { label: "Brighton Road, Kraaifontein", area: "Kraaifontein", lat: -33.8420, lng: 18.6700 },
  { label: "Protea Road, Kraaifontein", area: "Kraaifontein", lat: -33.8460, lng: 18.6660 },
  { label: "Van Riebeeck Road, Kuils River", area: "Kuils River", lat: -33.9420, lng: 18.6850 },
  // ── Durbanville ──
  { label: "Wellington Road, Durbanville", area: "Durbanville", lat: -33.8290, lng: 18.6500 },
  { label: "Durban Road, Durbanville", area: "Durbanville", lat: -33.8310, lng: 18.6480 },
  { label: "Florida Road, Durbanville", area: "Durbanville", lat: -33.8320, lng: 18.6540 },
  { label: "School Street, Durbanville", area: "Durbanville", lat: -33.8295, lng: 18.6510 },
  // ── Edgemead / Bothasig / Panorama / Plattekloof ──
  { label: "Edgemead Drive, Edgemead", area: "Edgemead", lat: -33.8770, lng: 18.5640 },
  { label: "Frans Conradie Drive, Bothasig", area: "Bothasig", lat: -33.8650, lng: 18.5560 },
  { label: "Connaught Road, Bothasig", area: "Bothasig", lat: -33.8680, lng: 18.5590 },
  { label: "Panorama Drive, Panorama", area: "Panorama", lat: -33.8650, lng: 18.5780 },
  { label: "Plattekloof Road, Plattekloof", area: "Plattekloof", lat: -33.8820, lng: 18.5840 },
  // ── Century City / Montague Gardens ──
  { label: "Century Boulevard, Century City", area: "Century City", lat: -33.8920, lng: 18.5180 },
  { label: "Marine Drive, Montague Gardens", area: "Montague Gardens", lat: -33.8730, lng: 18.5320 },
  // ── Vredehoek / Walmer Estate ──
  { label: "Upper Buitenkant Street, Vredehoek", area: "Vredehoek", lat: -33.9420, lng: 18.4180 },
  { label: "Springbok Road, Walmer Estate", area: "Walmer Estate", lat: -33.9350, lng: 18.4420 },
  // ── Rondebosch East / Heideveld / Manenberg ──
  { label: "Jan Smuts Drive, Rondebosch East", area: "Rondebosch East", lat: -33.9650, lng: 18.5050 },
  { label: "Duinefontein Road, Heideveld", area: "Heideveld", lat: -33.9740, lng: 18.5430 },
  { label: "Manenberg Avenue, Manenberg", area: "Manenberg", lat: -33.9780, lng: 18.5570 },
  // ── Elsies River / Bishop Lavis / Valhalla Park ──
  { label: "Halt Road, Elsies River", area: "Elsies River", lat: -33.9290, lng: 18.5780 },
  { label: "Symphony Way, Bishop Lavis", area: "Bishop Lavis", lat: -33.9430, lng: 18.5870 },
  { label: "Valhalla Drive, Valhalla Park", area: "Valhalla Park", lat: -33.9460, lng: 18.5950 },
  // ── Ottery / Grassy Park ──
  { label: "Ottery Road, Ottery", area: "Ottery", lat: -34.0000, lng: 18.5040 },
  { label: "Prince George Drive, Grassy Park", area: "Grassy Park", lat: -34.0440, lng: 18.5050 },
  // ── Vrygrond / Capricorn / Marina Da Gama ──
  { label: "Baden Powell Drive, Vrygrond", area: "Vrygrond", lat: -34.0820, lng: 18.4570 },
  { label: "Military Road, Capricorn", area: "Capricorn", lat: -34.0900, lng: 18.4550 },
  { label: "Marina Da Gama Boulevard, Marina Da Gama", area: "Marina Da Gama", lat: -34.1010, lng: 18.4660 },
  // ── Joe Slovo / Dunoon / Atlantis ──
  { label: "Phola Park Road, Joe Slovo", area: "Joe Slovo", lat: -33.8950, lng: 18.5160 },
  { label: "Sandown Road, Dunoon", area: "Dunoon", lat: -33.8120, lng: 18.5160 },
  { label: "Beach Road, Atlantis", area: "Atlantis", lat: -33.5700, lng: 18.4920 },
  // ── Melkbosstrand / Sunningdale / Big Bay ──
  { label: "Otto Du Plessis Drive, Melkbosstrand", area: "Melkbosstrand", lat: -33.7250, lng: 18.4380 },
  { label: "Sunningdale Drive, Sunningdale", area: "Sunningdale", lat: -33.8030, lng: 18.4940 },
  { label: "Doncaster Road, Big Bay", area: "Big Bay", lat: -33.7700, lng: 18.4500 },
  // ── Belhar / Bonteheuwel / Langa ──
  { label: "Robert Sobukwe Road, Belhar", area: "Belhar", lat: -33.9320, lng: 18.6310 },
  { label: "Bonteheuwel Avenue, Bonteheuwel", area: "Bonteheuwel", lat: -33.9540, lng: 18.5500 },
  { label: "Washington Street, Langa", area: "Langa", lat: -33.9430, lng: 18.5300 },
  // ── Parklands / Sunset Beach ──
  { label: "Sandown Road, Parklands", area: "Parklands", lat: -33.8170, lng: 18.4940 },
  { label: "Marine Drive, Sunset Beach", area: "Sunset Beach", lat: -33.7980, lng: 18.4790 },
  // ── Woodbridge Island / Royal Cape ──
  { label: "Woodbridge Island Road, Woodbridge Island", area: "Woodbridge Island", lat: -33.8870, lng: 18.4800 },
  { label: "Klipfontein Road, Royal Cape", area: "Royal Cape", lat: -33.9710, lng: 18.4880 },
  // ── Welgemoed / Loevenstein ──
  { label: "De Tyger Drive, Welgemoed", area: "Welgemoed", lat: -33.8900, lng: 18.6100 },
  { label: "Loevenstein Road, Loevenstein", area: "Loevenstein", lat: -33.8840, lng: 18.6020 },
  // ── Strand / Somerset West / Paarl ──
  { label: "Beach Road, Strand", area: "Strand", lat: -34.1175, lng: 18.8340 },
  { label: "Main Road, Somerset West", area: "Somerset West", lat: -34.0790, lng: 18.8420 },
  { label: "Lourensford Road, Somerset West", area: "Somerset West", lat: -34.0850, lng: 18.8500 },
  { label: "Main Street, Paarl", area: "Paarl", lat: -33.7290, lng: 18.9620 },
  { label: "Lady Grey Street, Paarl", area: "Paarl", lat: -33.7320, lng: 18.9650 },
];

function coordForArea(areaName) {
  const entry = CPT_ADDRESS_DB.find(a => a.area === areaName);
  if (entry) return { lat: entry.lat, lng: entry.lng };
  return { lat: -33.9249, lng: 18.4241 };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function buildPickupSequence(trips, driverStartCoord) {
  const start = driverStartCoord || COMPANY_LOCATIONS[1];
  let remaining = trips.map(t => ({
    trip: t,
    coord: (t.pickup_sequence_coords && t.pickup_sequence_coords[0]) || start,
  }));
  const ordered = [];
  let cur = start;
  while (remaining.length) {
    let best = null, bestDist = Infinity;
    for (const r of remaining) {
      const d = haversineKm(cur.lat, cur.lng, r.coord.lat, r.coord.lng);
      if (d < bestDist) { bestDist = d; best = r; }
    }
    ordered.push(best);
    cur = best.coord;
    remaining = remaining.filter(r => r !== best);
  }
  return ordered;
}

function buildDropoffSequence(trips) {
  return [...trips].sort((a, b) => {
    const ta = a.scheduled_time || "99:99";
    const tb = b.scheduled_time || "99:99";
    if (ta !== tb) return ta.localeCompare(tb);
    const base = COMPANY_LOCATIONS[1];
    const da = haversineKm(base.lat, base.lng,
      (a.dropoff_sequence_coords && a.dropoff_sequence_coords[0] && a.dropoff_sequence_coords[0].lat) || base.lat,
      (a.dropoff_sequence_coords && a.dropoff_sequence_coords[0] && a.dropoff_sequence_coords[0].lng) || base.lng);
    const db = haversineKm(base.lat, base.lng,
      (b.dropoff_sequence_coords && b.dropoff_sequence_coords[0] && b.dropoff_sequence_coords[0].lat) || base.lat,
      (b.dropoff_sequence_coords && b.dropoff_sequence_coords[0] && b.dropoff_sequence_coords[0].lng) || base.lng);
    return da - db;
  });
}

function sortDropoffsByProximity(dropStops, lastPickupCoord) {
  if (!lastPickupCoord || dropStops.length <= 1) return dropStops;
  return [...dropStops].sort((a, b) => {
    const da = haversineKm(lastPickupCoord.lat, lastPickupCoord.lng, a.lat || 0, a.lng || 0);
    const db = haversineKm(lastPickupCoord.lat, lastPickupCoord.lng, b.lat || 0, b.lng || 0);
    return da - db;
  });
}

const mkId = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const now = () => new Date().toLocaleString("en-ZA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
// now() returns a formatted display string, which is what the in-memory
// reducer's mock UI expects everywhere it renders a timestamp directly.
// The real Supabase schema's timestamp columns (ts, timestamp, acceptedat,
// confirmedat, completedat, bookedat, updatedat, etc.) are bigint epoch-ms
// values, not strings — inserting now()'s output into those columns fails
// with Postgres error 22P02. nowEpoch() is for exactly those DB writes.
const nowEpoch = () => Date.now();
// Converts an epoch-ms value (as read back from Supabase) into the same
// display format now() produces, so the UI shows "11/07/2026, 19:34"
// instead of a raw number like 1752262440000.
const epochToDisplay = (ms) => (ms == null ? null : new Date(ms).toLocaleString("en-ZA", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }));

// Parses the app's booking-form date/time strings into a real Date object.
// scheduled_date is typically "DD/MM/YYYY" (en-ZA locale, what the booking
// form's date default produces) but the field is free-text — admins/agents
// can type other formats, so this tries DD/MM/YYYY first (the expected case)
// and falls back to whatever the JS Date constructor can natively parse
// (handles ISO "YYYY-MM-DD" and a few other common shapes). Returns null
// rather than throwing if nothing works, so callers can skip time-sensitive
// checks gracefully instead of crashing on a malformed date string.
function parseScheduledDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [h, m] = String(timeStr).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;

  const ddmmyyyy = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), h, m, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // YYYY/MM/DD — what the booking form's free-text Date field actually
  // defaults to (confirmed from the running app), distinct from the
  // DD/MM/YYYY case above. Checked explicitly since 2026/07/11 is
  // ambiguous against the DD/MM/YYYY regex and was silently failing,
  // leaving scheduledtime null against a NOT NULL column.
  const yyyymmddSlash = String(dateStr).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (yyyymmddSlash) {
    const [, yyyy, mm, dd] = yyyymmddSlash;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), h, m, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // YYYY-MM-DD (ISO, e.g. from a native <input type="date">)
  const yyyymmddDash = String(dateStr).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyymmddDash) {
    const [, yyyy, mm, dd] = yyyymmddDash;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), h, m, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fallback = new Date(`${dateStr}T${String(timeStr).padStart(5, "0")}:00`);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function getDriverLoad(state, driver_id) {
  return state.trips.filter(
    t => t.driver_id === driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED
  ).length;
}

/* ---------- WAZE NAVIGATION (web: window.open instead of RN Linking) ---------- */
function buildWazeDeepLink(lat, lng, label = "") {
  return `waze://?ll=${lat},${lng}&navigate=yes&zoom=17&q=${encodeURIComponent(label)}`;
}
function buildWazeWebLink(lat, lng) {
  return `https://www.waze.com/ul?ll=${lat},${lng}&navigate=yes`;
}
// Web version: try the waze:// deep link first (works if Waze's web handler
// is registered on the user's OS), then fall back to the Waze website in a
// new tab. There's no canOpenURL equivalent in a browser, so we optimistically
// try the deep link and rely on the fallback tab if nothing intercepts it.
function openWaze(lat, lng, label = "") {
  const deepLink = buildWazeDeepLink(lat, lng, label);
  const webLink = buildWazeWebLink(lat, lng);
  try {
    const w = window.open(deepLink, "_blank");
    // If the deep link didn't get intercepted by an installed app, most
    // browsers will show about:blank or fail silently — open the web
    // fallback shortly after as a safety net.
    setTimeout(() => {
      if (!document.hidden) window.open(webLink, "_blank");
    }, 600);
  } catch (e) {
    window.open(webLink, "_blank");
  }
}

/* ---------- ADDRESS SEARCH (offline DB + OpenStreetMap Nominatim) ---------- */
// Nominatim is OpenStreetMap's free, public geocoding search — no API key,
// no billing account, no script tag, and it sends proper CORS headers so a
// plain fetch() from the browser works out of the box. This replaced Google
// Places because that requires a correctly billed + API-enabled Cloud
// Console project, which isn't something that can be diagnosed or fixed
// from here — Nominatim needs zero setup and just works.
const CPT_BOUNDS = { north: -33.55, south: -34.25, east: 19.05, west: 18.25 };
const GENERIC_ROAD_WORDS = new Set([
  "street", "road", "avenue", "drive", "way", "lane", "close", "crescent",
  "boulevard", "square", "place", "walk", "terrace", "rise", "view", "park",
  "circle", "loop", "court", "heights", "hill", "bay", "cape", "town",
]);

function staticSearch(query) {
  if (!query || query.trim().length < 2) return [];
  const q = query.toLowerCase().trim();
  const qNoNum = q.replace(/^\d+\s*/, "");
  const words = qNoNum.split(/\s+/).filter(w => w.length >= 2 && !GENERIC_ROAD_WORDS.has(w) && !/^\d+$/.test(w));
  if (words.length === 0) return [];
  return CPT_ADDRESS_DB
    .map(addr => {
      const lbl = addr.label.toLowerCase();
      const street = lbl.split(",")[0];
      let score = 0;
      let streetMatched = false;
      if (street.includes(qNoNum) && qNoNum.length >= 3) { score += 100; streetMatched = true; }
      words.forEach(w => {
        if (street.startsWith(w)) { score += 25; streetMatched = true; }
        if (street.includes(w)) { score += 15; streetMatched = true; }
        if (addr.area.toLowerCase().includes(w)) score += 5;
      });
      return (streetMatched && score > 0) ? { ...addr, score, source: "local" } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

// Nominatim's usage policy asks for a descriptive User-Agent/Referer, but
// browsers set Referer automatically and block scripts from overriding it —
// there's nothing extra to configure here. Requests are capped to Cape
// Town's bounding box via viewbox+bounded so results don't drift to other
// cities that happen to share a street name.
async function nominatimSearch(query) {
  if (!query || query.trim().length < 2) return [];
  try {
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      addressdetails: "1",
      limit: "6",
      countrycodes: "za",
      viewbox: `${CPT_BOUNDS.west},${CPT_BOUNDS.north},${CPT_BOUNDS.east},${CPT_BOUNDS.south}`,
      bounded: "1",
      // Nominatim's usage policy asks for a way to identify the calling
      // app. Browsers block JS from setting a custom User-Agent header for
      // security reasons, so their documented workaround is to identify
      // via this query param instead. Swap in a real contact address if
      // you have one — it's optional but keeps you in good standing under
      // their usage policy at higher request volumes.
      // email: "your-real-contact@yourdomain.com",
    });
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "Accept-Language": "en" },
    });
    if (!res.ok) {
      console.warn("[Nominatim] HTTP error:", res.status);
      return [];
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return [];
    return data.map(r => {
      const addr = r.address || {};
      const houseNum = addr.house_number || "";
      const road = addr.road || addr.pedestrian || addr.footway || "";
      const suburb = addr.suburb || addr.neighbourhood || addr.city_district || addr.town || "";
      const streetLine = road ? `${houseNum ? houseNum + " " : ""}${road}` : "";
      const label = streetLine
        ? `${streetLine}${suburb ? `, ${suburb}` : ""}, Cape Town`
        : (r.display_name || query);
      return {
        label,
        area: suburb || "Cape Town",
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        source: "osm",
      };
    }).filter(r => !isNaN(r.lat) && !isNaN(r.lng));
  } catch (e) {
    console.warn("[Nominatim] search failed, falling back to offline DB:", e.message);
    return [];
  }
}

async function unifiedAddressSearch(query) {
  const offline = staticSearch(query);
  const live = await nominatimSearch(query);
  if (live.length > 0) return { results: live, liveOk: true };
  return { results: offline, liveOk: false };
}

/* ---------- SUPABASE CLIENT (web) ----------
   Note: this file assumes @supabase/supabase-js is available as an ES
   import in your build (Vite/CRA/Next). If you're pasting this into a
   sandboxed preview tool without npm access, comment out the import below
   and the app will fall back to the in-memory reducer automatically. */
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kwkgiylwnafwimxqmjwk.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Kyne7Q6PJ2uKmcfslI-qNQ_CX-m7mxF";

const supabase = (SUPABASE_URL && SUPABASE_ANON_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;

// Instant street-name suggestions from the bulk-loaded City of Cape Town
// street name reference table (18k+ names, no house numbers/coordinates).
// This is meant to be near-instant feedback while typing — picking a
// suggestion re-runs the live Nominatim search scoped to that exact name,
// which is what actually resolves a coordinate.
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

/* ---------- SEED DATA (used for local fallback / first-run reference) ---------- */
const SEED_USERS = [
  { id: "USR_ADMIN", role: ROLE.ADMIN, name: "Control Admin", staff_number: "ADM001", auth: { login: "Control Admin", pass: "ADM001" } },
  { id: "USR_A1", role: ROLE.AGENT, name: "Nomsa Dlamini", staff_number: "AG1001", auth: { login: "Nomsa Dlamini", pass: "AG1001" },
    home_address: { label: "Spine Road, Mitchells Plain, Cape Town", area: "Mitchells Plain", lat: -34.0306, lng: 18.6244 },
    branch_id: "TELUS_MAITLAND", branch_history: [] },
  { id: "USR_A2", role: ROLE.AGENT, name: "Thabo Mokoena", staff_number: "AG1002", auth: { login: "Thabo Mokoena", pass: "AG1002" },
    home_address: { label: "Voortrekker Road, Bellville, Cape Town", area: "Bellville", lat: -33.9000, lng: 18.6300 },
    branch_id: "TELUS_MAITLAND", branch_history: [] },
  { id: "USR_A3", role: ROLE.AGENT, name: "Ayesha Dollie", staff_number: "AG1003", auth: { login: "Ayesha Dollie", pass: "AG1003" },
    home_address: { label: "Lansdowne Road, Lansdowne, Cape Town", area: "Lansdowne", lat: -33.9760, lng: 18.4980 },
    branch_id: "TELUS_MAITLAND", branch_history: [] },
  { id: "USR_D1", role: ROLE.DRIVER, name: "Sipho Nkosi", staff_number: "DR2001", auth: { login: "Sipho Nkosi", pass: "DR2001" } },
  { id: "USR_D2", role: ROLE.DRIVER, name: "Fatima Adams", staff_number: "DR2002", auth: { login: "Fatima Adams", pass: "DR2002" } },
];
const SEED_DRIVER_STATUS = [
  { driver_id: "USR_D1", state: DRIVER_STATE.AVAILABLE, current_trip_id: null, vehicle: "Toyota Hiace - CA 123-456", phone: "071 234 5678", capacity: DRIVER_CAPACITY },
  { driver_id: "USR_D2", state: DRIVER_STATE.AVAILABLE, current_trip_id: null, vehicle: "VW Transporter - CA 789-012", phone: "082 345 6789", capacity: DRIVER_CAPACITY },
];
const INITIAL_STATE = {
  users: SEED_USERS, driver_status: SEED_DRIVER_STATUS, trips: [], notifications: [], active_user_id: null,
};

/* ---------- IN-MEMORY REDUCER (fallback when Supabase isn't configured / reachable) ---------- */
function appReducer(state, action) {
  switch (action.type) {

    case "AUTH/LOGIN": {
      const user = state.users.find(u => u.auth.login === action.login && u.auth.pass === action.pass);
      if (!user) return { ...state, _error: "Invalid credentials" };
      return { ...state, active_user_id: user.id, _error: null };
    }
    case "AUTH/LOGOUT":
      return { ...state, active_user_id: null };

    case "ADMIN/UPDATE_USER": {
      const target = state.users.find(u => u.id === action.user_id);
      if (!target) return { ...state, _error: "User not found" };

      // ── Branch reassignment tracking ──
      // If this update changes an agent's branch_id, and the NEW branch is
      // more than 40 km (road-distance estimate) from the agent's pickup/home
      // address, archive the branch they're leaving into branch_history
      // before switching — a record of "moved from X because it was too far"
      // rather than silently overwriting it.
      let branchUpdate = {};
      let branchNotif = null;
      if (action.branch_id !== undefined && action.branch_id !== target.branch_id) {
        const newBranch = COMPANY_LOCATIONS.find(b => b.id === action.branch_id);
        const home = target.home_address;
        let distKm = null;
        if (newBranch && home?.lat != null) {
          distKm = haversineKm(home.lat, home.lng, newBranch.lat, newBranch.lng) * 1.35;
        }
        const farReassignment = distKm != null && distKm > 40;
        branchUpdate = {
          branch_id: action.branch_id,
          branch_history: farReassignment && target.branch_id
            ? [...(target.branch_history || []), { branch_id: target.branch_id, changed_at: now(), reason: `Reassigned to ${newBranch?.label || action.branch_id} (${distKm.toFixed(1)} km from home) — previous branch kept on file.` }]
            : (target.branch_history || []),
        };
        if (farReassignment) {
          branchNotif = {
            id: mkId(), type: "BRANCH_REASSIGNED_FAR", for_roles: [ROLE.ADMIN],
            message: `📍 ${target.name} reassigned to ${newBranch?.label || action.branch_id}, which is ${distKm.toFixed(1)} km from their home address. Previous branch retained on file.`,
            ts: now(), read: false,
          };
        }
      }

      const newUsers = state.users.map(u => u.id === action.user_id ? {
        ...u,
        name: action.name ?? u.name,
        staff_number: action.staff_number ?? u.staff_number,
        auth: { login: action.login ?? u.auth.login, pass: action.pass || u.auth.pass },
        ...(u.role === ROLE.AGENT
          ? { home_address: action.home_address !== undefined ? action.home_address : u.home_address, ...branchUpdate }
          : {}),
      } : u);
      let newDriverStatus = state.driver_status;
      if (target.role === ROLE.DRIVER && (action.vehicle !== undefined || action.phone !== undefined)) {
        newDriverStatus = state.driver_status.map(d => d.driver_id === action.user_id ? {
          ...d,
          vehicle: action.vehicle !== undefined ? action.vehicle : d.vehicle,
          phone: action.phone !== undefined ? action.phone : d.phone,
        } : d);
      }
      const newTrips = state.trips.map(t =>
        t.agent_ids.includes(action.user_id) && action.name
          ? { ...t, agent_name: t.agent_ids[0] === action.user_id ? action.name : t.agent_name }
          : t
      );
      const newNotifications = branchNotif ? [branchNotif, ...state.notifications] : state.notifications;
      return { ...state, users: newUsers, driver_status: newDriverStatus, trips: newTrips, notifications: newNotifications, _error: null };
    }

    case "TRIP/ADD_AGENT": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return { ...state, _error: "Trip not found" };
      if (trip.agent_ids.includes(action.agent_id)) return { ...state, _error: "Agent is already on this trip" };
      if (trip.state === TRIP_STATE.ARCHIVED_COMPLETED) return { ...state, _error: "Cannot add a passenger to a completed trip" };

      const newAgentIds = [...trip.agent_ids, action.agent_id];
      const newPickupCoords = [...trip.pickup_sequence_coords, { ...action.pickup_coord, label: action.pickup_label, agent_id: action.agent_id }];

      let newTrips;
      if (trip.driver_id) {
        const driverTrips = state.trips.filter(t => t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED);
        const updatedTrip = { ...trip, agent_ids: newAgentIds, pickup_sequence_coords: newPickupCoords };
        const allForDriver = driverTrips.map(t => t.trip_id === trip.trip_id ? updatedTrip : t);
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        newTrips = state.trips.map(t => {
          if (t.trip_id === trip.trip_id) return { ...updatedTrip, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          if (t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED) return { ...t, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          return t;
        });
      } else {
        newTrips = state.trips.map(t => t.trip_id === trip.trip_id ? { ...t, agent_ids: newAgentIds, pickup_sequence_coords: newPickupCoords } : t);
      }

      const notif = {
        id: mkId(), type: "TRIP_BOOKED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `You've been added to trip ${trip.trip_id} (pickup: ${action.pickup_label}).`,
        trip_id: trip.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTrips, notifications: [notif, ...state.notifications], _error: null };
    }

    case "TRIP/REMOVE_AGENT": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return { ...state, _error: "Trip not found" };
      if (!trip.agent_ids.includes(action.agent_id)) return { ...state, _error: "Agent is not on this trip" };
      if (trip.agent_ids.length <= 1) return { ...state, _error: "Cannot remove the last passenger — cancel or reassign the trip instead" };
      if (trip.state === TRIP_STATE.ARCHIVED_COMPLETED) return { ...state, _error: "Cannot remove a passenger from a completed trip" };

      const newAgentIds = trip.agent_ids.filter(id => id !== action.agent_id);
      const newPickupCoords = trip.pickup_sequence_coords.filter(c => c.agent_id !== action.agent_id);
      const newCompletedPickups = (trip.completed_pickups || []).filter(id => id !== action.agent_id);
      const newAgentName = newAgentIds[0] ? (state.users.find(u => u.id === newAgentIds[0])?.name || trip.agent_name) : trip.agent_name;

      let newTripsRemove;
      if (trip.driver_id) {
        const driverTrips = state.trips.filter(t => t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED);
        const updatedTrip = { ...trip, agent_ids: newAgentIds, pickup_sequence_coords: newPickupCoords, completed_pickups: newCompletedPickups, agent_name: newAgentName };
        const allForDriver = driverTrips.map(t => t.trip_id === trip.trip_id ? updatedTrip : t);
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        newTripsRemove = state.trips.map(t => {
          if (t.trip_id === trip.trip_id) return { ...updatedTrip, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          if (t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED) return { ...t, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          return t;
        });
      } else {
        newTripsRemove = state.trips.map(t => t.trip_id === trip.trip_id ? { ...t, agent_ids: newAgentIds, pickup_sequence_coords: newPickupCoords, completed_pickups: newCompletedPickups, agent_name: newAgentName } : t);
      }

      const removeNotif = {
        id: mkId(), type: "TRIP_UPDATED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `You've been removed from trip ${trip.trip_id}.`,
        trip_id: trip.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTripsRemove, notifications: [removeNotif, ...state.notifications], _error: null };
    }

    case "TRIP/RELOCATE_AGENT": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return { ...state, _error: "Trip not found" };
      if (!trip.agent_ids.includes(action.agent_id)) return { ...state, _error: "Agent is not on this trip" };
      if (trip.state === TRIP_STATE.ARCHIVED_COMPLETED) return { ...state, _error: "Cannot relocate a passenger on a completed trip" };

      const newCoord = { ...action.pickup_coord, label: action.pickup_label, agent_id: action.agent_id };
      const newPickupCoords = trip.pickup_sequence_coords.map((c, i) => {
        const belongsToThisAgent = c.agent_id === action.agent_id || (i === 0 && !c.agent_id && trip.agent_ids[0] === action.agent_id);
        return belongsToThisAgent ? { ...newCoord, agent_id: c.agent_id } : c;
      });

      let newTripsRelocate;
      if (trip.driver_id) {
        const driverTrips = state.trips.filter(t => t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED);
        const updatedTrip = { ...trip, pickup_sequence_coords: newPickupCoords };
        const allForDriver = driverTrips.map(t => t.trip_id === trip.trip_id ? updatedTrip : t);
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        newTripsRelocate = state.trips.map(t => {
          if (t.trip_id === trip.trip_id) return { ...updatedTrip, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          if (t.driver_id === trip.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED) return { ...t, pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num };
          return t;
        });
      } else {
        newTripsRelocate = state.trips.map(t => t.trip_id === trip.trip_id ? { ...t, pickup_sequence_coords: newPickupCoords } : t);
      }

      const relocateNotif = {
        id: mkId(), type: "TRIP_UPDATED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `Your pickup for trip ${trip.trip_id} was moved to ${action.pickup_label}.`,
        trip_id: trip.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTripsRelocate, notifications: [relocateNotif, ...state.notifications], _error: null };
    }

    case "ADMIN/CREATE_USER": {
      const newUser = {
        id: "USR_" + mkId(), role: action.role, name: action.name, staff_number: action.staff_number || action.auth?.pass || null, auth: action.auth,
        ...(action.role === ROLE.AGENT && action.home_address ? { home_address: action.home_address } : {}),
        ...(action.role === ROLE.AGENT ? { branch_id: action.branch_id || COMPANY_LOCATIONS[0].id, branch_history: [] } : {}),
      };
      const newUsers = [...state.users, newUser];
      let newDriverStatus = state.driver_status;
      if (action.role === ROLE.DRIVER) {
        newDriverStatus = [...state.driver_status, {
          driver_id: newUser.id, state: DRIVER_STATE.AVAILABLE, current_trip_id: null,
          vehicle: action.vehicle || "—", phone: action.phone || "—",
          capacity: DRIVER_CAPACITY,
        }];
      }
      return { ...state, users: newUsers, driver_status: newDriverStatus };
    }

    case "TRIP/BOOK": {
      const pickupCoord = action.pickup_coord || { lat: -33.9249, lng: 18.4241, label: action.pickup_label };
      const dropCoord = action.dropoff_coord || COMPANY_LOCATIONS[0];
      const estDistKm = haversineKm(pickupCoord.lat, pickupCoord.lng, dropCoord.lat, dropCoord.lng);
      const estCostZar = parseFloat((8 + (estDistKm * 1.35) * 3.5).toFixed(2));
      // Road-distance estimate (same 1.35 correction factor used everywhere
      // else in the UI to turn straight-line Haversine km into an approximate
      // driving distance) — thresholds below are checked against THIS value
      // so they line up with the km figure admins actually see on screen.
      const roadDistKm = estDistKm * 1.35;

      const tripId = "TRP_" + mkId();
      const nowTs = now();

      const trip = {
        trip_id: tripId,
        agent_ids: [action.agent_id],
        driver_id: null,
        state: TRIP_STATE.UNASSIGNED_BOOKING,
        pickup_sequence_coords: [{ ...pickupCoord, label: action.pickup_label }],
        dropoff_sequence_coords: [{ ...dropCoord, label: action.dropoff_label }],
        completed_pickups: [],
        current_gps_coordinates: pickupCoord,
        current_nav_idx: 0,
        pickup_location_label: action.pickup_label,
        dropoff_location_label: action.dropoff_label,
        custom_pickup: action.pickup_label,
        custom_dropoff: action.dropoff_label,
        dropoff_company_id: action.dropoff_company_id || null,
        trip_type: action.trip_type,
        scheduled_date: action.scheduled_date,
        scheduled_time: action.scheduled_time,
        booked_at: nowTs,
        confirmed_at: null,
        tripStartedAt: null,
        in_transit_at: null,
        completed_at: null,
        agent_name: action.agent_name,
        phone: action.phone,
        drop_sequence_num: null,
        pickup_order_num: null,
        est_distance_km: estDistKm,
        est_cost_zar: estCostZar,
        actual_distance_km: null,
        driverAccepted: false,
        acceptedAt: null,
        declinedBy: [],
        chat_messages: [],
        reminder_sent: false,
        long_distance_flag: roadDistKm > 40,
        admin_note: roadDistKm > 42 ? `Booking distance ${roadDistKm.toFixed(1)} km exceeds 42 km threshold.` : null,
      };

      const notifs = [{
        id: mkId(), type: "TRIP_BOOKED", for_roles: [ROLE.ADMIN],
        message: `New booking from ${action.agent_name}: ${action.pickup_label} → ${action.dropoff_label}`,
        trip_id: tripId, ts: nowTs, read: false,
      }];

      // ── Long-distance notification (>40 km) ──
      if (roadDistKm > 40) {
        notifs.unshift({
          id: mkId(), type: "LONG_DISTANCE_TRIP", for_roles: [ROLE.ADMIN],
          message: `⚠ Trip ${tripId} for ${action.agent_name} is ${roadDistKm.toFixed(1)} km — exceeds the 40 km threshold.`,
          trip_id: tripId, ts: nowTs, read: false,
        });
      }

      // ── Surcharge notification (>42 km): R20 for every km over 40, uncapped ──
      if (roadDistKm > 42) {
        const billableKm = roadDistKm - 40;
        const surcharge = Math.round(billableKm * 20);
        notifs.unshift({
          id: mkId(), type: "DISTANCE_SURCHARGE", for_roles: [ROLE.ADMIN],
          message: `💰 Trip ${tripId} (${roadDistKm.toFixed(1)} km) qualifies for a distance surcharge: R${surcharge} (${billableKm.toFixed(1)} km over 40 km @ R20/km) — for invoicing.`,
          trip_id: tripId, ts: nowTs, read: false,
        });
      }

      // ── Late-booking notification (<2 hours before scheduled time) ──
      // Parses scheduled_date + scheduled_time against "now" — if either is
      // missing/unparseable this check is silently skipped rather than
      // throwing, since a malformed date shouldn't block the booking itself.
      try {
        const scheduledDt = parseScheduledDateTime(action.scheduled_date, action.scheduled_time);
        if (scheduledDt) {
          const hoursUntil = (scheduledDt.getTime() - Date.now()) / 3600000;
          if (hoursUntil < 2) {
            notifs.unshift({
              id: mkId(), type: "LATE_BOOKING", for_roles: [ROLE.ADMIN],
              message: `⏰ LATE BOOKING: ${action.agent_name} booked trip ${tripId} only ${hoursUntil < 0 ? "after" : hoursUntil.toFixed(1) + "h before"} the scheduled time (${action.scheduled_date} ${action.scheduled_time}).`,
              trip_id: tripId, ts: nowTs, read: false,
            });
          }
        }
      } catch (e) { /* malformed date/time — skip late-booking check, don't block booking */ }

      return { ...state, trips: [trip, ...state.trips], notifications: [...notifs, ...state.notifications] };
    }

    case "TRIP/ASSIGN_DRIVER": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      const drvStatus = state.driver_status.find(d => d.driver_id === action.driver_id);
      if (!trip || !drvStatus) return state;

      const currentLoad = getDriverLoad(state, action.driver_id);
      if (currentLoad >= DRIVER_CAPACITY) {
        return { ...state, _error: `Driver is fully booked (${DRIVER_CAPACITY}/${DRIVER_CAPACITY} seats).` };
      }

      try { assertTripTransition(trip.state, TRIP_STATE.DRIVER_CONFIRMED); }
      catch (e) { return { ...state, _error: e.message }; }

      const existingAssigned = state.trips.filter(
        t => t.driver_id === action.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED && t.trip_id !== action.trip_id
      );
      const allForDriver = [...existingAssigned, { ...trip, driver_id: action.driver_id }];
      const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
      const dropOrdered = buildDropoffSequence(allForDriver);

      const seqMap = {};
      const dropMap = {};
      ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
      dropOrdered.forEach((t, i) => { dropMap[t.trip_id] = i + 1; });

      const newTrips = state.trips.map(t => {
        if (t.trip_id === action.trip_id) {
          return {
            ...t, state: TRIP_STATE.DRIVER_CONFIRMED, driver_id: action.driver_id,
            pickup_order_num: seqMap[action.trip_id],
            drop_sequence_num: dropMap[action.trip_id],
            driverAccepted: true, acceptedAt: now(), confirmed_at: now(), tripStartedAt: now(),
          };
        }
        if (t.driver_id === action.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED) {
          return {
            ...t,
            pickup_order_num: seqMap[t.trip_id] ?? t.pickup_order_num,
            drop_sequence_num: dropMap[t.trip_id] ?? t.drop_sequence_num,
          };
        }
        return t;
      });

      const newDriverStatus = state.driver_status.map(d =>
        d.driver_id === action.driver_id
          ? { ...d, state: DRIVER_STATE.BUSY, current_trip_id: action.trip_id } : d
      );

      const driverUser = state.users.find(u => u.id === action.driver_id);
      const driverRec = state.driver_status.find(d => d.driver_id === action.driver_id);
      const newLoad = currentLoad + 1;
      const isFullyBooked = newLoad >= DRIVER_CAPACITY;

      const notif = {
        id: mkId(), type: "DRIVER_ASSIGNED", for_roles: [ROLE.AGENT],
        for_user_ids: [...trip.agent_ids],
        message: `Driver ${driverUser?.name} (${driverRec?.vehicle}) assigned. You are pickup #${seqMap[action.trip_id]}, drop-off #${dropMap[action.trip_id]}.`,
        trip_id: action.trip_id, ts: now(), read: false,
      };

      const notifications = [notif, ...state.notifications];
      if (isFullyBooked) {
        notifications.unshift({
          id: mkId(), type: "DRIVER_FULLY_BOOKED", for_roles: [ROLE.ADMIN],
          message: `⚠ Driver ${driverUser?.name} is now FULLY BOOKED (${DRIVER_CAPACITY}/${DRIVER_CAPACITY} seats).`,
          ts: now(), read: false,
        });
      }

      return { ...state, trips: newTrips, driver_status: newDriverStatus, notifications, _error: null };
    }

    case "TRIP/DRIVER_CONFIRM": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return state;
      try { assertTripTransition(trip.state, TRIP_STATE.DRIVER_CONFIRMED); }
      catch (e) { return { ...state, _error: e.message }; }
      const nowTs = now();
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id
          ? { ...t, state: TRIP_STATE.DRIVER_CONFIRMED, confirmed_at: nowTs, tripStartedAt: nowTs } : t
      );
      const notif = {
        id: mkId(), type: "TRIP_CONFIRMED", for_roles: [ROLE.AGENT],
        for_user_ids: [...trip.agent_ids],
        message: "Your driver has confirmed the trip. They are on the way.",
        trip_id: action.trip_id, ts: nowTs, read: false,
      };
      return { ...state, trips: newTrips, notifications: [notif, ...state.notifications], _error: null };
    }

    case "TRIP/ACCEPT": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return state;
      const driverUser = state.users.find(u => u.id === trip.driver_id);
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id ? { ...t, driverAccepted: true, acceptedAt: now() } : t
      );
      const notif = {
        id: mkId(), type: "TRIP_ACCEPTED", for_roles: [ROLE.AGENT, ROLE.ADMIN],
        for_user_ids: [...trip.agent_ids],
        message: `Driver ${driverUser?.name} accepted your trip.`,
        trip_id: action.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTrips, notifications: [notif, ...state.notifications], _error: null };
    }

    case "TRIP/DECLINE": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return state;
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id
          ? {
              ...t, state: TRIP_STATE.UNASSIGNED_BOOKING, driver_id: null,
              pickup_order_num: null, drop_sequence_num: null,
              driverAccepted: false, declinedBy: [...(t.declinedBy || []), action.driver_id],
            }
          : t
      );
      const remaining = newTrips.filter(t =>
        t.driver_id === action.driver_id &&
        [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)
      );
      const newDriverStatus = remaining.length === 0
        ? state.driver_status.map(d =>
            d.driver_id === action.driver_id
              ? { ...d, state: DRIVER_STATE.AVAILABLE, current_trip_id: null } : d)
        : state.driver_status;
      const driverUser = state.users.find(u => u.id === action.driver_id);
      const notif = {
        id: mkId(), type: "TRIP_DECLINED", for_roles: [ROLE.ADMIN],
        message: `Driver ${driverUser?.name} declined trip ${action.trip_id}. Needs reassignment.`,
        trip_id: action.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTrips, driver_status: newDriverStatus, notifications: [notif, ...state.notifications], _error: null };
    }

    case "TRIP/CONFIRM_AGENT_PICKUP": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return state;
      const newCompleted = [...trip.completed_pickups, action.agent_id];
      const allPickedUp = trip.agent_ids.every(id => newCompleted.includes(id));
      const nextNavIdx = (trip.current_nav_idx || 0) + 1;
      const nowTs = now();
      let newState = trip.state;
      let inTransitAt = trip.in_transit_at;
      if (allPickedUp && trip.state !== TRIP_STATE.IN_TRANSIT) {
        try { assertTripTransition(trip.state, TRIP_STATE.IN_TRANSIT); }
        catch (e) { return { ...state, _error: e.message }; }
        newState = TRIP_STATE.IN_TRANSIT;
        inTransitAt = nowTs;
      }
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id
          ? { ...t, state: newState, in_transit_at: inTransitAt, completed_pickups: newCompleted, current_nav_idx: nextNavIdx }
          : t
      );
      const notifs = allPickedUp ? [{
        id: mkId(), type: "IN_TRANSIT", for_roles: [ROLE.ADMIN],
        message: `Trip ${action.trip_id}: all passengers picked up. Now in transit.`,
        trip_id: action.trip_id, ts: nowTs, read: false,
      }] : [];
      return { ...state, trips: newTrips, notifications: [...notifs, ...state.notifications], _error: null };
    }

    case "TRIP/COMPLETE": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip) return state;
      try { assertTripTransition(trip.state, TRIP_STATE.ARCHIVED_COMPLETED); }
      catch (e) { return { ...state, _error: e.message }; }
      const drvStatus = state.driver_status.find(d => d.driver_id === trip.driver_id);
      if (!drvStatus) return { ...state, _error: `Driver status not found for ${action.trip_id}` };

      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id
          ? { ...t, state: TRIP_STATE.ARCHIVED_COMPLETED, completed_at: now(), actual_distance_km: t.est_distance_km }
          : t
      );

      const remaining = newTrips.filter(t =>
        t.driver_id === trip.driver_id &&
        [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)
      );
      const newDriverStatus = state.driver_status.map(d =>
        d.driver_id === trip.driver_id
          ? { ...d, state: remaining.length === 0 ? DRIVER_STATE.AVAILABLE : DRIVER_STATE.BUSY, current_trip_id: remaining[0]?.trip_id || null }
          : d
      );

      const agentNotifs = trip.agent_ids.map(aid => ({
        id: mkId(), type: "TRIP_COMPLETED", for_roles: [ROLE.AGENT], for_user_ids: [aid],
        message: "Your trip has been completed and archived.",
        trip_id: action.trip_id, ts: now(), read: false,
      }));
      const adminNotif = {
        id: mkId(), type: "TRIP_COMPLETED", for_roles: [ROLE.ADMIN],
        message: `Trip ${action.trip_id} archived. Driver ${trip.driver_id} has ${remaining.length} trips remaining.`,
        trip_id: action.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTrips, driver_status: newDriverStatus, notifications: [...agentNotifs, adminNotif, ...state.notifications], _error: null };
    }

    case "TRIP/SEND_CHAT":
    case "CHAT/SEND": {
      const msg = {
        id: mkId(), sender_id: action.sender_id, sender_name: action.sender_name,
        sender_role: action.sender_role, text: action.text, ts: now(),
      };
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id
          ? { ...t, chat_messages: [...(t.chat_messages || []), msg] } : t
      );
      return { ...state, trips: newTrips };
    }

    case "NOTIF/MARK_READ":
      return { ...state, notifications: state.notifications.map(n => n.id === action.id ? { ...n, read: true } : n) };
    case "NOTIF/MARK_ALL_READ":
      return { ...state, notifications: state.notifications.map(n => ({ ...n, read: true })) };

    case "TRIP/SEND_REMINDER": {
      const trip = state.trips.find(t => t.trip_id === action.trip_id);
      if (!trip || trip.reminder_sent) return state;
      const newTrips = state.trips.map(t =>
        t.trip_id === action.trip_id ? { ...t, reminder_sent: true } : t
      );
      const notif = {
        id: mkId(), type: "UPCOMING_TRIP", for_roles: [ROLE.AGENT],
        for_user_ids: [...trip.agent_ids],
        message: `Reminder: your trip from ${trip.custom_pickup} departs at ${trip.scheduled_time}.`,
        trip_id: action.trip_id, ts: now(), read: false,
      };
      return { ...state, trips: newTrips, notifications: [notif, ...state.notifications] };
    }

    case "_CLEAR_ERROR":
      return { ...state, _error: null };

    default:
      return state;
  }
}

/* ---------- SUPABASE-BACKED STORE HOOK ----------
   Same action-type contract as the in-memory reducer above, so every
   screen calls dispatch({ type: "...", ... }) identically regardless of
   which backend is active. Falls back to the in-memory reducer if
   Supabase isn't configured or a connection can't be established, so the
   app is fully demoable even without a working database connection. */

// ── Mapping layer ──────────────────────────────────────────────────
// The real Supabase schema stores every migrated column in unquoted
// lowercase (e.g. staffnumber, driverid, extraagentids) since Postgres
// folds unquoted identifiers to lowercase. The functions below are the
// ONLY place that talks to those real column names — everything else
// in the app (reducer, UI) keeps using the clean snake_case shape.
// id columns are bigint (DB-generated), not app-generated USR_/TRP_
// strings — see ADMIN/CREATE_USER and TRIP/BOOK for insert+readback.
function userRowToApp(row) {
  const user = { id: row.id, role: row.role, name: row.fullname, staff_number: row.staffnumber || null, auth: { login: row.username, pass: row.passwordhash } };
  if (row.role === ROLE.AGENT && row.homelat != null) {
    user.home_address = { label: row.homeaddress, area: row.homearea, lat: row.homelat, lng: row.homelng };
  }
  if (row.role === ROLE.AGENT) {
    user.branch_id = row.branchid || null;
    user.branch_history = Array.isArray(row.branchhistory) ? row.branchhistory : [];
  }
  return user;
}
function driverStatusRowToApp(row) {
  return { driver_id: row.driverid, state: row.state, current_trip_id: row.currenttripid, vehicle: row.vehicle, phone: row.phone, capacity: row.capacity };
}
function tripRowToApp(row, chatByTrip) {
  const firstPickup = row.pickuplat != null ? [{ lat: row.pickuplat, lng: row.pickuplng, label: row.pickuplabel, agent_id: row.agentid }] : [];
  const extraPickups = Array.isArray(row.extrapickups) ? row.extrapickups : [];
  return {
    trip_id: row.id, agent_ids: [row.agentid, ...(row.extraagentids || [])].filter(Boolean), driver_id: row.driverid, state: row.status,
    pickup_sequence_coords: [...firstPickup, ...extraPickups],
    dropoff_sequence_coords: row.dropofflat != null ? [{ lat: row.dropofflat, lng: row.dropofflng, label: row.dropofflabel }] : [],
    completed_pickups: row.completedpickups || [], custom_pickup: row.pickuplocation, custom_dropoff: row.dropofflocation,
    dropoff_company_id: row.dropoffcompanyid, trip_type: row.triptype, scheduled_date: row.scheduleddate,
    scheduled_time: row.scheduledtimestr || row.scheduledtime, scheduled_time_epoch: row.scheduledtime,
    booked_at: epochToDisplay(row.bookedat), confirmed_at: epochToDisplay(row.confirmedat),
    in_transit_at: epochToDisplay(row.intransitat), completed_at: epochToDisplay(row.completedat),
    agent_name: row.agentname, phone: row.phone, pickup_order_num: row.pickupordernum, drop_sequence_num: row.dropsequencenum,
    est_distance_km: row.estdistancekm, est_cost_zar: row.estcostzar, actual_distance_km: row.actualdistancekm,
    driverAccepted: row.driveraccepted, acceptedAt: epochToDisplay(row.acceptedat), declinedBy: row.declinedby || [], reminder_sent: row.remindersent,
    long_distance_flag: row.longdistanceflag || false, admin_note: row.adminnote || null,
    chat_messages: chatByTrip[row.id] || [],
  };
}
function notifRowToApp(row) {
  return { id: row.id, type: row.type, for_roles: row.forroles || [], for_user_ids: row.userid != null ? [row.userid] : [], message: row.message, trip_id: row.tripid, ts: epochToDisplay(row.timestamp), read: row.isread };
}

async function fetchAllFromSupabase() {
  const [usersRes, driversRes, tripsRes, chatRes, notifsRes] = await Promise.all([
    supabase.from("users").select("*").order("id"),
    supabase.from("driver_status").select("*"),
    supabase.from("trips").select("*").order("id", { ascending: false }),
    supabase.from("messages").select("*").order("timestamp"),
    supabase.from("notifications").select("*").order("timestamp", { ascending: false }),
  ]);
  const firstError = usersRes.error || driversRes.error || tripsRes.error || chatRes.error || notifsRes.error;
  if (firstError) throw firstError;
  const chatByTrip = {};
  for (const m of chatRes.data) {
    (chatByTrip[m.tripid] ||= []).push({ id: m.id, sender_id: m.senderid, sender_name: m.sendername, sender_role: m.senderrole, text: m.content, ts: epochToDisplay(m.timestamp) });
  }
  // The real notifications table is one row per (notification, user) —
  // for_roles broadcasts don't have a userid at all. Group same-broadcast
  // rows (matching type+tripid+timestamp+message, no userid) back into a
  // single for_user_ids array so the rest of the app sees one entry.
  const notifRows = notifsRes.data.map(notifRowToApp);
  const merged = [];
  const seen = new Map();
  for (const n of notifRows) {
    const key = `${n.type}|${n.trip_id}|${n.ts}|${n.message}`;
    if (seen.has(key)) {
      seen.get(key).for_user_ids.push(...n.for_user_ids);
    } else {
      const copy = { ...n, for_user_ids: [...n.for_user_ids] };
      seen.set(key, copy);
      merged.push(copy);
    }
  }
  return {
    users: usersRes.data.map(userRowToApp),
    driver_status: driversRes.data.map(driverStatusRowToApp),
    trips: tripsRes.data.map(r => tripRowToApp(r, chatByTrip)),
    notifications: merged,
  };
}

// The real notifications table has a single nullable `userid` column, not
// an array — this fans a { for_roles, for_user_ids, ... } notification out
// into one row per target user (or a single role-only broadcast row when
// for_user_ids is empty), matching what fetchAllFromSupabase re-merges.
async function insertNotification(n) {
  const base = { type: n.type, forroles: n.for_roles || [], message: n.message, tripid: n.trip_id ?? null, timestamp: n.ts, isread: n.read ?? false };
  const userIds = n.for_user_ids && n.for_user_ids.length ? n.for_user_ids : [null];
  const rows = userIds.map(uid => ({ ...base, userid: uid }));
  return supabase.from("notifications").insert(rows);
}

async function handleSupabaseAction(action, activeUserRef, refetch) {
  switch (action.type) {
    case "AUTH/LOGIN": {
      const { data, error } = await supabase.from("users").select("*").eq("username", action.login).eq("passwordhash", action.pass).maybeSingle();
      if (error) throw error;
      if (!data) throw new Error("Invalid credentials");
      activeUserRef.current = data.id;
      await refetch();
      return;
    }
    case "AUTH/LOGOUT":
      activeUserRef.current = null;
      await refetch();
      return;
    case "ADMIN/UPDATE_USER": {
      const { data: target } = await supabase.from("users").select("*").eq("id", action.user_id).single();
      if (!target) throw new Error("User not found");
      const update = {
        fullname: action.name ?? target.fullname,
        staffnumber: action.staff_number ?? target.staffnumber,
        username: action.login ?? target.username,
        passwordhash: action.pass || target.passwordhash,
      };
      if (target.role === ROLE.AGENT && action.home_address !== undefined) {
        update.homeaddress = action.home_address?.label ?? null;
        update.homearea = action.home_address?.area ?? null;
        update.homelat = action.home_address?.lat ?? null;
        update.homelng = action.home_address?.lng ?? null;
      }

      // ── Branch reassignment tracking (same >40 km rule as the in-memory
      // reducer — see that case for the full explanation). ──
      let branchNotifRow = null;
      if (target.role === ROLE.AGENT && action.branch_id !== undefined && action.branch_id !== target.branchid) {
        const newBranch = COMPANY_LOCATIONS.find(b => b.id === action.branch_id);
        const homeLat = action.home_address !== undefined ? action.home_address?.lat : target.homelat;
        const homeLng = action.home_address !== undefined ? action.home_address?.lng : target.homelng;
        let distKm = null;
        if (newBranch && homeLat != null) distKm = haversineKm(homeLat, homeLng, newBranch.lat, newBranch.lng) * 1.35;
        const farReassignment = distKm != null && distKm > 40;

        update.branchid = action.branch_id;
        if (farReassignment && target.branchid) {
          const prevHistory = Array.isArray(target.branchhistory) ? target.branchhistory : [];
          update.branchhistory = [...prevHistory, { branch_id: target.branchid, changed_at: nowEpoch(), reason: `Reassigned to ${newBranch?.label || action.branch_id} (${distKm.toFixed(1)} km from home) — previous branch kept on file.` }];
        }
        if (farReassignment) {
          branchNotifRow = {
            type: "BRANCH_REASSIGNED_FAR", for_roles: [ROLE.ADMIN],
            message: `📍 ${target.fullname} reassigned to ${newBranch?.label || action.branch_id}, which is ${distKm.toFixed(1)} km from their home address. Previous branch retained on file.`,
            ts: nowEpoch(), read: false,
          };
        }
      }

      const { error } = await supabase.from("users").update(update).eq("id", action.user_id);
      if (error) throw error;
      if (target.role === ROLE.DRIVER && (action.vehicle !== undefined || action.phone !== undefined)) {
        const dsUpdate = {};
        if (action.vehicle !== undefined) dsUpdate.vehicle = action.vehicle;
        if (action.phone !== undefined) dsUpdate.phone = action.phone;
        const { error: dErr } = await supabase.from("driver_status").update(dsUpdate).eq("driverid", action.user_id);
        if (dErr) throw dErr;
      }
      if (action.name) {
        // Keep the denormalized agentname in sync on that agent's own trips
        // (mirrors the in-memory reducer's behaviour) — only the primary
        // agent slot, since extrapickups entries carry their own agent_id.
        const { data: theirTrips } = await supabase.from("trips").select("id, agentid").eq("agentid", action.user_id);
        for (const t of theirTrips || []) {
          await supabase.from("trips").update({ agentname: action.name }).eq("id", t.id);
        }
      }
      if (branchNotifRow) await insertNotification(branchNotifRow);
      await refetch();
      return;
    }
    case "TRIP/ADD_AGENT": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const currentAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      if (currentAgentIds.includes(action.agent_id)) throw new Error("Agent is already on this trip");
      if (tripRow.status === TRIP_STATE.ARCHIVED_COMPLETED) throw new Error("Cannot add a passenger to a completed trip");

      const newExtraAgentIds = [...(tripRow.extraagentids || []), action.agent_id];
      const newExtraPickups = [...(tripRow.extrapickups || []), { lat: action.pickup_coord.lat, lng: action.pickup_coord.lng, label: action.pickup_label, agent_id: action.agent_id }];

      const { error: upErr } = await supabase.from("trips").update({ extraagentids: newExtraAgentIds, extrapickups: newExtraPickups }).eq("id", action.trip_id);
      if (upErr) throw upErr;

      // Re-sequence this driver's active trips the same way ASSIGN_DRIVER does,
      // since the new pickup point may now be geographically first for someone.
      if (tripRow.driverid) {
        const { data: driverTripsRaw } = await supabase.from("trips").select("*").eq("driverid", tripRow.driverid).neq("status", TRIP_STATE.ARCHIVED_COMPLETED);
        const allForDriver = (driverTripsRaw || []).map(r => {
          const first = r.pickuplat != null ? [{ lat: r.pickuplat, lng: r.pickuplng }] : [];
          const extra = (r.id === action.trip_id ? newExtraPickups : (r.extrapickups || [])).map(p => ({ lat: p.lat, lng: p.lng }));
          return { trip_id: r.id, pickup_sequence_coords: [...first, ...extra] };
        });
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        for (const t of driverTripsRaw || []) {
          if (seqMap[t.id] != null && seqMap[t.id] !== t.pickupordernum) {
            await supabase.from("trips").update({ pickupordernum: seqMap[t.id] }).eq("id", t.id);
          }
        }
      }

      await insertNotification({
        type: "TRIP_BOOKED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `You've been added to trip ${action.trip_id} (pickup: ${action.pickup_label}).`,
        trip_id: action.trip_id, ts: nowEpoch(), read: false,
      });
      await refetch();
      return;
    }

    case "TRIP/REMOVE_AGENT": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const agentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      if (!agentIds.includes(action.agent_id)) throw new Error("Agent is not on this trip");
      if (agentIds.length <= 1) throw new Error("Cannot remove the last passenger — cancel or reassign the trip instead");
      if (tripRow.status === TRIP_STATE.ARCHIVED_COMPLETED) throw new Error("Cannot remove a passenger from a completed trip");

      const newCompletedPickups = (tripRow.completedpickups || []).filter(id => id !== action.agent_id);
      const wasPrimary = tripRow.agentid === action.agent_id;
      const newExtraPickups = (tripRow.extrapickups || []).filter(p => p.agent_id !== action.agent_id);
      const newExtraAgentIds = (tripRow.extraagentids || []).filter(id => id !== action.agent_id);

      const update = { completedpickups: newCompletedPickups, extrapickups: newExtraPickups, extraagentids: newExtraAgentIds };
      if (wasPrimary) {
        // The removed agent held the primary agentid/pickuplat/lng/label slot —
        // promote the next remaining pickup (first extrapickups entry, if
        // any) into that slot so pickuplat/lng/label stays populated for
        // any code that still reads it directly instead of the merged array.
        const promoted = newExtraPickups[0];
        update.agentid = promoted?.agent_id ?? newExtraAgentIds[0] ?? null;
        if (promoted) {
          update.pickuplat = promoted.lat; update.pickuplng = promoted.lng; update.pickuplabel = promoted.label;
          update.extrapickups = newExtraPickups.slice(1);
          update.extraagentids = newExtraAgentIds.filter(id => id !== promoted.agent_id);
        }
        const { data: newPrimaryUser } = await supabase.from("users").select("fullname").eq("id", update.agentid).maybeSingle();
        if (newPrimaryUser) update.agentname = newPrimaryUser.fullname;
      }

      const { error: rmErr } = await supabase.from("trips").update(update).eq("id", action.trip_id);
      if (rmErr) throw rmErr;

      if (tripRow.driverid) {
        const { data: driverTripsRaw } = await supabase.from("trips").select("*").eq("driverid", tripRow.driverid).neq("status", TRIP_STATE.ARCHIVED_COMPLETED);
        const allForDriver = (driverTripsRaw || []).map(r => {
          const isThisTrip = r.id === action.trip_id;
          const first = (isThisTrip ? update.pickuplat ?? r.pickuplat : r.pickuplat) != null
            ? [{ lat: isThisTrip ? (update.pickuplat ?? r.pickuplat) : r.pickuplat, lng: isThisTrip ? (update.pickuplng ?? r.pickuplng) : r.pickuplng }]
            : [];
          const extra = (isThisTrip ? (update.extrapickups ?? newExtraPickups) : (r.extrapickups || [])).map(p => ({ lat: p.lat, lng: p.lng }));
          return { trip_id: r.id, pickup_sequence_coords: [...first, ...extra] };
        });
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        for (const t of driverTripsRaw || []) {
          if (seqMap[t.id] != null && seqMap[t.id] !== t.pickupordernum) {
            await supabase.from("trips").update({ pickupordernum: seqMap[t.id] }).eq("id", t.id);
          }
        }
      }

      await insertNotification({
        type: "TRIP_UPDATED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `You've been removed from trip ${action.trip_id}.`,
        trip_id: action.trip_id, ts: nowEpoch(), read: false,
      });
      await refetch();
      return;
    }

    case "TRIP/RELOCATE_AGENT": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const agentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      if (!agentIds.includes(action.agent_id)) throw new Error("Agent is not on this trip");
      if (tripRow.status === TRIP_STATE.ARCHIVED_COMPLETED) throw new Error("Cannot relocate a passenger on a completed trip");

      const isPrimary = tripRow.agentid === action.agent_id;
      const update = {};
      if (isPrimary) {
        update.pickuplat = action.pickup_coord.lat; update.pickuplng = action.pickup_coord.lng; update.pickuplabel = action.pickup_label;
      } else {
        update.extrapickups = (tripRow.extrapickups || []).map(p =>
          p.agent_id === action.agent_id ? { lat: action.pickup_coord.lat, lng: action.pickup_coord.lng, label: action.pickup_label, agent_id: action.agent_id } : p
        );
      }

      const { error: relErr } = await supabase.from("trips").update(update).eq("id", action.trip_id);
      if (relErr) throw relErr;

      if (tripRow.driverid) {
        const { data: driverTripsRaw } = await supabase.from("trips").select("*").eq("driverid", tripRow.driverid).neq("status", TRIP_STATE.ARCHIVED_COMPLETED);
        const allForDriver = (driverTripsRaw || []).map(r => {
          const isThisTrip = r.id === action.trip_id;
          const lat = isThisTrip ? (update.pickuplat ?? r.pickuplat) : r.pickuplat;
          const lng = isThisTrip ? (update.pickuplng ?? r.pickuplng) : r.pickuplng;
          const first = lat != null ? [{ lat, lng }] : [];
          const extra = (isThisTrip ? (update.extrapickups ?? r.extrapickups ?? []) : (r.extrapickups || [])).map(p => ({ lat: p.lat, lng: p.lng }));
          return { trip_id: r.id, pickup_sequence_coords: [...first, ...extra] };
        });
        const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
        const seqMap = {};
        ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
        for (const t of driverTripsRaw || []) {
          if (seqMap[t.id] != null && seqMap[t.id] !== t.pickupordernum) {
            await supabase.from("trips").update({ pickupordernum: seqMap[t.id] }).eq("id", t.id);
          }
        }
      }

      await insertNotification({
        type: "TRIP_UPDATED", for_roles: [ROLE.AGENT], for_user_ids: [action.agent_id],
        message: `Your pickup for trip ${action.trip_id} was moved to ${action.pickup_label}.`,
        trip_id: action.trip_id, ts: nowEpoch(), read: false,
      });
      await refetch();
      return;
    }
    case "ADMIN/CREATE_USER": {
      const row = {
        role: action.role, fullname: action.name, username: action.auth.login, passwordhash: action.auth.pass,
        staffnumber: action.staff_number || action.auth.pass || null,
        homeaddress: action.home_address?.label ?? null, homearea: action.home_address?.area ?? null,
        homelat: action.home_address?.lat ?? null, homelng: action.home_address?.lng ?? null,
        ...(action.role === ROLE.AGENT ? { branchid: action.branch_id || COMPANY_LOCATIONS[0].id, branchhistory: [] } : {}),
      };
      // Real users.id is a DB-generated bigint, not an app-generated string —
      // insert and read the id back so driver_status can reference it.
      const { data: inserted, error } = await supabase.from("users").insert(row).select("id").single();
      if (error) throw error;
      if (action.role === ROLE.DRIVER) {
        const { error: dErr } = await supabase.from("driver_status").insert({
          driverid: inserted.id, state: DRIVER_STATE.AVAILABLE, currenttripid: null,
          vehicle: action.vehicle || "—", phone: action.phone || "—", capacity: DRIVER_CAPACITY,
        });
        if (dErr) throw dErr;
      }
      await refetch();
      return;
    }
    case "TRIP/BOOK": {
      const pickupCoord = action.pickup_coord || { lat: -33.9249, lng: 18.4241, label: action.pickup_label };
      const dropCoord = action.dropoff_coord || COMPANY_LOCATIONS[0];
      const estDistKm = haversineKm(pickupCoord.lat, pickupCoord.lng, dropCoord.lat, dropCoord.lng);
      const estCostZar = parseFloat((8 + estDistKm * 1.35 * 3.5).toFixed(2));
      const roadDistKm = estDistKm * 1.35;
      const nowTs = nowEpoch();

      // scheduledtime is a bigint (epoch ms) column, but the booking form
      // sends separate date/time strings — convert here rather than pass
      // the raw string through, which Postgres rejects with 22P02.
      const scheduledDtForInsert = parseScheduledDateTime(action.scheduled_date, action.scheduled_time);
      const scheduledTimeEpoch = scheduledDtForInsert ? scheduledDtForInsert.getTime() : null;
      if (scheduledTimeEpoch == null) {
        throw new Error(`Couldn't understand the scheduled date/time ("${action.scheduled_date}" "${action.scheduled_time}"). Please use YYYY/MM/DD for the date and HH:MM for the time.`);
      }

      // Real trips.id is a DB-generated bigint — insert and read it back
      // before building notifications that reference trip_id.
      const { data: inserted, error } = await supabase.from("trips").insert({
        agentid: action.agent_id, driverid: null, status: TRIP_STATE.UNASSIGNED_BOOKING,
        pickuplat: pickupCoord.lat, pickuplng: pickupCoord.lng, pickuplabel: action.pickup_label,
        dropofflat: dropCoord.lat, dropofflng: dropCoord.lng, dropofflabel: action.dropoff_label,
        completedpickups: [], pickuplocation: action.pickup_label, dropofflocation: action.dropoff_label,
        dropoffcompanyid: action.dropoff_company_id || null, triptype: action.trip_type,
        scheduleddate: action.scheduled_date, scheduledtime: scheduledTimeEpoch, scheduledtimestr: action.scheduled_time,
        bookedat: nowTs, agentname: action.agent_name, phone: action.phone,
        estdistancekm: estDistKm, estcostzar: estCostZar, driveraccepted: false, declinedby: [], remindersent: false,
        longdistanceflag: roadDistKm > 40,
        adminnote: roadDistKm > 42 ? `Booking distance ${roadDistKm.toFixed(1)} km exceeds 42 km threshold.` : null,
      }).select("id").single();
      if (error) throw error;
      const tripId = inserted.id;

      const notifRows = [{
        type: "TRIP_BOOKED", for_roles: [ROLE.ADMIN],
        message: `New booking from ${action.agent_name}: ${action.pickup_label} → ${action.dropoff_label}`,
        trip_id: tripId, ts: nowTs, read: false,
      }];

      if (roadDistKm > 40) {
        notifRows.push({
          type: "LONG_DISTANCE_TRIP", for_roles: [ROLE.ADMIN],
          message: `⚠ Trip ${tripId} for ${action.agent_name} is ${roadDistKm.toFixed(1)} km — exceeds the 40 km threshold.`,
          trip_id: tripId, ts: nowTs, read: false,
        });
      }

      // Surcharge: R20 for every km over 40, uncapped.
      if (roadDistKm > 42) {
        const billableKm = roadDistKm - 40;
        const surcharge = Math.round(billableKm * 20);
        notifRows.push({
          type: "DISTANCE_SURCHARGE", for_roles: [ROLE.ADMIN],
          message: `💰 Trip ${tripId} (${roadDistKm.toFixed(1)} km) qualifies for a distance surcharge: R${surcharge} (${billableKm.toFixed(1)} km over 40 km @ R20/km) — for invoicing.`,
          trip_id: tripId, ts: nowTs, read: false,
        });
      }

      try {
        const scheduledDt = parseScheduledDateTime(action.scheduled_date, action.scheduled_time);
        if (scheduledDt) {
          const hoursUntil = (scheduledDt.getTime() - Date.now()) / 3600000;
          if (hoursUntil < 2) {
            notifRows.push({
              type: "LATE_BOOKING", for_roles: [ROLE.ADMIN],
              message: `⏰ LATE BOOKING: ${action.agent_name} booked trip ${tripId} only ${hoursUntil < 0 ? "after" : hoursUntil.toFixed(1) + "h before"} the scheduled time (${action.scheduled_date} ${action.scheduled_time}).`,
              trip_id: tripId, ts: nowTs, read: false,
            });
          }
        }
      } catch (e) { /* malformed date/time — skip late-booking check */ }

      for (const row of notifRows) await insertNotification(row);
      await refetch();
      return;
    }
    case "TRIP/ASSIGN_DRIVER": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      const { data: driverRow } = await supabase.from("driver_status").select("*").eq("driverid", action.driver_id).single();
      if (!tripRow || !driverRow) throw new Error("Trip or driver not found");
      const { data: driverTripsRaw } = await supabase.from("trips").select("*").eq("driverid", action.driver_id).neq("status", TRIP_STATE.ARCHIVED_COMPLETED);
      const currentLoad = (driverTripsRaw || []).length;
      if (currentLoad >= DRIVER_CAPACITY) throw new Error(`Driver is fully booked (${DRIVER_CAPACITY}/${DRIVER_CAPACITY} seats).`);
      assertTripTransition(tripRow.status, TRIP_STATE.DRIVER_CONFIRMED);
      const existingAssigned = (driverTripsRaw || []).filter(t => t.id !== action.trip_id);
      const allForDriver = [...existingAssigned, { ...tripRow, driverid: action.driver_id }].map(r => ({
        trip_id: r.id,
        pickup_sequence_coords: r.pickuplat != null ? [{ lat: r.pickuplat, lng: r.pickuplng }] : [],
        dropoff_sequence_coords: r.dropofflat != null ? [{ lat: r.dropofflat, lng: r.dropofflng }] : [],
        scheduled_time: r.scheduledtime,
      }));
      const ordered = buildPickupSequence(allForDriver, COMPANY_LOCATIONS[1]);
      const dropOrdered = buildDropoffSequence(allForDriver);
      const seqMap = {}, dropMap = {};
      ordered.forEach((o, i) => { seqMap[o.trip.trip_id] = i + 1; });
      dropOrdered.forEach((t, i) => { dropMap[t.trip_id] = i + 1; });
      const nowTs = nowEpoch();
      const { error: upErr } = await supabase.from("trips").update({
        status: TRIP_STATE.DRIVER_CONFIRMED, driverid: action.driver_id,
        pickupordernum: seqMap[action.trip_id], dropsequencenum: dropMap[action.trip_id],
        driveraccepted: true, acceptedat: nowTs, confirmedat: nowTs, updatedat: nowTs,
      }).eq("id", action.trip_id);
      if (upErr) throw upErr;
      for (const t of existingAssigned) {
        await supabase.from("trips").update({
          pickupordernum: seqMap[t.id] ?? t.pickupordernum,
          dropsequencenum: dropMap[t.id] ?? t.dropsequencenum,
        }).eq("id", t.id);
      }
      const newLoad = currentLoad + 1;
      await supabase.from("driver_status").update({ state: DRIVER_STATE.BUSY, currenttripid: action.trip_id, updatedat: nowTs }).eq("driverid", action.driver_id);
      const { data: driverUser } = await supabase.from("users").select("fullname").eq("id", action.driver_id).single();
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      await insertNotification({
        type: "DRIVER_ASSIGNED", for_roles: [ROLE.AGENT], for_user_ids: tripAgentIds,
        message: `Driver ${driverUser?.fullname} (${driverRow.vehicle}) assigned. You are pickup #${seqMap[action.trip_id]}, drop-off #${dropMap[action.trip_id]}.`,
        trip_id: action.trip_id, ts: nowTs, read: false,
      });
      if (newLoad >= DRIVER_CAPACITY) {
        await insertNotification({
          type: "DRIVER_FULLY_BOOKED", for_roles: [ROLE.ADMIN],
          message: `⚠ Driver ${driverUser?.fullname} is now FULLY BOOKED (${DRIVER_CAPACITY}/${DRIVER_CAPACITY} seats).`,
          ts: nowTs, read: false,
        });
      }
      await refetch();
      return;
    }
    case "TRIP/DRIVER_CONFIRM": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      assertTripTransition(tripRow.status, TRIP_STATE.DRIVER_CONFIRMED);
      const nowTs = nowEpoch();
      await supabase.from("trips").update({ status: TRIP_STATE.DRIVER_CONFIRMED, confirmedat: nowTs, updatedat: nowTs }).eq("id", action.trip_id);
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      await insertNotification({
        type: "TRIP_CONFIRMED", for_roles: [ROLE.AGENT], for_user_ids: tripAgentIds,
        message: "Your driver has confirmed the trip. They are on the way.", trip_id: action.trip_id, ts: nowTs, read: false,
      });
      await refetch();
      return;
    }
    case "TRIP/ACCEPT": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const { data: driverUser } = await supabase.from("users").select("fullname").eq("id", tripRow.driverid).single();
      const nowTs = nowEpoch();
      await supabase.from("trips").update({ driveraccepted: true, acceptedat: nowTs, updatedat: nowTs }).eq("id", action.trip_id);
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      await insertNotification({
        type: "TRIP_ACCEPTED", for_roles: [ROLE.AGENT, ROLE.ADMIN], for_user_ids: tripAgentIds,
        message: `Driver ${driverUser?.fullname} accepted your trip.`, trip_id: action.trip_id, ts: nowTs, read: false,
      });
      await refetch();
      return;
    }
    case "TRIP/DECLINE": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const nowTs = nowEpoch();
      await supabase.from("trips").update({
        status: TRIP_STATE.UNASSIGNED_BOOKING, driverid: null, pickupordernum: null, dropsequencenum: null,
        driveraccepted: false, declinedby: [...(tripRow.declinedby || []), action.driver_id], updatedat: nowTs,
      }).eq("id", action.trip_id);
      const { data: remaining } = await supabase.from("trips").select("id").eq("driverid", action.driver_id)
        .in("status", [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT]);
      if (!remaining || remaining.length === 0) {
        await supabase.from("driver_status").update({ state: DRIVER_STATE.AVAILABLE, currenttripid: null }).eq("driverid", action.driver_id);
      }
      const { data: driverUser } = await supabase.from("users").select("fullname").eq("id", action.driver_id).single();
      await insertNotification({
        type: "TRIP_DECLINED", for_roles: [ROLE.ADMIN],
        message: `Driver ${driverUser?.fullname} declined trip ${action.trip_id}. Needs reassignment.`,
        trip_id: action.trip_id, ts: nowTs, read: false,
      });
      await refetch();
      return;
    }
    case "TRIP/CONFIRM_AGENT_PICKUP": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      const newCompleted = [...(tripRow.completedpickups || []), action.agent_id];
      const allPickedUp = tripAgentIds.every(id => newCompleted.includes(id));
      const nowTs = nowEpoch();
      let newState = tripRow.status, inTransitAt = tripRow.intransitat;
      if (allPickedUp && tripRow.status !== TRIP_STATE.IN_TRANSIT) {
        assertTripTransition(tripRow.status, TRIP_STATE.IN_TRANSIT);
        newState = TRIP_STATE.IN_TRANSIT;
        inTransitAt = nowTs;
      }
      await supabase.from("trips").update({ status: newState, intransitat: inTransitAt, completedpickups: newCompleted, updatedat: nowTs }).eq("id", action.trip_id);
      if (allPickedUp) {
        await insertNotification({
          type: "IN_TRANSIT", for_roles: [ROLE.ADMIN],
          message: `Trip ${action.trip_id}: all passengers picked up. Now in transit.`, trip_id: action.trip_id, ts: nowTs, read: false,
        });
      }
      await refetch();
      return;
    }
    case "TRIP/COMPLETE": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow) throw new Error("Trip not found");
      assertTripTransition(tripRow.status, TRIP_STATE.ARCHIVED_COMPLETED);
      const { data: driverRow } = await supabase.from("driver_status").select("*").eq("driverid", tripRow.driverid).maybeSingle();
      if (!driverRow) throw new Error(`Driver status not found for ${action.trip_id}`);
      const nowTs = nowEpoch();
      await supabase.from("trips").update({ status: TRIP_STATE.ARCHIVED_COMPLETED, completedat: nowTs, actualdistancekm: tripRow.estdistancekm, updatedat: nowTs }).eq("id", action.trip_id);
      const { data: remaining } = await supabase.from("trips").select("id").eq("driverid", tripRow.driverid)
        .in("status", [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT]);
      const stillBusy = (remaining || []).filter(r => r.id !== action.trip_id);
      await supabase.from("driver_status").update({
        state: stillBusy.length === 0 ? DRIVER_STATE.AVAILABLE : DRIVER_STATE.BUSY,
        currenttripid: stillBusy[0]?.id || null,
      }).eq("driverid", tripRow.driverid);
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      const agentNotifs = tripAgentIds.map(aid => ({
        type: "TRIP_COMPLETED", for_roles: [ROLE.AGENT], for_user_ids: [aid],
        message: "Your trip has been completed and archived.", trip_id: action.trip_id, ts: nowTs, read: false,
      }));
      for (const row of agentNotifs) await insertNotification(row);
      await insertNotification({ type: "TRIP_COMPLETED", for_roles: [ROLE.ADMIN], message: `Trip ${action.trip_id} archived. Driver ${tripRow.driverid} has ${stillBusy.length} trips remaining.`, ts: nowTs, read: false });
      await refetch();
      return;
    }
    case "TRIP/SEND_CHAT":
    case "CHAT/SEND": {
      await supabase.from("messages").insert({
        tripid: action.trip_id, senderid: action.sender_id, sendername: action.sender_name,
        senderrole: action.sender_role, content: action.text, timestamp: nowEpoch(),
      });
      await refetch();
      return;
    }
    case "NOTIF/MARK_READ":
      await supabase.from("notifications").update({ isread: true }).eq("id", action.id);
      await refetch();
      return;
    case "NOTIF/MARK_ALL_READ":
      await supabase.from("notifications").update({ isread: true }).neq("id", -1);
      await refetch();
      return;
    case "TRIP/SEND_REMINDER": {
      const { data: tripRow } = await supabase.from("trips").select("*").eq("id", action.trip_id).single();
      if (!tripRow || tripRow.remindersent) return;
      const nowTs = nowEpoch();
      await supabase.from("trips").update({ remindersent: true }).eq("id", action.trip_id);
      const tripAgentIds = [tripRow.agentid, ...(tripRow.extraagentids || [])].filter(Boolean);
      await insertNotification({
        type: "UPCOMING_TRIP", for_roles: [ROLE.AGENT], for_user_ids: tripAgentIds,
        message: `Reminder: your trip from ${tripRow.pickuplocation} departs at ${tripRow.scheduledtimestr || tripRow.scheduledtime}.`,
        trip_id: action.trip_id, ts: nowTs, read: false,
      });
      await refetch();
      return;
    }
    default:
      return;
  }
}

function useAppStore() {
  const [supaState, setSupaState] = useState(null);
  const [supaError, setSupaError] = useState(null);
  const [useFallback, setUseFallback] = useState(!supabase);
  const activeUserRef = useRef(null);
  const [localState, localDispatch] = useReducer(appReducer, INITIAL_STATE);

  const refetch = useCallback(async () => {
    if (!supabase) return;
    try {
      const fresh = await fetchAllFromSupabase();
      setSupaState({ ...fresh, active_user_id: activeUserRef.current });
      setSupaError(null);
    } catch (e) {
      // Supabase configured but unreachable (bad credentials, network, RLS
      // misconfigured, schema not migrated yet) — fall back to the in-memory
      // reducer so the app is still usable/demoable.
      console.warn("[Supabase] falling back to in-memory store:", e.message);
      setUseFallback(true);
      setSupaError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    refetch();
    const channel = supabase
      .channel("transitos-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "trips" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "driver_status" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "users" }, refetch)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refetch]);

  const dispatch = useCallback(async (action) => {
    if (useFallback || !supabase) {
      localDispatch(action);
      return;
    }
    try {
      await handleSupabaseAction(action, activeUserRef, refetch);
    } catch (e) {
      setSupaError(e.message);
    }
  }, [useFallback, refetch]);

  const loading = !useFallback && !!supabase && supaState === null;
  const state = useFallback || !supabase
    ? { ...localState, _error: null, _loading: false }
    : { ...(supaState || INITIAL_STATE), _error: supaError, _loading: loading };

  return [state, dispatch];
}

/* ============================================================
   SHARED UI COMPONENTS
   ============================================================ */

function StateBadge({ state }) {
  const cfg = STATE_BADGE_MAP[state] || STATE_BADGE_MAP.UNASSIGNED_BOOKING;
  return (
    <span className="state-badge" style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.fg }}>
      <span className="state-dot" style={{ background: cfg.fg }} />
      {cfg.label}
    </span>
  );
}

function RoleBadge({ role }) {
  const cfg = ROLE_BADGE_MAP[role] || ROLE_BADGE_MAP.AGENT;
  return <span className="role-badge" style={{ background: cfg.bg, borderColor: cfg.border, color: cfg.fg }}>{role}</span>;
}

function SectionHeader({ label }) {
  return (
    <div className="sec-hdr">
      <span className="sec-hdr-txt">{label}</span>
      <div className="sec-hdr-line" />
    </div>
  );
}

function Empty({ icon = "◈", text = "No data" }) {
  return (
    <div className="empty">
      <div className="empty-ico">{icon}</div>
      <div className="empty-txt">{text}</div>
    </div>
  );
}

function GpsBlock({ coord }) {
  if (!coord) return null;
  return (
    <div className="gps-block">
      <div className="gps-row"><span className="gps-key">LAT</span><span className="gps-val">{coord.lat?.toFixed(6)}</span></div>
      <div className="gps-row"><span className="gps-key">LNG</span><span className="gps-val">{coord.lng?.toFixed(6)}</span></div>
      <div className="gps-row"><span className="gps-key">LOC</span><span className="gps-val">{coord.label || coord.area || "—"}</span></div>
    </div>
  );
}

function DriverAvatar({ name, size = 42 }) {
  const init = (name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="driver-av" style={{ width: size, height: size, fontSize: size * 0.38, borderRadius: size * 0.07 }}>
      {init}
    </div>
  );
}

function CapacityBar({ load, capacity = DRIVER_CAPACITY }) {
  const pct = Math.min(load / capacity, 1);
  const full = load >= capacity;
  const warn = pct >= CAPACITY_WARN_PCT;
  const color = full ? COLORS.red : warn ? COLORS.amber : COLORS.green;
  return (
    <div className="cap-wrap">
      <div className="cap-label-row">
        <span style={{ color: COLORS.ghost }}>CAPACITY</span>
        <span style={{ color, fontWeight: 700 }}>{load}/{capacity} {full ? "— FULLY BOOKED" : warn ? "— 75%+ BOOKED" : ""}</span>
      </div>
      <div className="cap-track"><div className="cap-fill" style={{ width: `${pct * 100}%`, background: color }} /></div>
    </div>
  );
}

function Button({ title, onClick, variant = "amber", size = "md", full = false, disabled = false, loading = false, style, children }) {
  const cls = `btn btn-${variant}${size === "sm" ? " btn-sm" : ""}${full ? " btn-full" : ""}`;
  return (
    <button className={cls} onClick={onClick} disabled={disabled || loading} style={style}>
      {loading ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : (children || title)}
    </button>
  );
}

function Card({ children, style, body = true }) {
  return <div className={`card${body ? " card-body" : ""}`} style={style}>{children}</div>;
}

function TextField({ label, error, style, ...inputProps }) {
  return (
    <div className="field" style={style}>
      {label ? <label className="field-label">{label}</label> : null}
      <input className={`inp${error ? " err" : ""}`} {...inputProps} />
      {error ? <span style={{ fontSize: 10, color: COLORS.red, marginTop: 2 }}>{error}</span> : null}
    </div>
  );
}

/* ---------- STREET INPUT (GPS-style address autocomplete) ---------- */
function StreetInput({ value, onChange, placeholder, error, preConfirmed }) {
  const [query, setQuery] = useState(value || "");
  const [results, setResults] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [selected, setSelected] = useState(preConfirmed && value ? preConfirmed : null);
  const [isLive, setIsLive] = useState(false);
  const [streetSuggestions, setStreetSuggestions] = useState([]);
  const inputRef = useRef(null);
  const wrapRef = useRef(null);

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

    // Instant street-name suggestions from the bulk street-name table —
    // runs in parallel with the debounced live search below, not blocked
    // by it, since it's meant to show up before the debounce even fires.
    let nameCancelled = false;
    streetNameSearch(query).then(names => {
      if (!nameCancelled) setStreetSuggestions(names);
    });

    // Debounce the live Google call — without this, every keystroke fired
    // its own network request with no cancellation of the in-flight ones,
    // which both wastes quota and can trigger rate limiting on fast typing.
    let cancelled = false;
    const timer = setTimeout(() => {
      unifiedAddressSearch(query).then(({ results: hits, liveOk }) => {
        if (cancelled) return;
        setResults(hits);
        setShowDrop(hits.length > 0);
        setIsLive(liveOk);
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
            <span style={{ fontSize: 10, color: COLORS.ghost }}>{results.length} address{results.length !== 1 ? "es" : ""} found</span>
            <span style={{ fontSize: 8, fontWeight: 700, color: isLive ? COLORS.green : COLORS.dim }}>{isLive ? "● LIVE" : "○ OFFLINE DB"}</span>
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

function LocationSelector({ mode, setMode, companyId, setCompanyId, streetValue, streetCoord, onStreetChange, error, errMsg }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <Button title="🏠 Home / Street" variant={mode === "street" ? "amber" : "ghost"} size="sm" full onClick={() => setMode("street")} style={{ flex: 1 }} />
        <Button title="🏢 Telus Office" variant={mode === "company" ? "amber" : "ghost"} size="sm" full onClick={() => setMode("company")} style={{ flex: 1 }} />
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
          {COMPANY_LOCATIONS.map(loc => {
            const sel = companyId === loc.id;
            return (
              <div key={loc.id} onClick={() => setCompanyId(loc.id)}
                style={{ display: "flex", alignItems: "center", gap: 12, border: `1px solid ${sel ? COLORS.amber2 : COLORS.wire}`, borderRadius: 4, padding: "12px 14px", background: sel ? COLORS.amber : "transparent", cursor: "pointer" }}>
                <span style={{ fontSize: 18 }}>🏢</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: sel ? COLORS.ink : COLORS.chalk }}>{loc.label}</div>
                  <div style={{ fontSize: 9, color: sel ? COLORS.ink : COLORS.ghost, marginTop: 2 }}>{loc.address}</div>
                </div>
                {sel ? <span style={{ color: COLORS.ink }}>✓</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============================================================
   LOGIN SCREEN
   ============================================================ */
function LoginScreen({ users, onLogin, error }) {
  const [login, setLogin] = useState("");
  const [pass, setPass] = useState("");

  const handleSubmit = () => {
    if (!login || !pass) return;
    onLogin(login, pass);
  };

  return (
    <div className="screen" style={{ alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 380, width: "100%", display: "flex", flexDirection: "column", gap: 24 }}>
        <div>
          <div style={{ fontFamily: FONTS.head, fontSize: 26, fontWeight: 800, letterSpacing: 2, color: COLORS.amber, textAlign: "center" }}>PEARCE AND SONS</div>
          <div style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", letterSpacing: 1.5, marginTop: 6, textTransform: "uppercase" }}>Staff Transport</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <TextField label="Username" value={login} onChange={e => setLogin(e.target.value)} autoCapitalize="off"
            onKeyDown={e => e.key === "Enter" && handleSubmit()} />
          <TextField label="Password" type="password" value={pass} onChange={e => setPass(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSubmit()} />
          {error ? (
            <div style={{ background: "rgba(232,58,58,.08)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 10 }}>
              <span style={{ fontSize: 10, color: COLORS.red }}>⚠ {error}</span>
            </div>
          ) : null}
          <Button title="LOGIN →" variant="amber" full onClick={handleSubmit} />
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   AGENT APP
   ============================================================ */
function AgentHomeTab({ myTrips, dispatch, goToTrip, setTab }) {
  const active = myTrips.find(t => [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state));
  return (
    <div className="pad">
      <div>
        <div style={{ fontFamily: FONTS.head, fontSize: 22, fontWeight: 800 }}>GOOD DAY, AGENT</div>
        <div style={{ fontSize: 10, color: COLORS.ghost, letterSpacing: 1.5, textTransform: "uppercase", marginTop: 2 }}>Transport Operations Portal</div>
      </div>

      {active && (
        <div onClick={() => goToTrip(active)} style={{ cursor: "pointer", background: "rgba(245,166,35,.08)", border: "1px solid rgba(245,166,35,.3)", borderRadius: 4, padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 11 }}>▶ ACTIVE TRIP</div>
          <StateBadge state={active.state} />
          <div style={{ fontSize: 10, color: COLORS.mist, marginTop: 4 }}>{active.custom_pickup} → {active.custom_dropoff}</div>
          {active.pickup_order_num && <div style={{ fontSize: 11, color: COLORS.amber, fontWeight: 700 }}>You are pickup #{active.pickup_order_num}</div>}
          <div style={{ fontSize: 10, color: COLORS.dim }}>Tap to view details →</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10 }}>
        {[["⊕", "BOOK", "New trip", "book", COLORS.amber], ["⊟", "TRIPS", `${myTrips.length} bookings`, "trips", COLORS.blue], ["◬", "ALERTS", "Updates", "alerts", COLORS.green]].map(([icon, label, sub, tab, color]) => (
          <div key={tab} onClick={() => setTab(tab)} style={{ flex: 1, height: 80, border: `1px solid ${COLORS.wire}`, borderRadius: 4, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, cursor: "pointer" }}>
            <span style={{ fontSize: 20, color }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: 700 }}>{label}</span>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>{sub}</span>
          </div>
        ))}
      </div>

      <SectionHeader label="Recent Trips" />
      {myTrips.length === 0 ? <Empty icon="⊟" text="No trips booked yet" /> : myTrips.slice(0, 4).map(t => (
        <div key={t.trip_id} onClick={() => goToTrip(t)} style={{ cursor: "pointer", background: COLORS.card, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span>
            <StateBadge state={t.state} />
          </div>
          <div style={{ fontSize: 11 }}>{t.custom_pickup}</div>
          <div style={{ fontSize: 10, color: COLORS.ghost }}>→ {t.custom_dropoff}</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, color: COLORS.dim }}>{t.scheduled_date} · {t.scheduled_time}</span>
            {t.pickup_order_num && <span style={{ fontSize: 9, color: COLORS.amber }}>PICKUP #{t.pickup_order_num}</span>}
            {["ASSIGNED", "DRIVER_CONFIRMED"].includes(t.state) && !t.reminder_sent && (
              <Button title="⏰ REMIND" variant="ghost" size="sm" onClick={e => { e.stopPropagation(); dispatch({ type: "TRIP/SEND_REMINDER", trip_id: t.trip_id }); }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentBookTab({ user, dispatch, setTab }) {
  const homeAddr = user.home_address;
  const [form, setForm] = useState({
    pickupStreet: homeAddr?.label || "", pickupArea: homeAddr?.area || "",
    pickupCoord: homeAddr ? { lat: homeAddr.lat, lng: homeAddr.lng, label: homeAddr.label } : null,
    pickupConfirmed: !!homeAddr, pickupCompanyId: COMPANY_LOCATIONS[0].id,
    dropoffStreet: "", dropoffArea: "", dropoffCoord: null, dropoffConfirmed: false, dropoffCompanyId: COMPANY_LOCATIONS[0].id,
    date: new Date().toLocaleDateString("en-ZA"), time: "08:00", trip_type: "DAY", phone: "",
  });
  const [pickupMode, setPickupMode] = useState("street");
  const [dropoffMode, setDropoffMode] = useState("company");
  const [errs, setErrs] = useState({});
  const [loading, setLoading] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const selectedPickupCompany = COMPANY_LOCATIONS.find(l => l.id === form.pickupCompanyId) || COMPANY_LOCATIONS[0];
  const selectedDropoffCompany = COMPANY_LOCATIONS.find(l => l.id === form.dropoffCompanyId) || COMPANY_LOCATIONS[0];

  const validate = () => {
    const e = {};
    if (pickupMode === "street") {
      if (!form.pickupStreet) e.pickup = "Please enter your street address";
      else if (!form.pickupConfirmed) e.pickup = "Please select an address from the list";
    }
    if (dropoffMode === "street") {
      if (!form.dropoffStreet) e.dropoff = "Please enter a drop-off address";
      else if (!form.dropoffConfirmed) e.dropoff = "Please select an address from the list";
    }
    if (!form.phone) e.phone = "Contact number is required";
    setErrs(e);
    return Object.keys(e).length === 0;
  };

  const submit = () => {
    if (!validate()) return;
    setLoading(true);
    setTimeout(async () => {
      let pickupLabel, pickupCoord;
      if (pickupMode === "company") {
        pickupLabel = selectedPickupCompany.address;
        pickupCoord = { lat: selectedPickupCompany.lat, lng: selectedPickupCompany.lng, label: pickupLabel };
      } else {
        pickupLabel = form.pickupCoord?.label || `${form.pickupStreet}, ${form.pickupArea}, Cape Town`;
        pickupCoord = form.pickupCoord || { ...coordForArea(form.pickupArea), label: pickupLabel };
      }
      let dropoffLabel, dropoffCoord;
      if (dropoffMode === "company") {
        dropoffLabel = selectedDropoffCompany.address;
        dropoffCoord = { lat: selectedDropoffCompany.lat, lng: selectedDropoffCompany.lng, label: dropoffLabel };
      } else {
        dropoffLabel = form.dropoffCoord?.label || `${form.dropoffStreet}, ${form.dropoffArea}, Cape Town`;
        dropoffCoord = form.dropoffCoord || { ...coordForArea(form.dropoffArea), label: dropoffLabel };
      }
      await dispatch({
        type: "TRIP/BOOK", agent_id: user.id, agent_name: user.name,
        pickup_label: pickupLabel, pickup_coord: pickupCoord, dropoff_label: dropoffLabel, dropoff_coord: dropoffCoord,
        dropoff_company_id: dropoffMode === "company" ? selectedDropoffCompany.id : null,
        trip_type: form.trip_type, scheduled_date: form.date, scheduled_time: form.time, phone: form.phone,
      });
      setLoading(false);
      setTab("trips");
    }, 400);
  };

  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800, letterSpacing: 1 }}>BOOK TRIP</div>
      <Card>
        <SectionHeader label="Trip Type" />
        <div style={{ display: "flex", gap: 8 }}>
          {["DAY", "WEEK"].map(t => <Button key={t} title={`${t} TRIP`} variant={form.trip_type === t ? "amber" : "ghost"} size="sm" onClick={() => set("trip_type", t)} style={{ flex: 1 }} />)}
        </div>
        <SectionHeader label="Pick Up" />
        {homeAddr && form.pickupConfirmed && pickupMode === "street" && <span style={{ fontSize: 9, color: COLORS.green }}>🏠 Pre-filled from your saved home address</span>}
        <LocationSelector mode={pickupMode} setMode={setPickupMode} companyId={form.pickupCompanyId} setCompanyId={id => set("pickupCompanyId", id)}
          streetValue={form.pickupStreet} streetCoord={form.pickupConfirmed ? form.pickupCoord : null}
          onStreetChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, pickupStreet: street, pickupArea: area, pickupCoord: coord, pickupConfirmed: !!confirmed }))}
          error={!!errs.pickup} errMsg={errs.pickup} />
        <SectionHeader label="Drop Off" />
        <LocationSelector mode={dropoffMode} setMode={setDropoffMode} companyId={form.dropoffCompanyId} setCompanyId={id => set("dropoffCompanyId", id)}
          streetValue={form.dropoffStreet} streetCoord={form.dropoffConfirmed ? form.dropoffCoord : null}
          onStreetChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, dropoffStreet: street, dropoffArea: area, dropoffCoord: coord, dropoffConfirmed: !!confirmed }))}
          error={!!errs.dropoff} errMsg={errs.dropoff} />
        <SectionHeader label="Schedule" />
        <div className="grid2">
          <TextField label="Date" value={form.date} onChange={e => set("date", e.target.value)} />
          <TextField label="Time" type="time" value={form.time} onChange={e => set("time", e.target.value)} />
        </div>
        <TextField label="Contact Phone" value={form.phone} onChange={e => set("phone", e.target.value)} placeholder="07x xxx xxxx" error={errs.phone} />
        <Button title={loading ? "SUBMITTING…" : "SUBMIT BOOKING →"} variant="amber" full onClick={submit} disabled={loading} loading={loading} />
      </Card>
    </div>
  );
}

function AgentTripDetail({ trip, state, dispatch, onBack }) {
  const [text, setText] = useState("");
  if (!trip) return <div className="pad"><span style={{ color: COLORS.ghost }}>Trip not found.</span></div>;

  const driverUser = state.users.find(u => u.id === trip.driver_id);
  const driverStatus = state.driver_status.find(d => d.driver_id === trip.driver_id);
  const pickupCoord = trip.pickup_sequence_coords?.[0] ?? null;
  const dropCoord = trip.dropoff_sequence_coords?.[0] ?? null;
  const chatUser = state.users.find(u => u.id === trip.agent_ids?.[0]) || { id: "unknown", name: "Agent", role: ROLE.AGENT };
  const msgs = trip.chat_messages || [];

  const send = async () => {
    if (!text.trim()) return;
    await dispatch({ type: "TRIP/SEND_CHAT", trip_id: trip.trip_id, sender_id: chatUser.id, sender_name: chatUser.name, sender_role: chatUser.role, text: text.trim() });
    setText("");
  };

  return (
    <div className="pad">
      <Button title="‹ BACK" variant="ghost" size="sm" onClick={onBack} style={{ alignSelf: "flex-start" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{trip.trip_id}</div>
          <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>{trip.trip_type} TRIP</div>
        </div>
        <StateBadge state={trip.state} />
      </div>

      {trip.pickup_order_num && (
        <div style={{ background: "rgba(245,166,35,.08)", border: "1px solid rgba(245,166,35,.3)", borderRadius: 4, padding: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.amber }}>◈ YOU ARE PICKUP #{trip.pickup_order_num}</div>
          <div style={{ fontSize: 10, color: COLORS.mist, marginTop: 2 }}>Drop-off sequence: #{trip.drop_sequence_num}</div>
        </div>
      )}

      <Card>
        <SectionHeader label="Route" />
        <div style={{ fontSize: 11 }}><span style={{ color: COLORS.green }}>◉ PICKUP: </span>{trip.custom_pickup}</div>
        <div style={{ fontSize: 11 }}><span style={{ color: COLORS.red }}>◎ DROP-OFF: </span>{trip.custom_dropoff}</div>
        {trip.est_distance_km && <div style={{ fontSize: 10, color: COLORS.teal }}>Est. distance: {(trip.est_distance_km * 1.35).toFixed(1)} km</div>}
        <SectionHeader label="Pickup Location" />
        {pickupCoord ? <GpsBlock coord={pickupCoord} /> : <span style={{ fontSize: 10, color: COLORS.ghost }}>Coordinates pending</span>}
        {pickupCoord && <Button title="🧭 WAZE" variant="waze" size="sm" onClick={() => openWaze(pickupCoord.lat, pickupCoord.lng, trip.custom_pickup)} />}
        <SectionHeader label="Drop-off Location" />
        {dropCoord ? <GpsBlock coord={dropCoord} /> : <span style={{ fontSize: 10, color: COLORS.ghost }}>Coordinates pending</span>}
        {dropCoord && <Button title="🧭 WAZE" variant="waze" size="sm" onClick={() => openWaze(dropCoord.lat, dropCoord.lng, trip.custom_dropoff)} />}
      </Card>

      {driverUser && (
        <Card>
          <SectionHeader label="Assigned Driver" />
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <DriverAvatar name={driverUser.name} />
            <div>
              <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{driverUser.name}</div>
              <div style={{ fontSize: 10, color: COLORS.ghost }}>{driverStatus?.vehicle}</div>
              <div style={{ fontSize: 10, color: COLORS.ghost }}>{driverStatus?.phone}</div>
              <div style={{ marginTop: 6 }}><StateBadge state={driverStatus?.state} /></div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <SectionHeader label="Trip Log" />
        {[["BOOKED", trip.booked_at], ["CONFIRMED", trip.confirmed_at], ["IN TRANSIT", trip.in_transit_at], ["COMPLETED", trip.completed_at]].map(([l, v]) => v ? (
          <div key={l} style={{ display: "flex", gap: 6, fontSize: 10 }}>
            <span style={{ color: COLORS.green }}>✓</span><span style={{ color: COLORS.ghost }}>{l}:</span><span>{v}</span>
          </div>
        ) : null)}
      </Card>

      <Card>
        <SectionHeader label="Trip Chat" />
        <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
          {msgs.length === 0 && <span style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", padding: 12 }}>No messages yet.</span>}
          {msgs.map(m => {
            const mine = m.sender_id === chatUser.id;
            return (
              <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "82%", borderRadius: 6, padding: 9, background: mine ? "rgba(45,140,240,.15)" : COLORS.surface, border: `1px solid ${mine ? "rgba(45,140,240,.3)" : COLORS.wire}` }}>
                <div style={{ fontSize: 9, color: COLORS.ghost, fontWeight: 700, marginBottom: 3 }}>{m.sender_name} · {m.ts}</div>
                <div style={{ fontSize: 11 }}>{m.text}</div>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 7 }}>
          <input className="inp" style={{ flex: 1 }} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Type a message…" />
          <Button title="SEND" variant="amber" size="sm" onClick={send} disabled={!text.trim()} />
        </div>
      </Card>
    </div>
  );
}

function AgentTripsTab({ myTrips, state, dispatch }) {
  const [filter, setFilter] = useState("ALL");
  const [detailId, setDetailId] = useState(null);
  const filtered = filter === "ALL" ? myTrips : myTrips.filter(t => t.state === filter);
  const detailTrip = detailId ? state.trips.find(t => t.trip_id === detailId) : null;

  if (detailTrip) return <AgentTripDetail trip={detailTrip} state={state} dispatch={dispatch} onBack={() => setDetailId(null)} />;

  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>MY TRIPS</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {["ALL", ...Object.values(TRIP_STATE)].map(f => (
          <Button key={f} size="sm" variant={filter === f ? "amber" : "ghost"} title={f === "ALL" ? "ALL" : f.replace("_BOOKING", "").replace("ARCHIVED_", "")} onClick={() => setFilter(f)} />
        ))}
      </div>
      {filtered.length === 0 ? <Empty icon="⊟" text="No trips" /> : filtered.map(t => (
        <div key={t.trip_id} onClick={() => setDetailId(t.trip_id)} style={{ cursor: "pointer", background: COLORS.card, border: `1px solid ${COLORS.wire}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700, marginBottom: 3 }}>{t.trip_id}</div>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{t.trip_type} TRIP</div>
            </div>
            <StateBadge state={t.state} />
          </div>
          <div style={{ fontSize: 11 }}><span style={{ color: COLORS.green }}>◉ </span>{t.custom_pickup}</div>
          <div style={{ fontSize: 11 }}><span style={{ color: COLORS.red }}>◎ </span>{t.custom_dropoff}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>📅 {t.scheduled_date}</span>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>🕐 {t.scheduled_time}</span>
            {t.pickup_order_num && <span style={{ fontSize: 9, color: COLORS.amber }}>PICKUP #{t.pickup_order_num}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentAlertsTab({ state, user, dispatch }) {
  const myNotifs = state.notifications.filter(n => n.for_user_ids?.includes(user.id));
  const ICONS = { TRIP_BOOKED: "✅", DRIVER_ASSIGNED: "🚗", TRIP_CONFIRMED: "🔔", IN_TRANSIT: "🚦", TRIP_COMPLETED: "🏁", TRIP_ACCEPTED: "✅", UPCOMING_TRIP: "⏰" };
  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>ALERTS</div>
        <Button title="CLEAR" variant="ghost" size="sm" onClick={() => dispatch({ type: "NOTIF/MARK_ALL_READ" })} />
      </div>
      {myNotifs.length === 0 ? <Empty icon="◬" text="No alerts" /> : myNotifs.map(n => (
        <div key={n.id} onClick={() => dispatch({ type: "NOTIF/MARK_READ", id: n.id })}
          style={{ cursor: "pointer", background: n.read ? COLORS.card : "rgba(245,166,35,.08)", border: n.read ? "none" : "1px solid rgba(245,166,35,.3)", borderRadius: 4, padding: 13 }}>
          <div style={{ fontSize: 9, fontWeight: 700, color: COLORS.amber, letterSpacing: 1, marginBottom: 5 }}>{ICONS[n.type] || "◈"} {n.type.replace(/_/g, " ")}</div>
          <div style={{ fontSize: 11 }}>{n.message}</div>
          <div style={{ fontSize: 9, color: COLORS.dim, marginTop: 5 }}>{n.ts}</div>
        </div>
      ))}
    </div>
  );
}

function AgentProfileTab({ user, myTrips, dispatch }) {
  const initials = user.name.split(" ").map(w => w[0]).join("").slice(0, 2);
  return (
    <div className="pad">
      <Card style={{ alignItems: "center", padding: 24, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 4, background: COLORS.surface, border: `1px solid ${COLORS.wire}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.head, fontSize: 24, fontWeight: 800, color: COLORS.amber, margin: "0 auto" }}>{initials}</div>
        <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800, marginTop: 10 }}>{user.name}</div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}><RoleBadge role={user.role} /></div>
        <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 4 }}>{user.id}</div>
      </Card>
      {user.home_address && (
        <Card>
          <SectionHeader label="Home Address" />
          <div style={{ fontSize: 11, fontWeight: 600 }}>🏠 {user.home_address.label}</div>
          <div style={{ fontSize: 9, color: COLORS.ghost }}>{user.home_address.lat?.toFixed(5)}, {user.home_address.lng?.toFixed(5)}</div>
        </Card>
      )}
      <Card body={false}>
        {[["Total Trips", myTrips.length], ["Completed", myTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED).length], ["Active", myTrips.filter(t => [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)).length]].map(([l, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${COLORS.wire}` }}>
            <span style={{ fontSize: 11 }}>{l}</span>
            <span style={{ fontFamily: FONTS.head, fontSize: 20, fontWeight: 800, color: COLORS.amber }}>{v}</span>
          </div>
        ))}
      </Card>
      <Button title="LOGOUT" variant="ghost" full onClick={() => dispatch({ type: "AUTH/LOGOUT" })} />
    </div>
  );
}

const AGENT_TABS = [["home", "◈", "Home"], ["book", "⊕", "Book"], ["trips", "⊟", "Trips"], ["alerts", "◬", "Alerts"], ["me", "◐", "Me"]];

function AgentApp({ state, dispatch, user }) {
  const [tab, setTab] = useState("home");
  const myTrips = state.trips.filter(t => t.agent_ids.includes(user.id));
  const myNotifs = state.notifications.filter(n => n.for_user_ids?.includes(user.id) && !n.read);
  const goToTrip = () => setTab("trips");

  return (
    <div className="screen">
      <div style={{ background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ color: COLORS.amber, fontWeight: 800, fontSize: 14, letterSpacing: 2 }}>TRANSIT/OS</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {myNotifs.length > 0 && <span style={{ background: COLORS.amber, borderRadius: 2, padding: "1px 6px", fontSize: 9, fontWeight: 800, color: "#000" }}>{myNotifs.length}</span>}
          <RoleBadge role={ROLE.AGENT} />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "home" && <AgentHomeTab myTrips={myTrips} dispatch={dispatch} goToTrip={goToTrip} setTab={setTab} />}
        {tab === "book" && <AgentBookTab user={user} dispatch={dispatch} setTab={setTab} />}
        {tab === "trips" && <AgentTripsTab myTrips={myTrips} state={state} dispatch={dispatch} />}
        {tab === "alerts" && <AgentAlertsTab state={state} user={user} dispatch={dispatch} />}
        {tab === "me" && <AgentProfileTab user={user} myTrips={myTrips} dispatch={dispatch} />}
      </div>

      <div style={{ display: "flex", background: COLORS.panel, borderTop: `1px solid ${COLORS.wire}`, position: "sticky", bottom: 0 }}>
        {AGENT_TABS.map(([id, icon, label]) => (
          <div key={id} onClick={() => setTab(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "10px 0", cursor: "pointer", color: tab === id ? COLORS.amber : COLORS.ghost }}>
            <span style={{ fontSize: 17 }}>{icon}</span>
            <span style={{ fontSize: 9, fontWeight: 700 }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   DRIVER APP
   ============================================================ */
function DriverTripsTab({ state, dispatch, user, myTrips, setTab }) {
  const myStatus = state.driver_status.find(d => d.driver_id === user.id);
  const active = myTrips.filter(t => t.state !== TRIP_STATE.ARCHIVED_COMPLETED).sort((a, b) => (a.pickup_order_num || 99) - (b.pickup_order_num || 99));
  const load = active.length;
  const full = load >= DRIVER_CAPACITY;

  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontFamily: FONTS.head, fontSize: 22, fontWeight: 800 }}>{user.name}</div>
          <div style={{ fontSize: 10, color: COLORS.ghost, letterSpacing: 1 }}>DRIVER CONSOLE</div>
        </div>
        <StateBadge state={full ? "FULLY_BOOKED" : (myStatus?.state || DRIVER_STATE.AVAILABLE)} />
      </div>

      <Card>
        <span style={{ fontSize: 9, letterSpacing: 1.5, color: COLORS.ghost, textTransform: "uppercase" }}>VEHICLE</span>
        <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{myStatus?.vehicle || "—"}</div>
        <CapacityBar load={load} capacity={DRIVER_CAPACITY} />
      </Card>

      <SectionHeader label={`Assigned Passengers (${active.length})`} />
      {active.length === 0 ? <Empty icon="⊟" text="No assigned trips" /> : active.map(trip => {
        const pickupCoord = trip.pickup_sequence_coords?.[0];
        return (
          <Card key={trip.trip_id}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{trip.trip_id}</span>
              <StateBadge state={trip.state} />
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {trip.pickup_order_num && <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.green, background: "rgba(29,185,84,.15)", border: "1px solid rgba(29,185,84,.3)", borderRadius: 2, padding: "2px 7px" }}>PICKUP #{trip.pickup_order_num}</span>}
              {trip.drop_sequence_num && <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, background: "rgba(232,58,58,.15)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 2, padding: "2px 7px" }}>DROP #{trip.drop_sequence_num}</span>}
            </div>
            <div style={{ background: COLORS.surface, borderRadius: 3, padding: 10, border: `1px solid ${COLORS.wire}` }}>
              <div style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase" }}>PASSENGER</div>
              <div style={{ fontFamily: FONTS.head, fontSize: 13, fontWeight: 700 }}>{trip.agent_name}</div>
              <div style={{ fontSize: 10, color: COLORS.mist }}>📞 {trip.phone}</div>
            </div>
            <div style={{ fontSize: 11 }}><span style={{ color: COLORS.green }}>◉ PICKUP: </span>{trip.custom_pickup}</div>
            <div style={{ fontSize: 11 }}><span style={{ color: COLORS.red }}>◎ DROP-OFF: </span>{trip.custom_dropoff}</div>
            {trip.est_distance_km && <div style={{ fontSize: 9, color: COLORS.ghost }}>Est. <span style={{ color: COLORS.teal, fontWeight: 700 }}>{(trip.est_distance_km * 1.35).toFixed(1)} km</span></div>}
            {pickupCoord && <GpsBlock coord={pickupCoord} />}
            {trip.state === TRIP_STATE.ASSIGNED && !trip.driverAccepted && (
              <div style={{ display: "flex", gap: 8 }}>
                <Button title="✓ ACCEPT" variant="green" style={{ flex: 1 }} onClick={async () => { await dispatch({ type: "TRIP/ACCEPT", trip_id: trip.trip_id }); await dispatch({ type: "TRIP/DRIVER_CONFIRM", trip_id: trip.trip_id }); }} />
                <Button title="✗ DECLINE" variant="danger" style={{ flex: 1 }} onClick={() => dispatch({ type: "TRIP/DECLINE", trip_id: trip.trip_id, driver_id: user.id })} />
              </div>
            )}
            {trip.driverAccepted && <span style={{ fontSize: 9, color: COLORS.green, fontWeight: 700 }}>✓ ACCEPTED — {trip.acceptedAt}</span>}
            <div style={{ display: "flex", gap: 8 }}>
              {pickupCoord && <Button title="WAZE ↗" variant="waze" style={{ flex: 1 }} onClick={() => openWaze(pickupCoord.lat, pickupCoord.lng, trip.custom_pickup)} />}
              {[TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(trip.state) && <Button title="NAV →" variant="amber" onClick={() => setTab("navigate")} />}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function DriverNavTab({ state, dispatch, user }) {
  const [tripStarted, setTripStarted] = useState(false);
  const myActiveTrips = state.trips.filter(t => t.driver_id === user.id && [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state))
    .sort((a, b) => (a.pickup_order_num || 99) - (b.pickup_order_num || 99));

  const pickupStops = myActiveTrips.map(trip => ({
    lat: trip.pickup_sequence_coords?.[0]?.lat, lng: trip.pickup_sequence_coords?.[0]?.lng,
    label: trip.pickup_sequence_coords?.[0]?.label || trip.custom_pickup,
    trip_id: trip.trip_id, agent_id: trip.agent_ids?.[0], agent_name: trip.agent_name, phone: trip.phone,
    done: !!(trip.completed_pickups?.includes(trip.agent_ids?.[0])),
  }));
  const allPickedUp = pickupStops.length > 0 && pickupStops.every(s => s.done);
  const curPickup = pickupStops.find(s => !s.done);
  const curPickupIdx = pickupStops.findIndex(s => !s.done);
  const donePickups = pickupStops.filter(s => s.done).length;
  const lastPickupDone = [...pickupStops].reverse().find(s => s.done) || pickupStops[0];
  const lastPickupCoord = lastPickupDone ? { lat: lastPickupDone.lat, lng: lastPickupDone.lng } : null;

  const dropoffGroups = {};
  myActiveTrips.forEach(trip => {
    const coord = trip.dropoff_sequence_coords?.[0];
    if (!coord) return;
    const key = `${parseFloat(coord.lat).toFixed(4)},${parseFloat(coord.lng).toFixed(4)}`;
    if (!dropoffGroups[key]) dropoffGroups[key] = { lat: coord.lat, lng: coord.lng, label: coord.label || trip.custom_dropoff, trip_ids: [], passengers: [], done: false };
    dropoffGroups[key].trip_ids.push(trip.trip_id);
    dropoffGroups[key].passengers.push({ name: trip.agent_name, phone: trip.phone, trip_id: trip.trip_id });
  });
  Object.values(dropoffGroups).forEach(group => { group.done = group.trip_ids.every(id => state.trips.find(t => t.trip_id === id)?.state === TRIP_STATE.ARCHIVED_COMPLETED); });
  const dropStops = sortDropoffsByProximity(Object.values(dropoffGroups), lastPickupCoord);
  const curDrop = allPickedUp ? dropStops.find(s => !s.done) : null;
  const curDropIdx = allPickedUp ? dropStops.findIndex(s => !s.done) : -1;
  const doneDrops = dropStops.filter(s => s.done).length;
  const allComplete = allPickedUp && dropStops.length > 0 && dropStops.every(s => s.done);

  const handleStartTrip = async () => {
    setTripStarted(true);
    for (const trip of myActiveTrips) {
      if (trip.state === TRIP_STATE.ASSIGNED) {
        await dispatch({ type: "TRIP/ACCEPT", trip_id: trip.trip_id });
        await dispatch({ type: "TRIP/DRIVER_CONFIRM", trip_id: trip.trip_id });
      }
    }
    const firstPickup = pickupStops.find(s => !s.done) || pickupStops[0];
    if (firstPickup?.lat && firstPickup?.lng) openWaze(firstPickup.lat, firstPickup.lng, firstPickup.label);
  };
  const confirmPickup = (trip_id, agent_id) => dispatch({ type: "TRIP/CONFIRM_AGENT_PICKUP", trip_id, agent_id });
  const confirmDropoff = (group) => group.trip_ids.forEach(tid => {
    const t = state.trips.find(x => x.trip_id === tid);
    if (t && t.state !== TRIP_STATE.ARCHIVED_COMPLETED) dispatch({ type: "TRIP/COMPLETE", trip_id: tid });
  });

  if (myActiveTrips.length === 0) return <div className="pad"><div style={{ fontFamily: FONTS.head, fontSize: 22, fontWeight: 800 }}>NAVIGATION</div><Empty icon="◉" text="No active trips. Accept trips from the Trips tab first." /></div>;

  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 22, fontWeight: 800 }}>NAVIGATION</div>
      <div style={{ fontSize: 9, color: COLORS.ghost, letterSpacing: 1.5, textTransform: "uppercase", marginTop: -8 }}>{donePickups}/{pickupStops.length} PICKUPS · {doneDrops}/{dropStops.length} DROP-OFFS</div>

      {!tripStarted && (
        <Card style={{ alignItems: "center", padding: 28, textAlign: "center", borderColor: COLORS.amber }}>
          <div style={{ fontSize: 40 }}>🚐</div>
          <div style={{ fontFamily: FONTS.head, fontSize: 20, fontWeight: 800 }}>Ready to go?</div>
          <div style={{ fontSize: 10, color: COLORS.mist }}>{pickupStops.length} passenger{pickupStops.length !== 1 ? "s" : ""} · {dropStops.length} drop-off location{dropStops.length !== 1 ? "s" : ""}</div>
          {pickupStops.map((s, i) => (
            <div key={s.trip_id} style={{ display: "flex", gap: 10, alignItems: "center", background: COLORS.surface, borderRadius: 3, padding: 10, border: `1px solid ${COLORS.wire}`, width: "100%", textAlign: "left" }}>
              <span style={{ color: COLORS.green, fontWeight: 800, minWidth: 22 }}>#{i + 1}</span>
              <div><div style={{ fontWeight: 700, fontSize: 11 }}>{s.agent_name}</div><div style={{ color: COLORS.ghost, fontSize: 10 }}>{s.label}</div></div>
            </div>
          ))}
          <Button title="▶ START TRIP — OPEN WAZE" variant="amber" full onClick={handleStartTrip} style={{ padding: 18, fontSize: 15, letterSpacing: 2 }} />
          <div style={{ fontSize: 9, color: COLORS.ghost }}>🧭 Opens Waze immediately, navigating to your first pickup</div>
        </Card>
      )}

      {tripStarted && !allPickedUp && curPickup && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {pickupStops.map((s, i) => (
              <div key={s.trip_id} style={{ padding: "4px 10px", borderRadius: 2, fontSize: 9, fontWeight: 700, background: s.done ? "rgba(29,185,84,.15)" : i === curPickupIdx ? "rgba(245,166,35,.2)" : COLORS.surface, border: `1px solid ${s.done ? "rgba(29,185,84,.4)" : i === curPickupIdx ? COLORS.amber : COLORS.wire}`, color: s.done ? COLORS.green : i === curPickupIdx ? COLORS.amber : COLORS.ghost }}>
                {s.done ? "✓ " : i === curPickupIdx ? "▶ " : "○ "}P{i + 1}: {s.agent_name?.split(" ")[0]}
              </div>
            ))}
          </div>
          <Card style={{ gap: 12, borderColor: COLORS.amber, background: "rgba(245,166,35,.04)" }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: COLORS.amber, fontWeight: 800, textTransform: "uppercase" }}>▶ PICKUP {curPickupIdx + 1} OF {pickupStops.length}</div>
            <div style={{ fontFamily: FONTS.head, fontSize: 20, fontWeight: 800, color: COLORS.green }}>◉ {curPickup.agent_name}</div>
            <div style={{ fontSize: 11, color: COLORS.mist }}>📞 {curPickup.phone}</div>
            <div style={{ background: COLORS.surface, borderRadius: 3, padding: 10, border: `1px solid ${COLORS.wire}` }}>
              <div style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase", marginBottom: 4 }}>PICKUP ADDRESS</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{curPickup.label}</div>
            </div>
            <Button title={`🧭 WAZE → PICKUP ${curPickupIdx + 1}`} variant="waze" full onClick={() => openWaze(curPickup.lat, curPickup.lng, curPickup.label)} style={{ padding: 16, fontSize: 14 }} />
            <Button title={`✓ PICKED UP — ${curPickup.agent_name}`} variant="green" full onClick={() => confirmPickup(curPickup.trip_id, curPickup.agent_id)} />
          </Card>
          {pickupStops.slice(curPickupIdx + 1).length > 0 && (
            <>
              <SectionHeader label="Up Next" />
              {pickupStops.slice(curPickupIdx + 1).map((s, i) => (
                <div key={s.trip_id} style={{ display: "flex", gap: 10, alignItems: "center", background: COLORS.surface, borderRadius: 3, padding: 9, border: `1px solid ${COLORS.wire}`, opacity: .65 }}>
                  <span style={{ color: COLORS.ghost, fontWeight: 800, minWidth: 22 }}>#{curPickupIdx + 2 + i}</span>
                  <div><div style={{ fontWeight: 700, fontSize: 11 }}>{s.agent_name}</div><div style={{ color: COLORS.ghost, fontSize: 10 }}>{s.label}</div></div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tripStarted && allPickedUp && !allComplete && curDrop && (
        <>
          <div style={{ background: "rgba(29,185,84,.08)", border: "1px solid rgba(29,185,84,.3)", borderRadius: 4, padding: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 11, color: COLORS.green }}>✓ All {pickupStops.length} passenger{pickupStops.length !== 1 ? "s" : ""} on board — now drop-offs</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {dropStops.map((s, i) => (
              <div key={`${s.lat}-${s.lng}`} style={{ padding: "4px 10px", borderRadius: 2, fontSize: 9, fontWeight: 700, background: s.done ? "rgba(29,185,84,.15)" : i === curDropIdx ? "rgba(232,58,58,.2)" : COLORS.surface, border: `1px solid ${s.done ? "rgba(29,185,84,.4)" : i === curDropIdx ? COLORS.red : COLORS.wire}`, color: s.done ? COLORS.green : i === curDropIdx ? COLORS.red : COLORS.ghost }}>
                {s.done ? "✓ " : i === curDropIdx ? "▶ " : "○ "}D{i + 1}: {s.label?.split(",")[0]}
              </div>
            ))}
          </div>
          <Card style={{ gap: 12, borderColor: COLORS.red, background: "rgba(232,58,58,.04)" }}>
            <div style={{ fontSize: 9, letterSpacing: 2, color: COLORS.red, fontWeight: 800, textTransform: "uppercase" }}>▶ DROP-OFF {curDropIdx + 1} OF {dropStops.length}</div>
            <div style={{ fontFamily: FONTS.head, fontSize: 20, fontWeight: 800, color: COLORS.red }}>◎ {curDrop.label}</div>
            {curDrop.passengers.map((p, i) => (
              <div key={i} style={{ background: COLORS.surface, borderRadius: 3, padding: 7, border: `1px solid ${COLORS.wire}`, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700, fontSize: 10 }}>{p.name}</span><span style={{ color: COLORS.ghost, fontSize: 10 }}>📞 {p.phone}</span>
              </div>
            ))}
            <div style={{ background: COLORS.surface, borderRadius: 3, padding: 10, border: `1px solid ${COLORS.wire}` }}>
              <div style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase", marginBottom: 4 }}>DROP-OFF ADDRESS</div>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{curDrop.label}</div>
            </div>
            <Button title={`🧭 WAZE → DROP-OFF ${curDropIdx + 1}`} variant="waze" full onClick={() => openWaze(curDrop.lat, curDrop.lng, curDrop.label)} style={{ padding: 16, fontSize: 14 }} />
            <Button title={`🏁 DROPPED OFF — ${curDrop.passengers.map(p => p.name.split(" ")[0]).join(" & ")}`} variant="amber" full onClick={() => confirmDropoff(curDrop)} />
          </Card>
          {dropStops.slice(curDropIdx + 1).length > 0 && (
            <>
              <SectionHeader label="Next Drop-off" />
              {dropStops.slice(curDropIdx + 1).map((s, i) => (
                <div key={`${s.lat}-${s.lng}-next`} style={{ display: "flex", gap: 10, alignItems: "center", background: COLORS.surface, borderRadius: 3, padding: 9, border: `1px solid ${COLORS.wire}`, opacity: .65 }}>
                  <span style={{ color: COLORS.ghost, fontWeight: 800, minWidth: 22 }}>D{curDropIdx + 2 + i}</span>
                  <div><div style={{ fontWeight: 700, fontSize: 11 }}>{s.label}</div><div style={{ color: COLORS.ghost, fontSize: 10 }}>{s.passengers.map(p => p.name).join(", ")}</div></div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {tripStarted && allComplete && (
        <Card style={{ alignItems: "center", padding: 28, textAlign: "center", borderColor: COLORS.green, background: "rgba(29,185,84,.05)" }}>
          <div style={{ fontSize: 48 }}>🏁</div>
          <div style={{ fontFamily: FONTS.head, fontSize: 22, fontWeight: 800, color: COLORS.green }}>RUN COMPLETE</div>
          <div style={{ fontSize: 10, color: COLORS.mist }}>All {pickupStops.length} passenger{pickupStops.length !== 1 ? "s" : ""} delivered successfully.</div>
        </Card>
      )}
    </div>
  );
}

function DriverHistoryTab({ myTrips }) {
  const done = myTrips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED);
  return (
    <div className="pad">
      <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>TRIP HISTORY</div>
      {done.length === 0 ? <Empty icon="◈" text="No completed trips" /> : done.map(t => (
        <Card key={t.trip_id}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span>
            <StateBadge state={t.state} />
          </div>
          <div style={{ fontSize: 11 }}>{t.agent_name}</div>
          <div style={{ fontSize: 10, color: COLORS.ghost }}>{t.custom_pickup} → {t.custom_dropoff}</div>
          {t.actual_distance_km && <div style={{ fontSize: 9, color: COLORS.teal }}>Distance: {(t.actual_distance_km * 1.35).toFixed(1)} km</div>}
          <div style={{ fontSize: 9, color: COLORS.dim }}>{t.completed_at}</div>
        </Card>
      ))}
    </div>
  );
}

function DriverProfileTab({ user, myStatus, myTrips, dispatch, load }) {
  const full = load >= DRIVER_CAPACITY;
  const initials = user.name.split(" ").map(w => w[0]).join("").slice(0, 2);
  return (
    <div className="pad">
      <Card style={{ alignItems: "center", padding: 24, textAlign: "center" }}>
        <div style={{ width: 64, height: 64, borderRadius: 4, background: COLORS.surface, border: `1px solid ${COLORS.amber}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONTS.head, fontSize: 24, fontWeight: 800, color: COLORS.amber, margin: "0 auto" }}>{initials}</div>
        <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800, marginTop: 10 }}>{user.name}</div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 6 }}><RoleBadge role={user.role} /></div>
        <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 4 }}>{user.id}</div>
      </Card>
      <Card>
        <SectionHeader label="Vehicle" />
        <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{myStatus?.vehicle}</div>
        <div style={{ fontSize: 10, color: COLORS.ghost }}>{myStatus?.phone}</div>
        <StateBadge state={full ? "FULLY_BOOKED" : (myStatus?.state || DRIVER_STATE.AVAILABLE)} />
        <CapacityBar load={load} capacity={DRIVER_CAPACITY} />
      </Card>
      <Card body={false}>
        {[["Total Trips", myTrips.length], ["Completed", myTrips.filter(t => t.state === "ARCHIVED_COMPLETED").length], ["Active", load]].map(([l, v]) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${COLORS.wire}` }}>
            <span style={{ fontSize: 11 }}>{l}</span><span style={{ fontFamily: FONTS.head, fontSize: 20, fontWeight: 800, color: COLORS.amber }}>{v}</span>
          </div>
        ))}
      </Card>
      <Button title="LOGOUT" variant="ghost" full onClick={() => dispatch({ type: "AUTH/LOGOUT" })} />
    </div>
  );
}

const DRIVER_TABS = [["trips", "⊟", "Trips"], ["navigate", "◉", "Navigate"], ["history", "◈", "History"], ["me", "◐", "Me"]];

function DriverApp({ state, dispatch, user }) {
  const [tab, setTab] = useState("trips");
  const myStatus = state.driver_status.find(d => d.driver_id === user.id);
  const myTrips = state.trips.filter(t => t.driver_id === user.id);
  const load = myTrips.filter(t => t.state !== TRIP_STATE.ARCHIVED_COMPLETED).length;
  const full = load >= DRIVER_CAPACITY;

  return (
    <div className="screen">
      <div style={{ background: COLORS.panel, borderBottom: `1px solid ${COLORS.wire}`, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, zIndex: 10 }}>
        <span style={{ color: COLORS.amber, fontWeight: 800, fontSize: 14, letterSpacing: 2 }}>TRANSIT/OS</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StateBadge state={full ? "FULLY_BOOKED" : (myStatus?.state || DRIVER_STATE.AVAILABLE)} />
          <RoleBadge role={ROLE.DRIVER} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "trips" && <DriverTripsTab state={state} dispatch={dispatch} user={user} myTrips={myTrips} setTab={setTab} />}
        {tab === "navigate" && <DriverNavTab state={state} dispatch={dispatch} user={user} />}
        {tab === "history" && <DriverHistoryTab myTrips={myTrips} />}
        {tab === "me" && <DriverProfileTab user={user} myStatus={myStatus} myTrips={myTrips} dispatch={dispatch} load={load} />}
      </div>
      <div style={{ display: "flex", background: COLORS.panel, borderTop: `1px solid ${COLORS.wire}`, position: "sticky", bottom: 0 }}>
        {DRIVER_TABS.map(([id, icon, label]) => (
          <div key={id} onClick={() => setTab(id)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "10px 0", cursor: "pointer", color: tab === id ? COLORS.amber : COLORS.ghost }}>
            <span style={{ fontSize: 17 }}>{icon}</span><span style={{ fontSize: 9, fontWeight: 700 }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================
   ADMIN APP
   ============================================================ */
function AdminDashboard({ state }) {
  const trips = state.trips;
  const counts = {
    total: trips.length,
    unassign: trips.filter(t => t.state === TRIP_STATE.UNASSIGNED_BOOKING).length,
    active: trips.filter(t => [TRIP_STATE.ASSIGNED, TRIP_STATE.DRIVER_CONFIRMED, TRIP_STATE.IN_TRANSIT].includes(t.state)).length,
    done: trips.filter(t => t.state === TRIP_STATE.ARCHIVED_COMPLETED).length,
  };
  return (
    <div className="pad">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 1, background: COLORS.wire, border: `1px solid ${COLORS.wire}`, borderRadius: 4, overflow: "hidden" }}>
        {[["TOTAL", counts.total, COLORS.chalk], ["UNASSIGNED", counts.unassign, COLORS.red], ["ACTIVE", counts.active, COLORS.amber], ["DONE", counts.done, COLORS.green]].map(([l, v, c]) => (
          <div key={l} style={{ background: COLORS.card, padding: 14, width: "49.5%" }}>
            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.2, color: COLORS.ghost, textTransform: "uppercase" }}>{l}</div>
            <div style={{ fontSize: 26, fontWeight: 800, marginTop: 4, fontFamily: FONTS.head, color: c }}>{v}</div>
          </div>
        ))}
      </div>
      <SectionHeader label="Driver Fleet" />
      {state.driver_status.map(ds => {
        const u = state.users.find(x => x.id === ds.driver_id);
        const load = getDriverLoad(state, ds.driver_id);
        const full = load >= DRIVER_CAPACITY;
        return (
          <Card key={ds.driver_id} style={{ flexDirection: "row", gap: 14, alignItems: "flex-start" }}>
            <DriverAvatar name={u?.name} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FONTS.head, fontSize: 15, fontWeight: 700 }}>{u?.name}</div>
              <div style={{ fontSize: 10, color: COLORS.ghost, marginTop: 2 }}>{ds.vehicle}</div>
              <div style={{ margin: "6px 0 8px" }}><StateBadge state={full ? "FULLY_BOOKED" : ds.state} /></div>
              <CapacityBar load={load} capacity={DRIVER_CAPACITY} />
            </div>
          </Card>
        );
      })}
      <SectionHeader label="Recent Trips" />
      <Card body={false}>
        {trips.slice(0, 8).length === 0 ? <Empty icon="⊟" text="No trips" /> : trips.slice(0, 8).map(t => (
          <div key={t.trip_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: `1px solid ${COLORS.wire}` }}>
            <span style={{ width: 80, fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span>
            <span style={{ flex: 1, fontWeight: 600, fontSize: 11 }}>{t.agent_name}</span>
            <StateBadge state={t.state} />
          </div>
        ))}
      </Card>
    </div>
  );
}

function AddAgentPanel({ trip, state, dispatch, onClose }) {
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState("street");
  const [companyId, setCompanyId] = useState(COMPANY_LOCATIONS[0].id);
  const [streetValue, setStreetValue] = useState("");
  const [streetArea, setStreetArea] = useState("");
  const [streetCoord, setStreetCoord] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const availableAgents = state.users.filter(u => u.role === ROLE.AGENT && !trip.agent_ids.includes(u.id));
  const selectedCompany = COMPANY_LOCATIONS.find(l => l.id === companyId) || COMPANY_LOCATIONS[0];
  const selectedAgent = state.users.find(u => u.id === agentId);

  // Picking an agent with a saved home address pre-fills it, same convenience
  // the agent's own booking screen gives them — admin can still override.
  const chooseAgent = (id) => {
    setAgentId(id);
    const a = state.users.find(u => u.id === id);
    if (a?.home_address) {
      setMode("street");
      setStreetValue(a.home_address.label);
      setStreetArea(a.home_address.area);
      setStreetCoord({ lat: a.home_address.lat, lng: a.home_address.lng });
      setConfirmed(true);
    } else {
      setStreetValue(""); setStreetCoord(null); setConfirmed(false);
    }
  };

  const canSave = agentId && (mode === "company" || (streetValue && confirmed));

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const pickupLabel = mode === "company" ? selectedCompany.address : streetValue;
    const pickupCoord = mode === "company" ? { lat: selectedCompany.lat, lng: selectedCompany.lng } : streetCoord;
    await dispatch({ type: "TRIP/ADD_AGENT", trip_id: trip.trip_id, agent_id: agentId, pickup_label: pickupLabel, pickup_coord: pickupCoord });
    setSaving(false);
    onClose();
  };

  if (availableAgents.length === 0) {
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
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {availableAgents.map(a => (
          <div key={a.id} onClick={() => chooseAgent(a.id)}
            style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", border: `1px solid ${agentId === a.id ? COLORS.amber2 : COLORS.wire}`, borderRadius: 4, background: agentId === a.id ? COLORS.amber : "transparent" }}>
            <DriverAvatar name={a.name} size={30} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: agentId === a.id ? COLORS.ink : COLORS.chalk }}>{a.name}</div>
              <div style={{ fontSize: 9, color: agentId === a.id ? COLORS.ink : COLORS.ghost }}>{a.auth.login}</div>
            </div>
          </div>
        ))}
      </div>

      {agentId && (
        <>
          <SectionHeader label="Pickup Location" />
          <LocationSelector mode={mode} setMode={setMode} companyId={companyId} setCompanyId={setCompanyId}
            streetValue={streetValue} streetCoord={confirmed ? streetCoord : null}
            onStreetChange={({ street, area, coord, confirmed: c }) => { setStreetValue(street); setStreetArea(area); setStreetCoord(coord); setConfirmed(!!c); }} />
          <div style={{ display: "flex", gap: 8 }}>
            <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
            <Button title={saving ? "ADDING…" : "ADD TO TRIP →"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={!canSave || saving} loading={saving} />
          </div>
        </>
      )}
    </Card>
  );
}

function RelocateAgentPanel({ trip, agent, currentPickup, dispatch, onClose }) {
  const [mode, setMode] = useState("street");
  const [companyId, setCompanyId] = useState(COMPANY_LOCATIONS[0].id);
  const [streetValue, setStreetValue] = useState(currentPickup?.label || "");
  const [streetArea, setStreetArea] = useState("");
  const [streetCoord, setStreetCoord] = useState(currentPickup ? { lat: currentPickup.lat, lng: currentPickup.lng } : null);
  const [confirmed, setConfirmed] = useState(!!currentPickup);
  const [saving, setSaving] = useState(false);

  const selectedCompany = COMPANY_LOCATIONS.find(l => l.id === companyId) || COMPANY_LOCATIONS[0];
  const canSave = mode === "company" || (streetValue && confirmed);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const pickupLabel = mode === "company" ? selectedCompany.address : streetValue;
    const pickupCoord = mode === "company" ? { lat: selectedCompany.lat, lng: selectedCompany.lng } : streetCoord;
    await dispatch({ type: "TRIP/RELOCATE_AGENT", trip_id: trip.trip_id, agent_id: agent.id, pickup_label: pickupLabel, pickup_coord: pickupCoord });
    setSaving(false);
    onClose();
  };

  return (
    <Card style={{ borderColor: COLORS.blue2, background: "rgba(45,140,240,.04)" }}>
      <SectionHeader label={`Relocate — ${agent.name}`} />
      <span style={{ fontSize: 9, color: COLORS.ghost }}>Current pickup: {currentPickup?.label || "—"}</span>
      <LocationSelector mode={mode} setMode={setMode} companyId={companyId} setCompanyId={setCompanyId}
        streetValue={streetValue} streetCoord={confirmed ? streetCoord : null}
        onStreetChange={({ street, area, coord, confirmed: c }) => { setStreetValue(street); setStreetArea(area); setStreetCoord(coord); setConfirmed(!!c); }} />
      <div style={{ display: "flex", gap: 8 }}>
        <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
        <Button title={saving ? "MOVING…" : "MOVE PICKUP →"} variant="blue" style={{ flex: 1 }} onClick={save} disabled={!canSave || saving} loading={saving} />
      </div>
    </Card>
  );
}

function TripDetailRow({ trip, state, dispatch }) {
  const [open, setOpen] = useState(false);
  const [addingAgent, setAddingAgent] = useState(false);
  const [relocatingId, setRelocatingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);
  const driver = state.users.find(u => u.id === trip.driver_id);
  const passengers = trip.agent_ids.map(id => state.users.find(u => u.id === id)).filter(Boolean);
  const canEdit = trip.state !== TRIP_STATE.ARCHIVED_COMPLETED;

  const confirmRemove = async (agentId) => {
    await dispatch({ type: "TRIP/REMOVE_AGENT", trip_id: trip.trip_id, agent_id: agentId });
    setRemovingId(null);
  };

  return (
    <>
      <div onClick={() => setOpen(o => !o)} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: `1px solid ${COLORS.wire}` }}>
        <span style={{ width: 80, fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{trip.trip_id}</span>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 11 }}>{trip.agent_name}{trip.agent_ids.length > 1 ? ` +${trip.agent_ids.length - 1}` : ""}</span>
        {trip.long_distance_flag && <span style={{ fontSize: 8, fontWeight: 700, color: COLORS.red, border: `1px solid ${COLORS.red}`, borderRadius: 2, padding: "2px 5px" }}>40km+</span>}
        <StateBadge state={trip.state} />
        <span style={{ color: COLORS.ghost, fontSize: 11 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ background: COLORS.surface, borderBottom: `1px solid ${COLORS.wire}`, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {trip.admin_note && (
            <div style={{ background: "rgba(232,58,58,.08)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 10 }}>
              <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.red, letterSpacing: 1 }}>⚠ ADMIN NOTE</span>
              <div style={{ fontSize: 10, color: COLORS.chalk, marginTop: 3 }}>{trip.admin_note}</div>
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
            {trip.est_distance_km && <span style={{ fontSize: 10, width: "48%" }}><span style={{ color: COLORS.ghost }}>EST DIST: </span>{(trip.est_distance_km * 1.35).toFixed(1)} km</span>}
          </div>

          <SectionHeader label={`Passengers (${passengers.length})`} />
          {passengers.map((p, i) => {
            const pickup = trip.pickup_sequence_coords?.[i];
            const pickedUp = trip.completed_pickups?.includes(p.id);
            const isRelocating = relocatingId === p.id;
            const isConfirmingRemove = removingId === p.id;
            return (
              <div key={p.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}>
                  <DriverAvatar name={p.name} size={28} />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>{p.name}</span>
                    {pickedUp && <span style={{ fontSize: 9, color: COLORS.green, marginLeft: 6 }}>✓ picked up</span>}
                    <div style={{ fontSize: 9, color: COLORS.ghost }}>{pickup?.label || "—"}</div>
                  </div>
                  {pickup?.lat && <Button title="🧭" variant="waze" size="sm" onClick={() => openWaze(pickup.lat, pickup.lng, pickup.label)} />}
                  {canEdit && !isRelocating && (
                    <Button title="MOVE" variant="ghost" size="sm" onClick={() => { setRelocatingId(p.id); setRemovingId(null); }} />
                  )}
                  {canEdit && passengers.length > 1 && !isConfirmingRemove && (
                    <Button title="✕" variant="danger" size="sm" onClick={() => { setRemovingId(p.id); setRelocatingId(null); }} />
                  )}
                </div>
                {isRelocating && (
                  <RelocateAgentPanel trip={trip} agent={p} currentPickup={pickup} dispatch={dispatch} onClose={() => setRelocatingId(null)} />
                )}
                {isConfirmingRemove && (
                  <div style={{ background: "rgba(232,58,58,.06)", border: "1px solid rgba(232,58,58,.3)", borderRadius: 4, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <span style={{ fontSize: 10, color: COLORS.chalk }}>Remove {p.name} from this trip?</span>
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
            <Button title="+ ADD PASSENGER TO THIS TRIP" variant="ghost" size="sm" onClick={() => setAddingAgent(true)} />
          )}
          {addingAgent && <AddAgentPanel trip={trip} state={state} dispatch={dispatch} onClose={() => setAddingAgent(false)} />}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ color: COLORS.ghost, fontSize: 10 }}>DROPOFF: </span>
            {(trip.dropoff_sequence_coords || []).map((c, i) => <span key={i} style={{ color: COLORS.red, fontSize: 10 }}>[{c.lat?.toFixed(4)},{c.lng?.toFixed(4)}] </span>)}
            {trip.dropoff_sequence_coords?.[0] && <Button title="🧭 WAZE" variant="waze" size="sm" onClick={() => openWaze(trip.dropoff_sequence_coords[0].lat, trip.dropoff_sequence_coords[0].lng, trip.custom_dropoff)} />}
          </div>
        </div>
      )}
    </>
  );
}

function AdminTrips({ state, dispatch }) {
  const [filter, setFilter] = useState("ALL");
  const filters = ["ALL", ...Object.values(TRIP_STATE)];
  const displayTrips = filter === "ALL" ? state.trips : state.trips.filter(t => t.state === filter);
  return (
    <div className="pad">
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {filters.map(f => <Button key={f} size="sm" variant={filter === f ? "amber" : "ghost"} title={f === "ALL" ? "ALL" : f.replace("_BOOKING", "").replace("ARCHIVED_", "")} onClick={() => setFilter(f)} />)}
      </div>
      <Card body={false}>
        {displayTrips.length === 0 ? <Empty icon="⊟" text="No trips" /> : displayTrips.map(t => <TripDetailRow key={t.trip_id} trip={t} state={state} dispatch={dispatch} />)}
      </Card>
    </div>
  );
}

function AdminDispatch({ state, dispatch }) {
  const [selectedTripId, setSelectedTripId] = useState(null);
  const [selectedDriverId, setSelectedDriverId] = useState(null);
  const [msg, setMsg] = useState(null);
  const unassigned = state.trips.filter(t => t.state === TRIP_STATE.UNASSIGNED_BOOKING);
  const selectedTrip = unassigned.find(t => t.trip_id === selectedTripId);
  const availableDrivers = state.driver_status.filter(ds => getDriverLoad(state, ds.driver_id) < DRIVER_CAPACITY);

  const handleDispatch = async () => {
    if (!selectedTripId || !selectedDriverId) return;
    await dispatch({ type: "TRIP/ASSIGN_DRIVER", trip_id: selectedTripId, driver_id: selectedDriverId });
    setMsg(`✓ Dispatched to ${state.users.find(u => u.id === selectedDriverId)?.name}`);
    setSelectedTripId(null); setSelectedDriverId(null);
    setTimeout(() => setMsg(null), 3000);
  };

  return (
    <div className="pad">
      {msg && <div style={{ background: "rgba(29,185,84,.1)", border: "1px solid rgba(29,185,84,.3)", borderRadius: 4, padding: 12 }}><span style={{ color: COLORS.green, fontWeight: 700, fontSize: 11 }}>{msg}</span></div>}
      <SectionHeader label={`Unassigned Bookings (${unassigned.length})`} />
      {unassigned.length === 0 ? <Empty icon="⊕" text="No unassigned bookings" /> : unassigned.map(t => (
        <div key={t.trip_id} onClick={() => { setSelectedTripId(t.trip_id); setSelectedDriverId(null); }}
          style={{ cursor: "pointer", background: COLORS.card, border: `1px solid ${selectedTripId === t.trip_id ? COLORS.amber : COLORS.wire}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 10, color: COLORS.amber, fontWeight: 700 }}>{t.trip_id}</span><StateBadge state={t.state} /></div>
          <div style={{ fontSize: 11, fontWeight: 700 }}>{t.agent_name}</div>
          <div style={{ fontSize: 11 }}><span style={{ color: COLORS.green }}>◉ </span>{t.custom_pickup}</div>
          <div style={{ fontSize: 11 }}><span style={{ color: COLORS.red }}>◎ </span>{t.custom_dropoff}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>📅 {t.scheduled_date}</span>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>🕐 {t.scheduled_time}</span>
            <span style={{ fontSize: 9, color: COLORS.ghost }}>{t.trip_type}</span>
          </div>
          {t.declinedBy?.length > 0 && <span style={{ fontSize: 9, color: COLORS.red }}>Declined by {t.declinedBy.length} driver{t.declinedBy.length !== 1 ? "s" : ""}</span>}
        </div>
      ))}
      {selectedTrip && (
        <>
          <SectionHeader label="Select Driver" />
          <div style={{ background: "rgba(245,166,35,.08)", borderRadius: 4, padding: 10, border: "1px solid rgba(245,166,35,.3)" }}>
            <span style={{ fontSize: 10, color: COLORS.mist }}>Assigning: <span style={{ color: COLORS.amber }}>{selectedTrip.trip_id}</span> — {selectedTrip.custom_pickup}</span>
          </div>
          {availableDrivers.length === 0 ? <Empty icon="◉" text="No drivers available — all fully booked" /> : availableDrivers.map(ds => {
            const u = state.users.find(x => x.id === ds.driver_id);
            const load = getDriverLoad(state, ds.driver_id);
            const sel = selectedDriverId === ds.driver_id;
            const declined = selectedTrip.declinedBy?.includes(ds.driver_id);
            return (
              <div key={ds.driver_id} onClick={() => !declined && setSelectedDriverId(ds.driver_id)}
                style={{ cursor: declined ? "not-allowed" : "pointer", opacity: declined ? .35 : 1, background: sel ? COLORS.amber : COLORS.card, border: `1px solid ${sel ? COLORS.amber2 : COLORS.wire}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, fontFamily: FONTS.head, color: sel ? COLORS.ink : COLORS.chalk }}>{u?.name}</span>
                  {declined && <span style={{ fontSize: 8, color: COLORS.red, fontWeight: 700, border: `1px solid ${COLORS.red}`, padding: "2px 5px", borderRadius: 2 }}>DECLINED</span>}
                  {sel && <span style={{ color: COLORS.ink }}>✓</span>}
                </div>
                <span style={{ fontSize: 10, color: sel ? COLORS.ink : COLORS.ghost }}>{ds.vehicle}</span>
                <CapacityBar load={load} capacity={DRIVER_CAPACITY} />
              </div>
            );
          })}
          {selectedDriverId && <Button title="⊕ DISPATCH NOW" variant="amber" full onClick={handleDispatch} />}
        </>
      )}
    </div>
  );
}

function AdminDrivers({ state }) {
  return (
    <div className="pad">
      <SectionHeader label={`Drivers (${state.driver_status.length})`} />
      {state.driver_status.length === 0 ? <Empty icon="◉" text="No drivers registered" /> : state.driver_status.map(ds => {
        const user = state.users.find(u => u.id === ds.driver_id);
        const load = getDriverLoad(state, ds.driver_id);
        const full = load >= DRIVER_CAPACITY;
        const activeTrips = state.trips.filter(t => t.driver_id === ds.driver_id && t.state !== TRIP_STATE.ARCHIVED_COMPLETED).sort((a, b) => (a.pickup_order_num || 99) - (b.pickup_order_num || 99));
        return (
          <Card key={ds.driver_id}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <DriverAvatar name={user?.name} size={46} />
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: FONTS.head, fontSize: 16, fontWeight: 800 }}>{user?.name}</div>
                <div style={{ fontSize: 10, color: COLORS.mist, marginTop: 2 }}>{ds.vehicle}</div>
                <div style={{ fontSize: 10, color: COLORS.ghost }}>{ds.phone}</div>
              </div>
              <StateBadge state={full ? "FULLY_BOOKED" : ds.state} />
            </div>
            <CapacityBar load={load} capacity={DRIVER_CAPACITY} />
            {activeTrips.length > 0 ? (
              <>
                <SectionHeader label="Active Route" />
                {activeTrips.map(trip => {
                  const pickupCoord = trip.pickup_sequence_coords?.[0];
                  const dropCoord = trip.dropoff_sequence_coords?.[0];
                  return (
                    <div key={trip.trip_id} style={{ display: "flex", gap: 12, paddingTop: 10, borderTop: `1px solid ${COLORS.wire}` }}>
                      <div style={{ width: 26, height: 26, borderRadius: 4, border: "1px solid rgba(29,185,84,.3)", background: "rgba(29,185,84,.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <span style={{ fontSize: 11, color: COLORS.green, fontWeight: 800 }}>{trip.pickup_order_num}</span>
                      </div>
                      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                        <StateBadge state={trip.state} />
                        <span style={{ fontSize: 11, fontWeight: 700 }}>{trip.agent_name}</span>
                        <span style={{ fontSize: 10 }}><span style={{ color: COLORS.green }}>◉ </span>{trip.custom_pickup}</span>
                        <span style={{ fontSize: 10 }}><span style={{ color: COLORS.red }}>◎ </span>{trip.custom_dropoff}</span>
                        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                          {pickupCoord && <Button title="🧭 PICKUP" variant="waze" size="sm" onClick={() => openWaze(pickupCoord.lat, pickupCoord.lng, trip.custom_pickup)} />}
                          {dropCoord && <Button title="🧭 DROP" variant="waze" size="sm" onClick={() => openWaze(dropCoord.lat, dropCoord.lng, trip.custom_dropoff)} />}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : <span style={{ fontSize: 10, color: COLORS.ghost, textAlign: "center", padding: 8 }}>No active trips — driver available</span>}
          </Card>
        );
      })}
    </div>
  );
}

function EditUserPanel({ user, driverStatus, dispatch, onClose }) {
  const [form, setForm] = useState({
    name: user.name, staffNumber: user.staff_number || "",
    vehicle: driverStatus?.vehicle || "", phone: driverStatus?.phone || "",
    homeStreet: user.home_address?.label || "", homeArea: user.home_address?.area || "",
    homeCoord: user.home_address ? { lat: user.home_address.lat, lng: user.home_address.lng } : null,
    branchId: user.branch_id || COMPANY_LOCATIONS[0].id,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Live preview of the >40 km branch-reassignment rule, computed from
  // whatever address is currently in the form (not necessarily saved yet),
  // so the admin sees the warning before committing the change.
  const branchDistanceKm = (() => {
    if (!form.homeCoord) return null;
    const branch = COMPANY_LOCATIONS.find(b => b.id === form.branchId);
    if (!branch) return null;
    return haversineKm(form.homeCoord.lat, form.homeCoord.lng, branch.lat, branch.lng) * 1.35;
  })();
  const willFlagFarReassignment = form.branchId !== user.branch_id && branchDistanceKm != null && branchDistanceKm > 40;

  const save = async () => {
    if (!form.name) return;
    setSaving(true);
    await dispatch({
      type: "ADMIN/UPDATE_USER", user_id: user.id,
      name: form.name,
      login: form.name, // username is always kept in sync with full name
      staff_number: form.staffNumber || undefined,
      pass: form.staffNumber || undefined, // password mirrors staff number — empty = keep existing
      vehicle: user.role === ROLE.DRIVER ? form.vehicle : undefined,
      phone: user.role === ROLE.DRIVER ? form.phone : undefined,
      home_address: user.role === ROLE.AGENT
        ? (form.homeCoord ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null)
        : undefined,
      branch_id: user.role === ROLE.AGENT ? form.branchId : undefined,
    });
    setSaving(false);
    onClose();
  };

  return (
    <Card style={{ borderColor: COLORS.amber2, background: "rgba(245,166,35,.03)" }}>
      <SectionHeader label={`Edit — ${user.role}`} />
      <TextField label="Full Name" value={form.name} onChange={e => set("name", e.target.value)} />
      <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Username is always the full name — currently "{form.name || user.name}"</span>
      <TextField label="Staff Number (also used as password)" value={form.staffNumber} onChange={e => set("staffNumber", e.target.value)} placeholder="e.g. AG1004" />
      {user.role === ROLE.AGENT && (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <SectionHeader label="Home Address (Cape Town)" />
            <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
              preConfirmed={form.homeCoord ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null}
              onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: confirmed ? coord : null }))} />
          </div>

          <SectionHeader label="Branch" />
          <div style={{ display: "flex", gap: 8 }}>
            {COMPANY_LOCATIONS.map(b => (
              <Button key={b.id} title={b.label} size="sm" variant={form.branchId === b.id ? "amber" : "ghost"} onClick={() => set("branchId", b.id)} style={{ flex: 1 }} />
            ))}
          </div>
          {branchDistanceKm != null && (
            <span style={{ fontSize: 9, color: willFlagFarReassignment ? COLORS.red : COLORS.ghost }}>
              {branchDistanceKm.toFixed(1)} km from home address
              {willFlagFarReassignment ? " — exceeds 40 km, previous branch will be kept on file" : ""}
            </span>
          )}
          {(user.branch_history || []).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, background: COLORS.surface, borderRadius: 4, padding: 10, border: `1px solid ${COLORS.wire}` }}>
              <span style={{ fontSize: 9, color: COLORS.ghost, textTransform: "uppercase", letterSpacing: 1 }}>Branch History</span>
              {user.branch_history.map((h, i) => {
                const b = COMPANY_LOCATIONS.find(c => c.id === h.branch_id);
                return <span key={i} style={{ fontSize: 9, color: COLORS.chalk }}>• {b?.label || h.branch_id} — {h.changed_at}</span>;
              })}
            </div>
          )}
        </>
      )}
      {user.role === ROLE.DRIVER && (
        <>
          <TextField label="Vehicle" value={form.vehicle} onChange={e => set("vehicle", e.target.value)} placeholder="Toyota Hiace - CA 000-000" />
          <TextField label="Phone" value={form.phone} onChange={e => set("phone", e.target.value)} />
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={onClose} />
        <Button title={saving ? "SAVING…" : "SAVE CHANGES"} variant="amber" style={{ flex: 1 }} onClick={save} disabled={saving} loading={saving} />
      </div>
    </Card>
  );
}

function AdminUsers({ state, dispatch }) {
  const [show, setShow] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ name: "", staffNumber: "", role: ROLE.AGENT, vehicle: "", phone: "", homeStreet: "", homeArea: "", homeCoord: null, homeConfirmed: false, branchId: COMPANY_LOCATIONS[0].id });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.name || !form.staffNumber) return;
    await dispatch({
      type: "ADMIN/CREATE_USER", name: form.name, role: form.role, vehicle: form.vehicle, phone: form.phone,
      staff_number: form.staffNumber,
      auth: { login: form.name, pass: form.staffNumber }, // username = full name, password = staff number
      home_address: (form.role === ROLE.AGENT && form.homeCoord) ? { label: form.homeStreet, area: form.homeArea, lat: form.homeCoord.lat, lng: form.homeCoord.lng } : null,
      branch_id: form.role === ROLE.AGENT ? form.branchId : undefined,
    });
    setForm({ name: "", staffNumber: "", role: ROLE.AGENT, vehicle: "", phone: "", homeStreet: "", homeArea: "", homeCoord: null, homeConfirmed: false, branchId: COMPANY_LOCATIONS[0].id });
    setShow(false);
  };

  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <SectionHeader label="User Registry" />
        <Button title="+ CREATE USER" variant="amber" size="sm" onClick={() => { setShow(s => !s); setEditingId(null); }} />
      </div>
      {show && (
        <Card>
          <TextField label="Full Name" value={form.name} onChange={e => set("name", e.target.value)} />
          <span style={{ fontSize: 9, color: COLORS.ghost, marginTop: -4 }}>Username will be the full name above</span>
          <SectionHeader label="Role" />
          <div style={{ display: "flex", gap: 8 }}>
            {[ROLE.AGENT, ROLE.DRIVER, ROLE.ADMIN].map(r => <Button key={r} title={r} size="sm" variant={form.role === r ? "amber" : "ghost"} onClick={() => set("role", r)} style={{ flex: 1 }} />)}
          </div>
          <TextField label="Staff Number (also used as password)" value={form.staffNumber} onChange={e => set("staffNumber", e.target.value)} placeholder="e.g. AG1004" />
          {form.role === ROLE.AGENT && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <SectionHeader label="Home Address (Cape Town)" />
                <StreetInput value={form.homeStreet} placeholder="e.g. Main Road, Claremont"
                  onChange={({ street, area, coord, confirmed }) => setForm(f => ({ ...f, homeStreet: street, homeArea: area, homeCoord: coord, homeConfirmed: !!confirmed }))} />
              </div>
              <SectionHeader label="Branch" />
              <div style={{ display: "flex", gap: 8 }}>
                {COMPANY_LOCATIONS.map(b => <Button key={b.id} title={b.label} size="sm" variant={form.branchId === b.id ? "amber" : "ghost"} onClick={() => set("branchId", b.id)} style={{ flex: 1 }} />)}
              </div>
            </>
          )}
          {form.role === ROLE.DRIVER && (
            <>
              <TextField label="Vehicle" value={form.vehicle} onChange={e => set("vehicle", e.target.value)} placeholder="Toyota Hiace - CA 000-000" />
              <TextField label="Phone" value={form.phone} onChange={e => set("phone", e.target.value)} />
            </>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button title="CANCEL" variant="ghost" style={{ flex: 1 }} onClick={() => setShow(false)} />
            <Button title="CREATE →" variant="amber" style={{ flex: 1 }} onClick={submit} />
          </div>
        </Card>
      )}
      <Card body={false}>
        {state.users.map(u => {
          const isEditing = editingId === u.id;
          const driverStatus = u.role === ROLE.DRIVER ? state.driver_status.find(d => d.driver_id === u.id) : null;
          return (
            <React.Fragment key={u.id}>
              <div onClick={() => { setEditingId(isEditing ? null : u.id); setShow(false); }}
                style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 12, padding: 12, borderBottom: isEditing ? "none" : `1px solid ${COLORS.wire}`, background: isEditing ? "rgba(245,166,35,.05)" : "transparent" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, fontWeight: 700 }}>{u.name}</div>
                  <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 1 }}>Staff #: {u.staff_number || "—"}</div>
                  {u.role === ROLE.AGENT && u.home_address && <div style={{ fontSize: 9, color: COLORS.green, marginTop: 2 }}>📍 {u.home_address.label}</div>}
                  {u.role === ROLE.DRIVER && driverStatus?.vehicle && <div style={{ fontSize: 9, color: COLORS.ghost, marginTop: 2 }}>🚐 {driverStatus.vehicle}</div>}
                </div>
                <RoleBadge role={u.role} />
                <span style={{ color: COLORS.ghost, fontSize: 11 }}>{isEditing ? "▲" : "✎"}</span>
              </div>
              {isEditing && (
                <div style={{ padding: "0 12px 12px", borderBottom: `1px solid ${COLORS.wire}` }}>
                  <EditUserPanel user={u} driverStatus={driverStatus} dispatch={dispatch} onClose={() => setEditingId(null)} />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </Card>
    </div>
  );
}

function AdminNotifs({ state, dispatch }) {
  const adminNotifs = state.notifications.filter(n => !n.for_user_ids?.length && (n.for_roles?.includes(ROLE.ADMIN) || !n.for_roles?.length));
  const unread = adminNotifs.filter(n => !n.read).length;
  const ICONS = { TRIP_BOOKED: "📋", DRIVER_ASSIGNED: "🚗", TRIP_CONFIRMED: "🔔", IN_TRANSIT: "🚦", TRIP_COMPLETED: "🏁", DRIVER_FULLY_BOOKED: "⚠", TRIP_ACCEPTED: "✅", TRIP_DECLINED: "✗", UPCOMING_TRIP: "⏰", LONG_DISTANCE_TRIP: "📏", DISTANCE_SURCHARGE: "💰", LATE_BOOKING: "⏰", BRANCH_REASSIGNED_FAR: "📍" };
  return (
    <div className="pad">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontFamily: FONTS.head, fontSize: 18, fontWeight: 800 }}>ALERTS</div>
          {unread > 0 && <div style={{ fontSize: 10, color: COLORS.amber, marginTop: 2 }}>{unread} unread</div>}
        </div>
        {unread > 0 && <Button title="CLEAR ALL" variant="ghost" size="sm" onClick={() => dispatch({ type: "NOTIF/MARK_ALL_READ" })} />}
      </div>
      {adminNotifs.length === 0 ? <Empty icon="◬" text="No admin alerts" /> : adminNotifs.map(n => (
        <div key={n.id} onClick={() => dispatch({ type: "NOTIF/MARK_READ", id: n.id })}
          style={{ cursor: "pointer", background: n.read ? COLORS.card : "rgba(245,166,35,.06)", border: `1px solid ${n.read ? COLORS.wire : "rgba(245,166,35,.25)"}`, borderRadius: 4, padding: 13, display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: 14 }}>{ICONS[n.type] || "◈"}</span>
            <span style={{ fontSize: 9, fontWeight: 700, color: COLORS.amber, letterSpacing: 1, textTransform: "uppercase", flex: 1 }}>{n.type.replace(/_/g, " ")}</span>
            {!n.read && <div style={{ width: 7, height: 7, borderRadius: 4, background: COLORS.amber }} />}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.5 }}>{n.message}</div>
          <div style={{ fontSize: 9, color: COLORS.dim }}>{n.ts}</div>
        </div>
      ))}
    </div>
  );
}

const ADMIN_NAV = [["dashboard", "◈", "Dashboard"], ["trips", "⊟", "All Trips"], ["dispatch", "⊕", "Dispatch"], ["drivers", "◉", "Drivers"], ["users", "◐", "Users"], ["notifs", "◬", "Alerts"]];

function AdminApp({ state, dispatch, user }) {
  const [tab, setTab] = useState("dashboard");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const notifCount = state.notifications.filter(n => !n.read && n.for_roles?.includes(ROLE.ADMIN)).length;

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <div style={{ width: 220, flexShrink: 0, background: COLORS.panel, borderRight: `1px solid ${COLORS.wire}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh" }}>
        <div style={{ padding: 16, borderBottom: `1px solid ${COLORS.wire}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: COLORS.amber, fontWeight: 800, fontSize: 13, letterSpacing: 2 }}>TRANSIT/OS</span>
          <RoleBadge role={ROLE.ADMIN} />
        </div>
        <div style={{ flex: 1, paddingTop: 12 }}>
          {ADMIN_NAV.map(([id, icon, label]) => {
            const active = tab === id;
            const badge = id === "notifs" ? notifCount : 0;
            return (
              <div key={id} onClick={() => setTab(id)} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 18px", cursor: "pointer", background: active ? "rgba(245,166,35,.06)" : "transparent", borderLeft: `2px solid ${active ? COLORS.amber : "transparent"}` }}>
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
          <span style={{ fontSize: 10, color: COLORS.ghost, marginBottom: 10 }}>Control Admin</span>
          <Button title="LOGOUT" variant="ghost" size="sm" full onClick={() => dispatch({ type: "AUTH/LOGOUT" })} />
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tab === "dashboard" && <AdminDashboard state={state} />}
        {tab === "trips" && <AdminTrips state={state} dispatch={dispatch} />}
        {tab === "dispatch" && <AdminDispatch state={state} dispatch={dispatch} />}
        {tab === "drivers" && <AdminDrivers state={state} />}
        {tab === "users" && <AdminUsers state={state} dispatch={dispatch} />}
        {tab === "notifs" && <AdminNotifs state={state} dispatch={dispatch} />}
      </div>
    </div>
  );
}

/* ============================================================
   ROOT APP
   ============================================================ */
export default function App() {
  const [state, dispatch] = useAppStore();
  const [toasts, setToasts] = useState([]);
  const [loginError, setLoginError] = useState(null);
  const prevNotifsLen = useRef(0);

  const pushToast = useCallback((title, body, color = COLORS.amber) => {
    const id = Math.random().toString(36).slice(2);
    setToasts(t => [...t, { id, title, body, color }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200);
  }, []);

  useEffect(() => {
    if (state.notifications.length > prevNotifsLen.current) {
      const newest = state.notifications[0];
      if (newest) pushToast(newest.type.replace(/_/g, " "), newest.message);
    }
    prevNotifsLen.current = state.notifications.length;
  }, [state.notifications]);

  const activeUser = state.users.find(u => u.id === state.active_user_id);

  const handleLogin = async (login, pass) => {
    setLoginError(null);
    await dispatch({ type: "AUTH/LOGIN", login, pass });
  };

  useEffect(() => {
    if (state._error && !state.active_user_id) setLoginError(state._error);
  }, [state._error, state.active_user_id]);

  useEffect(() => {
    const styleEl = document.createElement("style");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
    return () => document.head.removeChild(styleEl);
  }, []);

  if (state._loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <span style={{ color: COLORS.ghost, fontSize: 11, letterSpacing: 1 }}>Connecting to TransitOS…</span>
      </div>
    );
  }

  return (
    <div className="app-root">
      {!activeUser ? (
        <LoginScreen users={state.users} onLogin={handleLogin} error={loginError} />
      ) : activeUser.role === ROLE.ADMIN ? (
        <AdminApp state={state} dispatch={dispatch} user={activeUser} />
      ) : activeUser.role === ROLE.AGENT ? (
        <AgentApp state={state} dispatch={dispatch} user={activeUser} />
      ) : (
        <DriverApp state={state} dispatch={dispatch} user={activeUser} />
      )}

      <div className="toast-stack">
        {toasts.map(t => (
          <div key={t.id} className="toast" style={{ borderLeftColor: t.color }}>
            <div className="toast-title">{t.title}</div>
            <div className="toast-body">{t.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
