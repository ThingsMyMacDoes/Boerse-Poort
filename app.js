"use strict";

/* ================================================================
   Constants
   ================================================================ */

const STORAGE_KEY = "garden-sun-direction-v1";
const PATH_STEP_MIN = 2;       // sampling step for a single day
const AVERAGE_STEP_MIN = 5;    // sampling step for monthly averages
const RAD = Math.PI / 180;

const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

const COLORS = {
    sun: "#ffd43b",          // the sun's path along the garden outline
    outline: "#f1f3f5",
    casing: "#1d1d1b"
};

// Heat scale for the plot outline: dark blue (no sun from this direction) → yellow → red (strongest sun).
const HEAT = [
    [0.00, [29, 58, 110]],
    [0.25, [96, 112, 140]],
    [0.55, [254, 224, 76]],
    [0.78, [247, 140, 30]],
    [1.00, [214, 40, 40]]
];

function ramp(t) {
    t = Math.min(1, Math.max(0, t));
    for (let i = 1; i < HEAT.length; i++) {
        const [t1, c1] = HEAT[i];
        if (t <= t1) {
            const [t0, c0] = HEAT[i - 1];
            const f = (t - t0) / (t1 - t0);
            const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
            return `rgb(${c[0]},${c[1]},${c[2]})`;
        }
    }
    const c = HEAT[HEAT.length - 1][1];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ================================================================
   Date helpers — a date is the UTC timestamp of its midnight
   ================================================================ */

const DAY_MS = 864e5;
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
    tz: DEFAULT_TIME_ZONE,
    speed: 5,
    fixedScale: false,
    plot: null               // 4 corners [{ lat, lng }, ...]
};

let state = { ...DEFAULTS, date: todayDate(), minute: 12 * 60, monthYear: new Date().getFullYear() };
let garden = null;           // { name, ring: [[lon, lat]...] }
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
    return { name: found.props?.name || fallbackName || "Garden", ring };
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

/** Sides of a polygon as segments { i, ax, ay, bx, by }. */
function segments(pts) {
    return pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length];
        return { i, ax: a[0], ay: a[1], bx: b[0], by: b[1] };
    });
}

function polygonArea(pts) {
    let area = 0;
    pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        area += a[0] * b[1] - b[0] * a[1];
    });
    return area / 2;
}

function makeGeometry() {
    const proj = makeProjection(garden.ring);
    const pts = garden.ring.map(([lon, lat]) => proj.fwd(lon, lat));
    return { proj, pts, edges: segments(pts), area: Math.abs(polygonArea(pts)) };
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

/** True if (x, y) is inside the garden or within 1 m of its outline. */
function insideGarden(x, y) {
    return pointInPolygon(x, y, geom.pts) || geom.edges.some(e => distToSegment(x, y, e) < 1);
}

/** Intersection of the ray from (px, py) in direction (dx, dy) with a segment: distance t along the ray. */
function intersect(px, py, dx, dy, e) {
    const ex = e.bx - e.ax, ey = e.by - e.ay;
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-12) return null;
    const wx = e.ax - px, wy = e.ay - py;
    const t = (wx * ey - wy * ex) / den;
    const s = (wx * dy - wy * dx) / den;
    return t > 0 && s >= 0 && s <= 1 ? t : null;
}

/** First point where a ray from (x, y) towards azimuth `az` meets one of the segments. */
function rayHit(x, y, az, segs) {
    const dx = Math.sin(az * RAD), dy = Math.cos(az * RAD);
    let best = null;
    for (const e of segs) {
        const t = intersect(x, y, dx, dy, e);
        if (t !== null && (!best || t < best.t)) best = { edge: e.i, t, x: x + t * dx, y: y + t * dy };
    }
    return best;
}

/* ================================================================
   Sun
   ================================================================ */

/**
 * Clear-sky direct sunlight falling on level ground, in kW/m², for a sun elevation in degrees.
 * A low sun shines through more atmosphere (air mass, Kasten–Young) and hits the ground at a
 * shallower angle (sine of the elevation), so it delivers much less energy than a high sun.
 */
