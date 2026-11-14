"use strict";

/* ================================================================
   Constants
   ================================================================ */

const STORAGE_KEY = "garden-sun-direction-v1";
const PATH_STEP_MIN = 2;       // sampling step for drawing the sun's path along the outline
const AVERAGE_STEP_MIN = 5;    // sampling step for monthly averages
const RAD = Math.PI / 180;
const DAY_MS = 864e5;

const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

const STATUS = { NIGHT: 0, SHADE: 1, FILTERED: 2, SUN: 3 };

// Colours drawn on the outline
const COLORS = {
    sun: "#ffd43b",          // the sun reaches your position over this part of the tree line
    filtered: "#fff3bf",     // the sun shines through bare (leafless) trees
    shade: "#868e96",        // the sun is behind the trees: you are in shade
    trees: "#2f9e44",
    noTrees: "#f1f3f5",
    casing: "#1d1d1b"
};

/* ================================================================
   Date helpers — a date is the UTC timestamp of its midnight
   ================================================================ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad2 = n => String(n).padStart(2, "0");

function civil(dateMs) {
    const dt = new Date(dateMs);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

const makeDate = (y, m, d) => Date.UTC(y, m - 1, d);

function todayDate() {
    const now = new Date();
    return makeDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

/** European format: 21/06/2026 */
function fmtDate(dateMs) {
    const { y, m, d } = civil(dateMs);
    return `${pad2(d)}/${pad2(m)}/${y}`;
}

/** Parses dd/mm/yyyy (also accepts - or . as separator, and a 2-digit year). */
function parseDate(text) {
    const match = String(text).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/);
    if (!match) return null;
    const d = +match[1], m = +match[2];
    let y = +match[3];
    if (y < 100) y += 2000;
    const ms = makeDate(y, m, d);
    const check = civil(ms);
    return check.d === d && check.m === m ? ms : null;
}

/** Parses dd/mm into [month, day]. */
function parseDayMonth(text) {
    const match = String(text).trim().match(/^(\d{1,2})[\/.\-](\d{1,2})$/);
    if (!match) return null;
    const d = +match[1], m = +match[2];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return [m, d];
}

const fmtDayMonth = ([m, d]) => `${pad2(d)}/${pad2(m)}`;

function dayOfYear(dateMs) {
    const { y } = civil(dateMs);
    return Math.round((dateMs - makeDate(y, 1, 1)) / DAY_MS) + 1;
}

function daysInYear(y) {
    return (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
}

const fmtClock = min => `${pad2(Math.floor(min / 60) % 24)}:${pad2(Math.round(min) % 60)}`;

function fmtDur(h) {
    const m = Math.round(h * 60);
    if (m < 60) return `${m} min`;
    return m % 60 === 0 ? `${m / 60} h` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
const compassName = az => COMPASS[Math.round(az / 22.5) % 16];

/* ================================================================
   State and persistence
   ================================================================ */

const DEFAULTS = {
    mode: "day",
    month: new Date().getMonth() + 1,
    treeHeight: 25,
    crown: 3,
    treeType: "evergreen",
    leafOut: [4, 20],
    leafFall: [11, 10],
    tz: DEFAULT_TIME_ZONE,
    speed: 5,
    position: null           // { lat, lng }
};

let state = { ...DEFAULTS, date: todayDate(), minute: 12 * 60, monthYear: new Date().getFullYear() };
let garden = null;           // { name, ring: [[lon, lat]...], edges: [{ trees, height }] }
let geom = null;             // garden projected to metres

function loadSaved() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (saved?.settings) {
            for (const k of Object.keys(DEFAULTS)) {
                if (k in saved.settings) state[k] = saved.settings[k];
            }
        }
        if (saved?.garden?.ring?.length >= 3) garden = saved.garden;
    } catch {
        // ignore broken storage
    }
}

function save() {
    try {
        const settings = {};
        for (const k of Object.keys(DEFAULTS)) settings[k] = state[k];
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings, garden }));
    } catch {
        // storage may be unavailable (private mode); not critical
    }
}

/* ================================================================
   GeoJSON
   ================================================================ */