function sunStrength(elevation) {
    if (elevation <= 0) return 0;
    const sinE = Math.sin(elevation * RAD);
    const airMass = 1 / (sinE + 0.50572 * Math.pow(elevation + 6.07995, -1.6364));
    const direct = 1.361 * Math.pow(0.7, Math.pow(airMass, 0.678));     // Meinel model, kW/m² facing the sun
    return direct * sinE;
}

function utcFor(dateMs, minute) {
    // UTC offset at local noon of that day (summer/winter time)
    const offset = Solar.tzOffsetMin(dateMs + 12 * 3600000, state.tz);
    return dateMs + (minute - offset) * 60000;
}

function sunAt(dateMs, minute) {
    return Solar.position(utcFor(dateMs, minute), geom.proj.lat0, geom.proj.lon0);
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

const sunSampleCache = new Map();

/** The sun every `step` minutes of a day while it is above the horizon. */
function daySunSamples(dateMs, step) {
    const key = `${dateMs}|${step}|${state.tz}|${geom.proj.lat0}|${geom.proj.lon0}`;
    let samples = sunSampleCache.get(key);
    if (!samples) {
        samples = [];
        for (let m = 0; m < 1440; m += step) {
            const p = sunAt(dateMs, m);
            if (p.elevation > 0) {
                samples.push({ minute: m, az: p.azimuth, el: p.elevation, strength: sunStrength(p.elevation) });
            }
        }
        if (sunSampleCache.size > 500) sunSampleCache.clear();
        sunSampleCache.set(key, samples);
    }
    return samples;
}

function datesOfMonth(y, m) {
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return Array.from({ length: days }, (_, i) => makeDate(y, m, i + 1));
}

/**
 * Sun energy per day (kWh/m², averaged over the dates) by the compass direction it comes from, in 1° bins.
 * `facing[θ]` is how much sun a side facing direction θ gets: every moment's sun counts with the cosine
 * of the angle between θ and the sun's direction (fully when straight ahead, not at all from the side
 * or behind). High midday sun is strongest, so the direction it comes from gets the most.
 */
function sunByDirection(dates, step) {
    const bins = new Float64Array(360);
    let daylight = 0;
    for (const dateMs of dates) {
        const samples = daySunSamples(dateMs, step);
        daylight += samples.length;
        for (const s of samples) bins[Math.floor(s.az) % 360] += s.strength;
    }
    const k = step / 60 / dates.length;
    for (let i = 0; i < 360; i++) bins[i] *= k;
    return { raw: bins, facing: cosineSpread(bins), daylight: daylight * k };
}

function cosineSpread(bins) {
    const out = new Float64Array(360);
    for (let theta = 0; theta < 360; theta++) {
        let v = 0;
        for (let i = 0; i < 360; i++) {
            if (!bins[i]) continue;
            const c = Math.cos((i + 0.5 - theta - 0.5) * RAD);
            if (c > 0) v += bins[i] * c;
        }
        out[theta] = v;
    }
    return out;
}

/** Value of a 360-bin array at an azimuth, linearly interpolated (bin i covers i…i+1°). */
function atAzimuth(bins, az) {
    const a = ((az - 0.5) % 360 + 360) % 360;
    const i = Math.floor(a), f = a - i;
    return bins[i] * (1 - f) + bins[(i + 1) % 360] * f;
}

const peakCache = new Map();

/** Strongest direction on the longest day of the year: the red end of the fixed colour scale. */
function peakDirectionalSun(year) {
    const key = `${year}|${state.tz}|${geom.proj.lat0}|${geom.proj.lon0}`;
    if (!peakCache.has(key)) {
        peakCache.set(key, Math.max(...sunByDirection([makeDate(year, 6, 21)], PATH_STEP_MIN).facing));
    }
    return peakCache.get(key);
}

/* ================================================================
   Your plot
   ================================================================ */

/** Orders corners around their centre so the 4 clicks always form a simple (non-crossing) shape. */
function sortCorners(corners) {
    const cLat = corners.reduce((s, c) => s + c.lat, 0) / corners.length;
    const cLng = corners.reduce((s, c) => s + c.lng, 0) / corners.length;
    return [...corners].sort((a, b) => Math.atan2(a.lat - cLat, a.lng - cLng) - Math.atan2(b.lat - cLat, b.lng - cLng));
}

/** The plot in metres: corners, centre, sides, and evenly spaced outline points with their bearing from the centre. */
function makePlotGeometry(corners) {
    const pts = corners.map(c => geom.proj.fwd(c.lng, c.lat));
    const area = polygonArea(pts);
    let cx = 0, cy = 0, perimeter = 0;
    pts.forEach((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const cross = a[0] * b[1] - b[0] * a[1];
        cx += (a[0] + b[0]) * cross;
        cy += (a[1] + b[1]) * cross;
        perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    });
    const centre = Math.abs(area) > 1e-6
        ? [cx / (6 * area), cy / (6 * area)]
        : [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

    const spacing = clamp(perimeter / 160, 0.1, 3);
    const outline = [];
    const sides = pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const n = Math.max(6, Math.ceil(len / spacing));
        for (let k = 0; k < n; k++) {
            const x = a[0] + (b[0] - a[0]) * k / n, y = a[1] + (b[1] - a[1]) * k / n;
            const bearing = (Math.atan2(x - centre[0], y - centre[1]) / RAD + 360) % 360;
            const [lat, lng] = geom.proj.inv(x, y);
            outline.push({ lat, lng, bearing });
        }
        const mx = (a[0] + b[0]) / 2 - centre[0], my = (a[1] + b[1]) / 2 - centre[1];
        return { length: len, facing: (Math.atan2(mx, my) / RAD + 360) % 360 };
    });
    const [lat, lng] = geom.proj.inv(centre[0], centre[1]);
    return {
        pts, sides, outline,
        segs: segments(pts),
        centre: { x: centre[0], y: centre[1], lat, lng },
        area: Math.abs(area)
    };
}