function gardenFromGeoJSON(gj, fallbackName) {
    let found = null;
    const visit = (o, props) => {
        if (!o || found) return;
        if (o.type === "FeatureCollection") o.features.forEach(f => visit(f, props));
        else if (o.type === "Feature") visit(o.geometry, o.properties || {});
        else if (o.type === "GeometryCollection") o.geometries.forEach(g => visit(g, props));
        else if (o.type === "Polygon") found = { ring: o.coordinates[0], props };
        else if (o.type === "MultiPolygon") found = { ring: o.coordinates[0][0], props };
    };
    visit(gj, {});
    if (!found) throw new Error("No polygon found in this file.");

    const ring = found.ring.map(p => [Number(p[0]), Number(p[1])]);
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) ring.pop();
    if (ring.length < 3 || ring.some(p => !isFinite(p[0]) || !isFinite(p[1]))) {
        throw new Error("The polygon in this file is not valid.");
    }
    return {
        name: found.props?.name || fallbackName || "Garden",
        ring,
        edges: ring.map(() => ({ trees: true, height: null }))
    };
}

/* ================================================================
   Geometry (local metric projection: x = metres east, y = metres north)
   ================================================================ */

function makeProjection(ring) {
    const lon0 = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const kx = 111320 * Math.cos(lat0 * RAD);
    const ky = 110574;
    return {
        lat0, lon0,
        fwd: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
        inv: (x, y) => [lat0 + y / ky, lon0 + x / kx]          // → [lat, lon] for Leaflet
    };
}

function pointInPolygon(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function distToSegment(px, py, e) {
    const ex = e.bx - e.ax, ey = e.by - e.ay;
    const len2 = ex * ex + ey * ey;
    const t = len2 ? clamp(((px - e.ax) * ex + (py - e.ay) * ey) / len2, 0, 1) : 0;
    return Math.hypot(px - (e.ax + t * ex), py - (e.ay + t * ey));
}

function makeGeometry() {
    const proj = makeProjection(garden.ring);
    const pts = garden.ring.map(([lon, lat]) => proj.fwd(lon, lat));
    const edges = pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const e = garden.edges[i];
        return { i, ax: a[0], ay: a[1], bx: b[0], by: b[1], trees: e.trees, h: e.height ?? state.treeHeight };
    });
    let area = 0;
    pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        area += a[0] * b[1] - b[0] * a[1];
    });
    return { proj, pts, edges, area: Math.abs(area) / 2 };
}

/** Intersection of the ray from (px, py) in direction (dx, dy) with an edge: distance t and position s along the edge. */
function intersect(px, py, dx, dy, e) {
    const ex = e.bx - e.ax, ey = e.by - e.ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return null;
    const wx = e.ax - px, wy = e.ay - py;
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * dy - wy * dx) / den;
    return t > 0 && s >= 0 && s <= 1 ? { t, s } : null;
}

/** First point where a ray from the position towards azimuth `az` meets the outline. */
function outlineHit(pos, az) {
    const dx = Math.sin(az * RAD), dy = Math.cos(az * RAD);
    let best = null;
    for (const e of geom.edges) {
        const hit = intersect(pos.x, pos.y, dx, dy, e);
        if (hit && (!best || hit.t < best.t)) best = { edge: e.i, t: hit.t, x: pos.x + hit.t * dx, y: pos.y + hit.t * dy };
    }
    return best;
}

/** Whether the sun at (azimuth, elevation) reaches the position over the tree lines. */
function sunStatus(pos, az, el, leafless) {
    if (el <= 0) return STATUS.NIGHT;
    const blocked = leafless ? STATUS.FILTERED : STATUS.SHADE;
    if (pos.underCanopy) return blocked;
    const tanE = Math.tan(el * RAD);
    const dx = Math.sin(az * RAD), dy = Math.cos(az * RAD);
    const crown = state.crown;
    for (const e of geom.edges) {
        if (!e.trees) continue;
        const hit = intersect(pos.x, pos.y, dx, dy, e);
        // treetops form a wall of height h, set back towards the garden by the crown reach
        if (hit && tanE < e.h / Math.max(hit.t - crown, 0.01)) return blocked;
    }
    return STATUS.SUN;
}

function makePosition(lat, lng) {
    const [x, y] = geom.proj.fwd(lng, lat);
    const underCanopy = geom.edges.some(e => e.trees && distToSegment(x, y, e) < state.crown);
    return { lat, lng, x, y, underCanopy };
}

/* ================================================================
   Sun over a day
   ================================================================ */

function utcFor(dateMs, minute) {
    // UTC offset at local noon of that day (summer/winter time)
    const offset = Solar.tzOffsetMin(dateMs + 12 * 3600000, state.tz);
    return dateMs + (minute - offset) * 60000;
}

function sunAt(dateMs, minute) {
    return Solar.position(utcFor(dateMs, minute), geom.proj.lat0, geom.proj.lon0);
}

function isLeafless(dateMs) {
    if (state.treeType !== "deciduous") return false;
    const { m, d } = civil(dateMs);
    const key = m * 100 + d;
    const out = state.leafOut[0] * 100 + state.leafOut[1];
    const fall = state.leafFall[0] * 100 + state.leafFall[1];
    return out < fall ? (key < out || key >= fall) : (key >= fall && key < out);
}

/** Sunrise and sunset in local minutes (top of the disc on the horizon; elevation includes refraction). */
function sunTimes(dateMs) {
    let rise = null, set = null, prevUp = false;
    for (let m = 0; m <= 1440; m++) {
        const up = sunAt(dateMs, m).elevation > -0.27;
        if (m > 0 && up && !prevUp && rise === null) rise = m;
        if (m > 0 && !up && prevUp) set = m;
        prevUp = up;
    }
    return { rise, set };
}

/** Samples the day: where the sun stands on the outline as seen from `pos`, and whether it reaches `pos`. */
function computeDay(pos, dateMs, step) {
    const leafless = isLeafless(dateMs);
    const samples = [];
    for (let m = 0; m < 1440; m += step) {
        const s = sunAt(dateMs, m);
        if (s.elevation <= 0) continue;
        samples.push({
            minute: m,
            az: s.azimuth,
            el: s.elevation,
            status: sunStatus(pos, s.azimuth, s.elevation, leafless),
            hit: outlineHit(pos, s.azimuth)
        });
    }
    return { samples, leafless };
}

/** Time intervals in which the sun reaches the position (direct or through bare trees). */
function sunIntervals(samples, step) {
    const intervals = [];
    let current = null;
    for (const s of samples) {
        const lit = s.status === STATUS.SUN || s.status === STATUS.FILTERED;
        if (lit && current && s.minute - current.end <= step) {
            current.end = s.minute + step;
            current.filtered ||= s.status === STATUS.FILTERED;
        } else if (lit) {
            current = { start: s.minute, end: s.minute + step, filtered: s.status === STATUS.FILTERED };
            intervals.push(current);
        }
    }
    return intervals;
}

const totalHours = intervals => intervals.reduce((h, iv) => h + (iv.end - iv.start) / 60, 0);

function monthAverage(pos, y, m) {
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    let hours = 0;
    for (let d = 1; d <= days; d++) {
        const { samples } = computeDay(pos, makeDate(y, m, d), AVERAGE_STEP_MIN);
        hours += totalHours(sunIntervals(samples, AVERAGE_STEP_MIN));
    }
    return hours / days;
}

/* ================================================================
   Map
   ================================================================ */