/** Share of the sun energy coming over each plot side (seen from the centre), from the energy per direction. */
function sideShares(plot, raw) {
    const shares = plot.sides.map(() => 0);
    let total = 0;
    for (let i = 0; i < 360; i++) {
        if (!raw[i]) continue;
        const hit = rayHit(plot.centre.x, plot.centre.y, i + 0.5, plot.segs);
        if (hit) shares[hit.edge] += raw[i];
        total += raw[i];
    }
    return shares.map(s => (total ? s / total : 0));
}

/** For a single day: the time windows in which the sun stands over each plot side. */
function sideTimes(plot, samples, step) {
    const windows = plot.sides.map(() => []);
    for (const s of samples) {
        const hit = rayHit(plot.centre.x, plot.centre.y, s.az, plot.segs);
        if (!hit) continue;
        const list = windows[hit.edge];
        const last = list[list.length - 1];
        if (last && s.minute - last.end <= step) last.end = s.minute + step;
        else list.push({ start: s.minute, end: s.minute + step });
    }
    return windows;
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

const outlineLayer = L.layerGroup().addTo(map);  // garden outline
const pathLayer = L.layerGroup().addTo(map);     // the sun's path along the garden outline
const nowLayer = L.layerGroup().addTo(map);      // current sun position (day playback)
const plotLayer = L.layerGroup().addTo(map);     // your plot, outline coloured by sun direction
const drawLayer = L.layerGroup().addTo(map);     // plot being drawn

const toLatLng = (x, y) => geom.proj.inv(x, y);

function drawGardenOutline() {
    outlineLayer.clearLayers();
    L.polygon(garden.ring.map(([lon, lat]) => [lat, lon]), {
        color: COLORS.outline, weight: 3, opacity: 0.9, fill: false, interactive: false
    }).addTo(outlineLayer);
}

/**
 * Turns the samples' hits on the garden outline into polylines that follow it.
 * Consecutive hits on neighbouring sides are joined through their shared corner;
 * jumps to a non-neighbouring side (a corner hiding part of the outline) start a new line.
 */
function outlineLines(samples) {
    const n = geom.edges.length;
    const lines = [];
    let line = null, prev = null;
    for (const s of samples) {
        if (!s.hit) { prev = null; continue; }
        const point = toLatLng(s.hit.x, s.hit.y);
        let bridge = [];
        let connected = prev !== null;
        if (connected && prev.hit.edge !== s.hit.edge) {
            const a = prev.hit.edge, b = s.hit.edge;
            const corner = b === (a + 1) % n ? b : a === (b + 1) % n ? a : null;
            if (corner === null) connected = false;
            else bridge = [toLatLng(...geom.pts[corner])];
        }
        if (connected) line.push(...bridge, point);
        else lines.push(line = [point]);
        prev = s;
    }
    return lines;
}

function drawPath(samples) {
    pathLayer.clearLayers();
    const lines = outlineLines(samples);
    // Dark casing first so the colour stands out on the satellite image
    L.polyline(lines, { color: COLORS.casing, weight: 13, opacity: 0.55, interactive: false, lineCap: "butt" }).addTo(pathLayer);
    L.polyline(lines, { color: COLORS.sun, weight: 9, opacity: 1, interactive: false, lineCap: "butt" }).addTo(pathLayer);

    // Hour marks along the outline
    for (const s of samples) {
        if (s.minute % 60 !== 0 || !s.hit) continue;
        const icon = L.divIcon({
            className: "",
            html: `<div class="hour-mark">${s.minute / 60}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11]
        });
        L.marker(toLatLng(s.hit.x, s.hit.y), { icon, keyboard: false })
            .on("click", e => { if (drawing) addCorner(e.latlng); })
            .bindTooltip(`<strong>${fmtClock(s.minute)}</strong> · sun in the ${compassName(s.az)} (${Math.round(s.az)}°), ${s.el.toFixed(0)}° high`)
            .addTo(pathLayer);
    }
}

let sunMarker = null;       // the sun on the garden outline (day view); draggable while paused
let sunRay = null;          // line from the middle of the plot to the sun
let draggingSun = false;

function hideSun() {
    nowLayer.clearLayers();
    sunMarker = null;
    sunRay = null;
    draggingSun = false;
}

function drawNow(centre, sunPos) {
    const hit = sunPos.elevation > 0 ? rayHit(centre.x, centre.y, sunPos.azimuth, geom.edges) : null;
    if (!hit) {
        hideSun();
        return;
    }
    const to = toLatLng(hit.x, hit.y);
    if (!sunRay) {
        sunRay = L.polyline([], { color: COLORS.sun, weight: 3, opacity: 0.95, interactive: false }).addTo(nowLayer);
    }
    sunRay.setLatLngs([[centre.lat, centre.lng], to]);

    if (!sunMarker) {
        sunMarker = L.marker(to, {
            draggable: true,
            keyboard: false,
            zIndexOffset: 1000,
            icon: L.divIcon({ className: "", html: '<div class="sun-now"></div>', iconSize: [30, 30], iconAnchor: [15, 15] })
        }).addTo(nowLayer);
        sunMarker.bindTooltip("Drag the sun along the outline to change the time");
        sunMarker.on("dragstart", () => { draggingSun = true; });
        sunMarker.on("drag", () => {
            // the time of day at which the sun stands in the direction of the dragged position
            const ll = sunMarker.getLatLng();
            const [x, y] = geom.proj.fwd(ll.lng, ll.lat);
            const c = dayCache.plot.centre;
            const az = (Math.atan2(x - c.x, y - c.y) / RAD + 360) % 360;
            const minute = minuteForAzimuth(az);
            if (minute !== null && minute !== state.minute) {
                state.minute = minute;
                render();
            }
        });
        sunMarker.on("dragend", () => {
            draggingSun = false;
            render();       // snap the sun back onto its path
        });
    } else if (!draggingSun) {
        sunMarker.setLatLng(to);
    }
    // dragging is only possible while playback is paused
    if (playTimer) sunMarker.dragging.disable();
    else sunMarker.dragging.enable();
    sunMarker.getElement()?.classList.toggle("draggable-sun", !playTimer);
}

/** The minute of the shown day at which the sun's direction is closest to `az`. */
function minuteForAzimuth(az) {
    let best = null, bestDiff = Infinity;
    for (const s of daySunSamples(state.date, 1)) {
        const diff = Math.abs(((s.az - az + 540) % 360) - 180);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = s.minute;
        }
    }
    return best;
}

/* ================================================================
   Drawing and editing your plot
   ================================================================ */

let drawing = null;            // { corners: [{ lat, lng }] } while the corners are being clicked
let flashText = null;

function flash(message) {
    flashText = message;
    updatePlotUI();
    setTimeout(() => {
        flashText = null;
        updatePlotUI();
    }, 2500);
}

function startDrawing() {
    stopPlay();
    drawing = { corners: [] };
    map.getContainer().classList.add("drawing");
    renderAll();
}

function endDrawing() {
    drawing = null;
    drawLayer.clearLayers();
    map.getContainer().classList.remove("drawing");
}

function cancelDrawing() {
    endDrawing();
    renderAll();
}

function addCorner(latlng) {
    const [x, y] = geom.proj.fwd(latlng.lng, latlng.lat);
    if (!insideGarden(x, y)) {
        flash("Please click inside the garden.");
        return;
    }
    drawing.corners.push({ lat: latlng.lat, lng: latlng.lng });
    if (drawing.corners.length === 4) {
        const corners = sortCorners(drawing.corners);
        endDrawing();
        setPlot(corners);
    } else {
        drawDrawing(latlng);
        updatePlotUI();
    }
}

function drawDrawing(cursor) {
    drawLayer.clearLayers();
    const pts = drawing.corners.map(c => [c.lat, c.lng]);
    if (cursor && pts.length) pts.push([cursor.lat, cursor.lng]);
    if (pts.length >= 2) {
        L.polyline(pts, { color: "#ffffff", weight: 3, dashArray: "6 6", interactive: false }).addTo(drawLayer);
    }
    drawing.corners.forEach(c => L.circleMarker([c.lat, c.lng], {
        radius: 6, color: COLORS.casing, weight: 2, fillColor: "#ffffff", fillOpacity: 1, interactive: false
    }).addTo(drawLayer));
}

map.on("mousemove", e => {
    if (drawing) drawDrawing(e.latlng);
});

map.on("click", e => {
    if (drawing) addCorner(e.latlng);
});

document.addEventListener("keydown", e => {
    if (e.key === "Escape" && drawing) cancelDrawing();
});

function setPlot(corners) {
    state.plot = corners;
    save();
    renderAll();
}

function clearPlot() {
    state.plot = null;
    save();
    renderAll();
}

function updatePlotUI() {
    const hasPlot = !!state.plot;
    $("drawBtn").textContent = drawing ? "Cancel drawing" : hasPlot ? "✎ Redraw my plot" : "✎ Draw my plot";
    $("clearPlot").hidden = !hasPlot || !!drawing;
    const hint = $("plotHint");
    hint.hidden = hasPlot && !drawing && !flashText;
    hint.classList.toggle("warn", !!flashText);
    hint.textContent = flashText
        || (drawing ? `Click corner ${drawing.corners.length + 1} of 4 of your plot on the map (Esc to cancel).`
            : "Click “Draw my plot”, then click the 4 corners of your plot on the map.");
}

/* ================================================================
   Rendering
   ================================================================ */

let dayCache = null;   // results for the shown day/month; recomputed only when date or plot change

function shownDate() {
    return state.mode === "day" ? state.date : makeDate(state.monthYear, state.month, 15);
}

/** Recomputes everything (date or plot change) and redraws. */
function renderAll() {
    dayCache = null;
    render();
}

function render() {
    syncInputs();
    updatePlotUI();
    if (!state.plot || drawing || !geom) {
        pathLayer.clearLayers();
        hideSun();
        plotLayer.clearLayers();
        $("plotSection").hidden = true;
        $("sunInfo").innerHTML = `<p class="muted">Draw your plot to see where the sun comes from.</p>`;
        $("legend").innerHTML = "";
        return;
    }

    if (!dayCache) {
        const plot = makePlotGeometry(state.plot);
        const dateMs = shownDate();
        const samples = daySunSamples(dateMs, PATH_STEP_MIN).map(s => ({
            ...s,
            hit: rayHit(plot.centre.x, plot.centre.y, s.az, geom.edges)
        }));
        const dates = state.mode === "day" ? [state.date] : datesOfMonth(state.monthYear, state.month);
        const direction = sunByDirection(dates, state.mode === "day" ? PATH_STEP_MIN : AVERAGE_STEP_MIN);
        dayCache = {
            plot, samples, direction,
            times: sunTimes(dateMs),
            shares: sideShares(plot, direction.raw),
            sideTimes: sideTimes(plot, samples, PATH_STEP_MIN),
            peak: peakDirectionalSun(civil(dates[0]).y)
        };
        drawPath(samples);
        drawPlot();
    }

    if (state.mode === "day") {
        const sunPos = sunAt(state.date, state.minute);
        drawNow(dayCache.plot.centre, sunPos);
        renderDayInfo(sunPos);
    } else {
        hideSun();
        renderMonthInfo();
    }
    renderLegend();
}

/** Colour range: 0 up to the plot's strongest direction, or (fixed) up to the strongest direction at midsummer. */
function plotScale() {
    const max = Math.max(...dayCache.direction.facing);
    return { hi: Math.max(state.fixedScale ? dayCache.peak : max, 1e-6) };
}

function drawPlot() {
    plotLayer.clearLayers();
    const { plot, direction } = dayCache;
    const { hi } = plotScale();
    const ll = plot.outline.map(p => [p.lat, p.lng]);
    const n = ll.length;

    L.polygon(ll, { color: COLORS.casing, weight: 13, opacity: 0.6, fill: false, interactive: false }).addTo(plotLayer);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const v = (atAzimuth(direction.facing, plot.outline[i].bearing) + atAzimuth(direction.facing, plot.outline[j].bearing)) / 2;
        L.polyline([ll[i], ll[j]], { color: ramp(v / hi), weight: 8, opacity: 1, lineCap: "round", interactive: false }).addTo(plotLayer);
    }
    L.circleMarker([plot.centre.lat, plot.centre.lng], {
        radius: 5, color: "#ffffff", weight: 2, fillColor: "#e8590c", fillOpacity: 1
    }).bindTooltip("Middle of your plot: directions are seen from here").addTo(plotLayer);
    renderPlotInfo();
}

function windowsText(list) {
    return list.length ? list.map(w => `${fmtClock(w.start)} – ${fmtClock(w.end)}`).join(", ") : "—";
}

function renderPlotInfo() {
    const { plot, shares, sideTimes: times } = dayCache;
    $("plotSection").hidden = false;
    $("plotTitle").textContent = state.mode === "day"
        ? `Where your plot's sun comes from on ${fmtDate(state.date)}`
        : `Where your plot's sun comes from in ${MONTHS[state.month - 1]} ${state.monthYear}`;

    const stops = Array.from({ length: 11 }, (_, i) => `${ramp(i / 10)} ${i * 10}%`).join(",");
    const timeHeader = state.mode === "day" ? "Sun over this side" : "Sun over this side on the 15th";
    const rows = plot.sides.map((side, i) => `
        <tr><td>${compassName(side.facing)} side</td><td class="num">${Math.round(side.length)} m</td>
        <td class="num">${Math.round(shares[i] * 100)}%</td><td class="num">${windowsText(times[i])}</td></tr>`).join("");

    $("plotSun").innerHTML = `
        <div class="gradient" style="background:linear-gradient(to right,${stops})"></div>
        <div class="gradient-ticks"><span>no sun from this direction</span>
            <span>${state.fixedScale ? "strongest sun at midsummer" : "strongest sun"}</span></div>
        <p class="small-text">The outline of your plot shows from which direction the sun's energy comes, seen from its
        middle. High midday sun counts much more than low morning or evening sun.</p>
        <table class="side-table">
            <thead><tr><th>Side</th><th class="num">Length</th><th class="num">Share of the sun</th><th class="num">${timeHeader}</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="muted small-text">Plot ≈ ${Math.round(plot.area)} m².</p>`;
}

function sunriseSunsetText() {
    const { rise, set } = dayCache.times;
    const s = dayCache.samples;
    if (rise === null || set === null || !s.length) return "";
    return `<div>Sunrise <strong>${fmtClock(rise)}</strong> in the ${compassName(s[0].az)} · sunset <strong>${fmtClock(set)}</strong> in the ${compassName(s[s.length - 1].az)}</div>
        <div>Daylight <strong>${fmtDur((set - rise) / 60)}</strong></div>`;
}

function highestSunText() {
    const s = dayCache.samples;
    if (!s.length) return "";
    const top = s.reduce((a, b) => (b.el > a.el ? b : a));
    return `<div>Highest at <strong>${fmtClock(top.minute)}</strong>: ${top.el.toFixed(0)}° above the horizon in the ${compassName(top.az)}</div>`;
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

function renderDayInfo(sunPos) {
    const now = sunPos.elevation <= 0
        ? `<div>The sun is below the horizon.</div>`
        : `<div>Sun in the <strong>${compassName(sunPos.azimuth)}</strong> (${Math.round(sunPos.azimuth)}°), <strong>${sunPos.elevation.toFixed(1)}°</strong> above the horizon</div>`;
    $("sunInfo").innerHTML = `<div class="now">${compassSvg(sunPos.azimuth, sunPos.elevation)}<div class="facts">
            <div class="big">${fmtDate(state.date)} · ${fmtClock(state.minute)}</div>${now}</div></div>
        <div class="day-facts">${sunriseSunsetText()}${highestSunText()}</div>`;
}

function renderMonthInfo() {
    $("sunInfo").innerHTML = `<div class="facts">
        <div class="big">${MONTHS[state.month - 1]} ${state.monthYear}</div>
        <div class="muted">Sun's path on 15/${pad2(state.month)}/${state.monthYear}, seen from the middle of your plot</div>
        ${sunriseSunsetText()}${highestSunText()}
        <div>Average daylight over the month: <strong>${fmtDur(dayCache.direction.daylight)}</strong></div>
    </div>`;
}

function renderLegend() {
    $("legend").innerHTML = `
        <div class="legend-item"><i class="swatch bar" style="background:${COLORS.sun}"></i>The sun's path along the garden outline, seen from the middle of your plot</div>
        <div class="legend-item"><span class="hour-mark inline">14</span>Where the sun stands at that hour (hover for details)</div>`;
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
    $("fixedScale").checked = state.fixedScale;

    $("monthYear").value = state.monthYear;
    document.querySelectorAll("#monthButtons button").forEach(b => {
        b.classList.toggle("active", Number(b.dataset.month) === state.month);
    });

    if (document.activeElement !== $("tz")) $("tz").value = state.tz;
    $("gardenName").textContent = garden && geom ? `${garden.name} · ${(geom.area / 10000).toFixed(2)} ha` : "";
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
    if (dayCache && state.mode === "day") render();
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

$("drawBtn").addEventListener("click", () => (drawing ? cancelDrawing() : startDrawing()));
$("clearPlot").addEventListener("click", clearPlot);
$("fixedScale").addEventListener("change", e => {
    state.fixedScale = e.target.checked;
    save();
    if (dayCache) drawPlot();
});

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
        state.plot = null;
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
    drawGardenOutline();

    // Keep a saved plot only if it still lies inside the garden
    if (drawing) endDrawing();
    if (state.plot && !state.plot.every(c => insideGarden(...geom.proj.fwd(c.lng, c.lat)))) state.plot = null;
    renderAll();
}

/* ================================================================
   Start
   ================================================================ */

loadSaved();
if (!Solar.isValidTimeZone(state.tz)) state.tz = DEFAULT_TIME_ZONE;
setGarden(garden || gardenFromGeoJSON(DEFAULT_GARDEN_GEOJSON));