const map = L.map("map", { maxZoom: 22, zoomSnap: 0.25 });
const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 19, maxZoom: 22, attribution: "Imagery © Esri, Maxar, Earthstar Geographics"
});
const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19, maxZoom: 22, attribution: "© OpenStreetMap contributors"
});
satellite.addTo(map);
L.control.layers({ "Satellite": satellite, "Map": streets }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const edgeLayer = L.layerGroup().addTo(map);     // clickable garden sides
const pathLayer = L.layerGroup().addTo(map);     // the sun's path along the outline
const nowLayer = L.layerGroup().addTo(map);      // current sun position (day playback)
let posMarker = null;

const toLatLng = (x, y) => geom.proj.inv(x, y);

function edgeLength(i) {
    const e = geom.edges[i];
    return Math.hypot(e.bx - e.ax, e.by - e.ay);
}

function drawEdges() {
    edgeLayer.clearLayers();
    garden.ring.forEach((a, i) => {
        const b = garden.ring[(i + 1) % garden.ring.length];
        const edge = garden.edges[i];
        const h = edge.height ?? state.treeHeight;
        const line = L.polyline([[a[1], a[0]], [b[1], b[0]]], {
            color: edge.trees ? COLORS.trees : COLORS.noTrees,
            weight: edge.trees ? 5 : 3,
            dashArray: edge.trees ? null : "6 7",
            opacity: 0.95
        }).addTo(edgeLayer);
        line.bindTooltip(edge.trees
            ? `Side ${i + 1}: trees ${h} m${edge.height != null ? " (own height)" : ""} — click to change`
            : `Side ${i + 1}: no trees — click to change`, { sticky: true });
        line.on("click", e => {
            L.DomEvent.stopPropagation(e);
            openEdgePopup(i, e.latlng);
        });
    });
}

function openEdgePopup(i, latlng) {
    const edge = garden.edges[i];
    const div = document.createElement("div");
    div.className = "edge-popup";
    div.innerHTML = `
        <strong>Side ${i + 1}</strong> · ${Math.round(edgeLength(i))} m long
        <label><input type="checkbox" class="e-trees" ${edge.trees ? "checked" : ""}> Trees along this side</label>
        <label>Height <input type="number" class="e-height" min="1" max="80" step="1"
            value="${edge.height ?? ""}" placeholder="${state.treeHeight}"> m</label>
        <div class="small-text">Leave the height empty to use the average height.</div>`;
    const apply = () => {
        edge.trees = div.querySelector(".e-trees").checked;
        const h = parseFloat(div.querySelector(".e-height").value);
        edge.height = isFinite(h) && h > 0 ? h : null;
        geometryChanged();
    };
    div.querySelector(".e-trees").addEventListener("change", apply);
    div.querySelector(".e-height").addEventListener("change", apply);
    L.popup().setLatLng(latlng).setContent(div).openOn(map);
}

/**
 * Turns the samples into polylines that follow the outline.
 * Consecutive hits on neighbouring sides are joined through their shared corner;
 * jumps to a non-neighbouring side (a corner hiding part of the outline) start a new line.
 */
function outlineRuns(samples) {
    const n = geom.edges.length;
    const runs = [];
    let run = null, prev = null;
    for (const s of samples) {
        if (!s.hit) { prev = null; continue; }
        const point = toLatLng(s.hit.x, s.hit.y);

        // Points to insert between the previous hit and this one (a shared corner), or a break
        let connected = prev !== null;
        let bridge = [];
        if (connected && prev.hit.edge !== s.hit.edge) {
            const a = prev.hit.edge, b = s.hit.edge;
            const corner = b === (a + 1) % n ? b : a === (b + 1) % n ? a : null;
            if (corner === null) connected = false;
            else bridge = [toLatLng(...geom.pts[corner])];
        }

        if (!connected) {
            if (run && run.status === s.status) run.lines.push([point]);
            else runs.push(run = { status: s.status, lines: [[point]] });
        } else {
            // extend the current run up to this point, then start a new run if the status changed
            run.lines[run.lines.length - 1].push(...bridge, point);
            if (run.status !== s.status) runs.push(run = { status: s.status, lines: [[point]] });
        }
        prev = s;
    }
    return runs;
}

const statusColor = st => st === STATUS.SUN ? COLORS.sun : st === STATUS.FILTERED ? COLORS.filtered : COLORS.shade;
const STATUS_TEXT = {
    [STATUS.SUN]: "sun reaches you",
    [STATUS.FILTERED]: "sun through bare trees",
    [STATUS.SHADE]: "sun behind the trees",
    [STATUS.NIGHT]: "sun below the horizon"
};

function drawPath(day) {
    pathLayer.clearLayers();
    const runs = outlineRuns(day.samples);

    // Dark casing first so the colours stand out on the satellite image
    for (const run of runs) {
        L.polyline(run.lines, { color: COLORS.casing, weight: 13, opacity: 0.55, interactive: false, lineCap: "butt" }).addTo(pathLayer);
    }
    for (const run of runs) {
        L.polyline(run.lines, {
            color: statusColor(run.status),
            weight: run.status === STATUS.SHADE ? 7 : 9,
            opacity: 1,
            interactive: false,
            lineCap: "butt"
        }).addTo(pathLayer);
    }

    // Hour marks along the outline
    for (const s of day.samples) {
        if (s.minute % 60 !== 0 || !s.hit) continue;
        const icon = L.divIcon({
            className: "",
            html: `<div class="hour-mark ${s.status === STATUS.SUN ? "lit" : ""}">${s.minute / 60}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        });
        L.marker(toLatLng(s.hit.x, s.hit.y), { icon, keyboard: false })
            .bindTooltip(`<strong>${fmtClock(s.minute)}</strong> · sun in the ${compassName(s.az)} (${Math.round(s.az)}°), ${s.el.toFixed(0)}° high<br>${STATUS_TEXT[s.status]}`)
            .addTo(pathLayer);
    }
}

function drawNow(pos, sunPos, status) {
    nowLayer.clearLayers();
    if (sunPos.elevation <= 0) return;
    const hit = outlineHit(pos, sunPos.azimuth);
    if (!hit) return;
    const from = [pos.lat, pos.lng], to = toLatLng(hit.x, hit.y);
    const lit = status === STATUS.SUN || status === STATUS.FILTERED;
    L.polyline([from, to], {
        color: lit ? COLORS.sun : "#ffffff",
        weight: 3,
        opacity: lit ? 0.95 : 0.8,
        dashArray: lit ? null : "6 6",
        interactive: false
    }).addTo(nowLayer);
    L.marker(to, {
        icon: L.divIcon({ className: "", html: `<div class="sun-now ${lit ? "" : "hidden-sun"}"></div>`, iconSize: [30, 30], iconAnchor: [15, 15] }),
        interactive: false,
        keyboard: false
    }).addTo(nowLayer);
}

function setPosition(lat, lng) {
    state.position = { lat, lng };
    save();
    if (!posMarker) {
        posMarker = L.marker([lat, lng], {
            draggable: true,
            icon: L.divIcon({ className: "", html: '<div class="pos-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] })
        }).addTo(map);
        posMarker.bindTooltip("Your position — drag to move");
        posMarker.on("drag", () => {
            const ll = posMarker.getLatLng();
            const [x, y] = geom.proj.fwd(ll.lng, ll.lat);
            if (pointInPolygon(x, y, geom.pts)) {
                state.position = { lat: ll.lat, lng: ll.lng };
                renderAll();
            }
        });
        posMarker.on("dragend", () => {
            const { lat: la, lng: ln } = state.position;
            posMarker.setLatLng([la, ln]);     // snap back inside if dragged out
            save();
        });
    } else {
        posMarker.setLatLng([lat, lng]);
    }
    renderAll();
}

function clearPosition() {
    state.position = null;
    save();
    posMarker?.remove();
    posMarker = null;
    renderAll();
}

map.on("click", e => {
    if (!geom) return;
    const [x, y] = geom.proj.fwd(e.latlng.lng, e.latlng.lat);
    if (!pointInPolygon(x, y, geom.pts)) return;
    setPosition(e.latlng.lat, e.latlng.lng);
});

/* ================================================================
   Rendering
   ================================================================ */

let dayCache = null;   // path for the shown day; recomputed only when date/position/settings change

function currentPosition() {
    if (!state.position || !geom) return null;
    return makePosition(state.position.lat, state.position.lng);
}

function shownDate() {
    return state.mode === "day" ? state.date : makeDate(state.monthYear, state.month, 15);
}

/** Recomputes the sun's path (date, position or tree change) and redraws everything. */
function renderAll() {
    dayCache = null;
    render();
}

function render() {
    syncInputs();
    const pos = currentPosition();
    $("posHint").hidden = !!pos;
    $("posInfo").hidden = !pos;
    if (!pos) {
        pathLayer.clearLayers();
        nowLayer.clearLayers();
        $("sunInfo").innerHTML = `<p class="muted">Click your position in the garden to see where the sun comes from.</p>`;
        $("legend").innerHTML = "";
        return;
    }
    $("posCoords").textContent = `${pos.lat.toFixed(6)}, ${pos.lng.toFixed(6)}`;

    const dateMs = shownDate();
    const key = `${dateMs}|${pos.lat}|${pos.lng}`;
    if (dayCache?.key !== key) {
        const day = computeDay(pos, dateMs, PATH_STEP_MIN);
        dayCache = {
            key, day,
            intervals: sunIntervals(day.samples, PATH_STEP_MIN),
            times: sunTimes(dateMs),
            monthAvg: state.mode === "month" ? monthAverage(pos, state.monthYear, state.month) : null
        };
        drawPath(day);
    }

    if (state.mode === "day") {
        const sunPos = sunAt(state.date, state.minute);
        const status = sunStatus(pos, sunPos.azimuth, sunPos.elevation, dayCache.day.leafless);
        drawNow(pos, sunPos, status);
        renderDayInfo(sunPos, status);
    } else {
        nowLayer.clearLayers();
        renderMonthInfo();
    }
    renderLegend();
}

function intervalsText(intervals) {
    if (!intervals.length) return "The sun does not reach this spot.";
    return intervals.map(iv => `${fmtClock(iv.start)} – ${fmtClock(iv.end)}${iv.filtered ? "*" : ""}`).join(", ");
}

function sunriseSunsetText() {
    const { rise, set } = dayCache.times;
    if (rise === null || set === null) return "";
    const s = dayCache.day.samples;
    const first = s[0], last = s[s.length - 1];
    return `<div>Sunrise <strong>${fmtClock(rise)}</strong> in the ${compassName(first.az)} · sunset <strong>${fmtClock(set)}</strong> in the ${compassName(last.az)}</div>`;
}

function compassSvg(az, el) {
    const r = 26, cx = 32, cy = 32;
    const x = cx + Math.sin(az * RAD) * r * 0.78, y = cy - Math.cos(az * RAD) * r * 0.78;
    return `<svg width="64" height="64" viewBox="0 0 64 64" aria-label="Sun direction ${Math.round(az)} degrees">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".25"/>
        <text x="${cx}" y="10" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">N</text>
        <text x="${cx}" y="61" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">S</text>
        <text x="58" y="35" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">E</text>
        <text x="6" y="35" text-anchor="middle" font-size="9" fill="currentColor" opacity=".6">W</text>
        ${el > 0 ? `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="currentColor" stroke-opacity=".5" stroke-width="1.5"/>
        <circle cx="${x}" cy="${y}" r="6" fill="${COLORS.sun}" stroke="#a08a00"/>` : ""}
    </svg>`;
}

function renderDayInfo(sunPos, status) {
    const { intervals } = dayCache;
    let now;
    if (sunPos.elevation <= 0) {
        now = `<div>The sun is below the horizon.</div>`;
    } else {
        const statusLine = {
            [STATUS.SUN]: "☀ The sun reaches your position",
            [STATUS.FILTERED]: "The sun shines through the bare trees",
            [STATUS.SHADE]: "The sun is behind the trees — you are in the shade"
        }[status];
        now = `<div>Sun in the <strong>${compassName(sunPos.azimuth)}</strong> (${Math.round(sunPos.azimuth)}°), <strong>${sunPos.elevation.toFixed(1)}°</strong> above the horizon</div>
            <div class="status s${status}">${statusLine}</div>`;
    }
    $("sunInfo").innerHTML = `<div class="now">${compassSvg(sunPos.azimuth, sunPos.elevation)}<div class="facts">
            <div class="big">${fmtDate(state.date)} · ${fmtClock(state.minute)}</div>${now}</div></div>
        <div class="day-facts">
            ${sunriseSunsetText()}
            <div>Sun at your position: <strong>${intervalsText(intervals)}</strong></div>
            <div>Total: <strong>${fmtDur(totalHours(intervals))}</strong> of sun this day</div>
            ${intervals.some(iv => iv.filtered) ? `<div class="muted small-text">* through bare trees</div>` : ""}
        </div>`;
}

function renderMonthInfo() {
    const { intervals, monthAvg } = dayCache;
    $("sunInfo").innerHTML = `<div class="facts">
        <div class="big">${MONTHS[state.month - 1]} ${state.monthYear}</div>
        <div class="muted">Sun's path on 15/${pad2(state.month)}/${state.monthYear}</div>
        ${sunriseSunsetText()}
        <div>Sun at your position on the 15th: <strong>${intervalsText(intervals)}</strong> (${fmtDur(totalHours(intervals))})</div>
        <div>Average over the whole month: <strong>${fmtDur(monthAvg)}</strong> of sun per day</div>
        ${intervals.some(iv => iv.filtered) ? `<div class="muted small-text">* through bare trees</div>` : ""}
    </div>`;
}

function renderLegend() {
    const items = [
        [COLORS.sun, "Sun is above this part of the tree line and reaches you"],
        [COLORS.shade, "Sun is behind this part of the tree line — you are in shade"]
    ];
    if (dayCache?.day.leafless) items.splice(1, 0, [COLORS.filtered, "Sun shines through bare trees"]);
    $("legend").innerHTML = items.map(([c, label]) =>
        `<div class="legend-item"><i class="swatch bar" style="background:${c}"></i>${label}</div>`).join("") +
        `<div class="legend-item"><span class="hour-mark inline">14</span>Where the sun stands at that hour (hover for details)</div>`;
}

/* ================================================================
   Controls
   ================================================================ */

const $ = id => document.getElementById(id);

function setMode(mode) {
    state.mode = mode;
    stopPlay();
    save();
    renderAll();
}

function syncInputs() {
    document.querySelectorAll(".seg button").forEach(b => {
        const active = b.dataset.mode === state.mode;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", active);
    });
    $("daySection").hidden = state.mode !== "day";
    $("monthSection").hidden = state.mode !== "month";

    if (document.activeElement !== $("dateInput")) $("dateInput").value = fmtDate(state.date);
    $("dateInput").classList.remove("invalid");
    const { y } = civil(state.date);
    $("daySlider").max = daysInYear(y);
    $("daySlider").value = dayOfYear(state.date);
    $("timeSlider").value = state.minute;
    $("timeOut").textContent = fmtClock(state.minute);
    $("speed").value = String(state.speed);

    $("monthYear").value = state.monthYear;
    document.querySelectorAll("#monthButtons button").forEach(b => {
        b.classList.toggle("active", Number(b.dataset.month) === state.month);
    });

    $("treeHeight").value = state.treeHeight;
    $("crown").value = state.crown;
    $("treeType").value = state.treeType;
    $("deciduousOpts").hidden = state.treeType !== "deciduous";
    if (document.activeElement !== $("leafOut")) $("leafOut").value = fmtDayMonth(state.leafOut);
    if (document.activeElement !== $("leafFall")) $("leafFall").value = fmtDayMonth(state.leafFall);
    if (document.activeElement !== $("tz")) $("tz").value = state.tz;
    $("gardenName").textContent = garden && geom ? `${garden.name} · ${(geom.area / 10000).toFixed(2)} ha` : "";
}

/** Garden sides or tree settings changed: rebuild the geometry and redraw. */
function geometryChanged() {
    save();
    geom = makeGeometry();
    drawEdges();
    renderAll();
}

function setDate(dateMs) {
    state.date = dateMs;
    renderAll();
}

document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => setMode(b.dataset.mode)));

$("dateInput").addEventListener("change", e => {
    const d = parseDate(e.target.value);
    if (d === null) {
        e.target.classList.add("invalid");
        return;
    }
    setDate(d);
});
$("dateInput").addEventListener("keydown", e => {
    if (e.key === "Enter") e.target.dispatchEvent(new Event("change"));
});
$("prevDay").addEventListener("click", () => setDate(state.date - DAY_MS));
$("nextDay").addEventListener("click", () => setDate(state.date + DAY_MS));
$("todayBtn").addEventListener("click", () => setDate(todayDate()));
$("daySlider").addEventListener("input", e => {
    const { y } = civil(state.date);
    setDate(makeDate(y, 1, 1) + (Number(e.target.value) - 1) * DAY_MS);
});

$("timeSlider").addEventListener("input", e => {
    state.minute = Number(e.target.value);
    render();
});

$("speed").addEventListener("change", e => {
    state.speed = Number(e.target.value);
    save();
});

let playTimer = null;
function stopPlay() {
    clearInterval(playTimer);
    playTimer = null;
    $("playBtn").textContent = "▶ Play";
}

$("playBtn").addEventListener("click", () => {
    if (playTimer) return stopPlay();
    $("playBtn").textContent = "❚❚ Pause";
    const { rise, set } = dayCache?.times ?? {};
    if (rise != null && (state.minute < rise || state.minute >= set)) state.minute = rise;
    playTimer = setInterval(() => {
        const times = dayCache?.times;
        let m = state.minute + state.speed;
        if (times?.rise != null && times.set != null && (m > times.set || m < times.rise)) m = times.rise;
        state.minute = m % 1440;
        render();
    }, 100);
});

MONTHS.forEach((name, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.month = i + 1;
    b.textContent = name.slice(0, 3);
    b.title = name;
    b.addEventListener("click", () => {
        state.month = i + 1;
        save();
        renderAll();
    });
    $("monthButtons").appendChild(b);
});

$("monthYear").addEventListener("change", e => {
    const y = parseInt(e.target.value, 10);
    if (y >= 1900 && y <= 2200) state.monthYear = y;
    renderAll();
});

function numberSetting(id, key, min, max) {
    $(id).addEventListener("change", e => {
        const v = parseFloat(e.target.value);
        if (isFinite(v)) state[key] = clamp(v, min, max);
        geometryChanged();
    });
}
numberSetting("treeHeight", "treeHeight", 1, 80);
numberSetting("crown", "crown", 0, 20);

$("treeType").addEventListener("change", e => {
    state.treeType = e.target.value;
    save();
    renderAll();
});

for (const key of ["leafOut", "leafFall"]) {
    $(key).addEventListener("change", e => {
        const v = parseDayMonth(e.target.value);
        if (!v) {
            e.target.classList.add("invalid");
            return;
        }
        e.target.classList.remove("invalid");
        state[key] = v;
        save();
        renderAll();
    });
}

$("tz").addEventListener("change", e => {
    const tz = e.target.value.trim();
    if (!Solar.isValidTimeZone(tz)) {
        alert(`"${tz}" is not a known time zone. Use a name like Europe/Brussels.`);
        e.target.value = state.tz;
        return;
    }
    state.tz = tz;
    save();
    renderAll();
});

$("clearPos").addEventListener("click", clearPosition);

$("resetBtn").addEventListener("click", () => {
    if (!confirm("Reset all settings and the garden outline to the defaults?")) return;
    localStorage.removeItem(STORAGE_KEY);
    stopPlay();
    state = { ...DEFAULTS, date: state.date, minute: state.minute, monthYear: state.monthYear };
    setGarden(gardenFromGeoJSON(DEFAULT_GARDEN_GEOJSON));
});

/* Loading a GeoJSON file */

async function loadFile(file) {
    try {
        const g = gardenFromGeoJSON(JSON.parse(await file.text()), file.name.replace(/\.(geo)?json$/i, ""));
        state.position = null;
        setGarden(g);
    } catch (err) {
        alert(`Could not read ${file.name}: ${err.message}`);
    }
}

$("fileInput").addEventListener("change", e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
    e.target.value = "";
});

document.addEventListener("dragover", e => {
    e.preventDefault();
    document.body.classList.add("dragging");
});
document.addEventListener("dragleave", e => {
    if (!e.relatedTarget) document.body.classList.remove("dragging");
});
document.addEventListener("drop", e => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
});

function setGarden(g) {
    garden = g;
    geom = makeGeometry();
    save();
    map.fitBounds(L.latLngBounds(g.ring.map(([lon, lat]) => [lat, lon])), { padding: [40, 40] });
    drawEdges();

    // Restore a saved position if it is still inside the garden
    posMarker?.remove();
    posMarker = null;
    const p = state.position;
    if (p && pointInPolygon(...geom.proj.fwd(p.lng, p.lat), geom.pts)) {
        setPosition(p.lat, p.lng);
    } else {
        state.position = null;
        renderAll();
    }
}

/* ================================================================
   Start
   ================================================================ */

loadSaved();
if (!Solar.isValidTimeZone(state.tz)) state.tz = DEFAULT_TIME_ZONE;
setGarden(garden || gardenFromGeoJSON(DEFAULT_GARDEN_GEOJSON));
