import { AREAS, CAFES, FREE_NOTES, SPOTS } from "./data";
import type { Area, LatLng, Parking, Spot } from "./data";
import { locate } from "./geocode";
import type { Place } from "./geocode";
import { enc, getJSON } from "./http";
import { clock, transitTrip, tripSteps } from "./transit";
import type { Trip } from "./transit";

// Leaflet is loaded from the CDN as the global `L` (see coffee-midpoint.html).

type Mode = "drive" | "transit" | "bike" | "walk";
type Strategy = "balanced" | "fair" | "fast";

interface Candidate {
  name: string;
  where: string;
  p: LatLng;
  park: Parking;
  known?: boolean;
  strip?: boolean;
  spot?: Spot;
}
/**
 * tripA/tripB: the public transport trip for that person, if they're on transit.
 * undefined = not looked up (or the planner was unreachable), so tA/tB is an estimate;
 * null = the planner found no trip.
 */
interface Result { c: Candidate; tA: number; tB: number; sc: number; tripA?: Trip | null; tripB?: Trip | null }
interface RoadTimes { min: number[]; km: number[] }
/** A route drawn on the map: one part per walk/ride, or a single part for car/bike/walk. */
interface Route { parts: { line: LatLng[]; dashed: boolean; label?: string }[] }

/** Minutes used for "no public transport trip": ranks last without breaking the maths. */
const NO_TRIP = 24 * 60;
/** How many shortlisted spots get real public transport times (2 requests each if both use transit). */
const TRANSIT_SHORTLIST = 8;
interface OsmElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}
interface Lot { lat: number; lon: number; t: Record<string, string>; d: number }

const PARK: Record<Parking, { min: number; peak: number; label: string }> = {
  easy: { min: 3, peak: 4, label: "easy parking" },
  medium: { min: 6, peak: 9, label: "some parking" },
  hard: { min: 11, peak: 16, label: "hard parking" },
};
const MODES: Record<Mode, { f: number; v: number; vPeak: number; add: number; gm: string; osrm: string }> = {
  drive: { f: 1.35, v: 32, vPeak: 22, add: 0, gm: "driving", osrm: "https://router.project-osrm.org/table/v1/driving/" },
  transit: { f: 1.4, v: 20, vPeak: 19, add: 12, gm: "transit", osrm: "https://router.project-osrm.org/table/v1/driving/" },
  bike: { f: 1.3, v: 16, vPeak: 16, add: 1, gm: "bicycling", osrm: "https://routing.openstreetmap.de/routed-bike/table/v1/driving/" },
  walk: { f: 1.25, v: 4.8, vPeak: 4.8, add: 0, gm: "walking", osrm: "https://routing.openstreetmap.de/routed-foot/table/v1/driving/" },
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const select_ = (id: string) => $<HTMLSelectElement>(id);

$("area").innerHTML = '<option value="">Anywhere</option>' +
  AREAS.map((a, i) => `<option value="${i}"${i === 0 ? " selected" : ""}>${a.name}</option>`).join("");

function km(a: LatLng, b: LatLng): number {
  const R = 6371, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inArea(p: LatLng, a: Area): boolean {
  if ("bbox" in a) { const [s, w, n, e] = a.bbox; return p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e; }
  return km(p, a.c) * 1000 <= a.r;
}
function nearestPark(p: LatLng): Parking {
  let best = SPOTS[0];
  for (const s of SPOTS) if (km(p, [s[2], s[3]]) < km(p, [best[2], best[3]])) best = s;
  return best[4];
}
function parkMin(mode: Mode, park: Parking, peak: boolean): number {
  return mode === "drive" ? PARK[park][peak ? "peak" : "min"] : 0;
}
function estimate(d: number, mode: Mode, peak: boolean): number {
  const m = MODES[mode];
  if (d < 0.3) return 3;
  return d * m.f / (peak ? m.vPeak : m.v) * 60 + m.add;
}
function score(a: number, b: number, s: Strategy): number {
  const hi = Math.max(a, b), gap = Math.abs(a - b);
  if (s === "fair") return gap + 0.15 * hi;
  if (s === "fast") return a + b;
  return hi + 0.5 * gap;
}

// OpenStreetMap queries: try several public servers, 8 s each
const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
async function overpass(q: string): Promise<{ elements?: OsmElement[] }> {
  for (const u of OVERPASS) { try { return await getJSON(u + "?data=" + enc(q), 8000); } catch { /* next server */ } }
  throw new Error("overpass");
}
const centre = (e: OsmElement) => ({ lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon });

// Candidate places
async function liveCafes(a: Area): Promise<Omit<Candidate, "park">[]> {
  const sel = "bbox" in a ? `(${a.bbox.join(",")})` : `(around:${a.r},${a.c[0]},${a.c[1]})`;
  const q = `[out:json][timeout:20];nwr["amenity"="cafe"]["name"]${sel};out center tags;`;
  const j = await overpass(q);
  const seen = new Set<string>();
  const out: Omit<Candidate, "park">[] = [];
  for (const e of j.elements || []) {
    const t = e.tags || {}, { lat, lon } = centre(e);
    if (!lat || lon === undefined || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      name: t.name,
      where: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || a.name,
      p: [lat, lon],
      known: CAFES.some(k => k[0].toLowerCase() === t.name.toLowerCase()),
    });
  }
  return out;
}
async function candidates(areaIdx: string): Promise<{ list: Candidate[]; live: boolean }> {
  if (areaIdx === "") {
    return { list: SPOTS.map(s => ({ name: s[0], where: s[1], p: [s[2], s[3]], park: s[4], strip: true, spot: s })), live: false };
  }
  const a = AREAS[+areaIdx];
  try {
    const c = await liveCafes(a);
    if (c.length) return { list: c.map(x => ({ ...x, park: nearestPark(x.p) })), live: true };
  } catch { /* fall back to the built-in list */ }
  const list: Candidate[] = [
    ...CAFES.filter(c => inArea([c[2], c[3]], a))
      .map(c => ({ name: c[0], where: c[1], p: [c[2], c[3]] as LatLng, known: true })),
    ...SPOTS.filter(s => inArea([s[2], s[3]], a))
      .map(s => ({ name: s[0], where: s[1], p: [s[2], s[3]] as LatLng, strip: true, spot: s })),
  ].map(x => ({ ...x, park: "spot" in x ? x.spot[4] : nearestPark(x.p) }));
  return { list, live: false };
}

async function roadTimes(from: LatLng, mode: Mode, dests: LatLng[]): Promise<RoadTimes> {
  const coords = [from, ...dests].map(p => p[1].toFixed(5) + "," + p[0].toFixed(5)).join(";");
  const j = await getJSON<{ code: string; durations: number[][]; distances: number[][] }>(
    MODES[mode].osrm + coords + "?sources=0&annotations=duration,distance");
  if (j.code !== "Ok") throw new Error("route");
  return { min: j.durations[0].slice(1).map(s => s / 60), km: j.distances[0].slice(1).map(m => m / 1000) };
}
function times(loc: Place, mode: Mode, peak: boolean, list: Candidate[], live: RoadTimes | null): number[] {
  return list.map((c, i) => {
    let t: number;
    if (!live) t = estimate(km(loc.p, c.p), mode, peak);
    else if (mode === "transit") t = live.km[i] / (peak ? 19 : 20) * 60 + 12;
    else { t = live.min[i]; if (mode === "drive") t *= peak ? 1.45 : 1.15; } // demo router assumes empty roads
    return t + parkMin(mode, c.park, peak);
  });
}

// Free parking near each result
const noteFor = (c: Candidate) => c.spot ? (FREE_NOTES[c.spot[0] + "|" + c.spot[1]] || "") : "";
async function freeParking(points: LatLng[]): Promise<(Lot | null)[]> {
  const q = "[out:json][timeout:20];(" +
    points.map(p => `nwr["amenity"="parking"](around:600,${p[0]},${p[1]});`).join("") + ");out center tags;";
  const j = await overpass(q);
  const lots = (j.elements || []).map(e => ({ ...centre(e), t: e.tags || {} }))
    .filter((l): l is { lat: number; lon: number; t: Record<string, string> } =>
      !!l.lat && l.lon !== undefined && !["private", "no", "permit", "residents"].includes(l.t.access) && l.t.fee !== "yes");
  return points.map(p => lots.map(l => ({ ...l, d: km(p, [l.lat, l.lon]) * 1000 })).filter(l => l.d <= 600)
    .map(l => ({ ...l, sc: l.d - (l.t.fee === "no" ? 250 : 0) - Math.min(+l.t.capacity || 0, 200) + (l.t.access === "customers" ? 100 : 0) }))
    .sort((a, b) => a.sc - b.sc)[0] || null);
}
function lotHTML(l: Lot): string {
  const t = l.t, name = t.name || "Car park", bits = [Math.max(1, Math.round(l.d / 80)) + " min walk"];
  if (t.capacity) bits.push(t.capacity + " spaces");
  bits.push(t.fee === "no" ? "free" : "likely free");
  if (t.access === "customers") bits.push("customers only");
  if (t.maxstay) bits.push("max " + t.maxstay);
  return `<a href="https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lon}" target="_blank" rel="noopener">${name}</a> (${bits.join(", ")})`;
}

const HINTS: Record<Strategy, string> = {
  balanced: "Keeps the longer trip as short as possible, without making one person travel much more.",
  fair: "Both trips take about the same time, even if that means more travel overall.",
  fast: "The lowest combined travel time. One person may travel a lot more than the other.",
};
const showHint = () => { $("hint").textContent = HINTS[select_("strategy").value as Strategy]; };
$("strategy").addEventListener("change", showHint);
showHint();

// When: leaving now (default), or meeting at a set time that both people arrive by
/** A Date as the local "YYYY-MM-DDTHH:MM" string that datetime-local inputs use. */
const localInputValue = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function syncWhen(): void {
  const meet = select_("when").value === "meet", box = input("meetAt");
  $("meetWrap").hidden = !meet;
  if (!meet) return;
  box.min = localInputValue(new Date());
  if (!box.value) { // default: an hour from now, on the next quarter hour
    const d = new Date(Date.now() + 60 * 60000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    box.value = localInputValue(d);
  }
}
$("when").addEventListener("change", syncWhen);
syncWhen();
/** Weekday commuter peaks, when Adelaide roads (and parking) are busiest. */
function isPeak(d: Date): boolean {
  const day = d.getDay(), h = d.getHours() + d.getMinutes() / 60;
  return day >= 1 && day <= 5 && ((h >= 7 && h < 9.5) || (h >= 16 && h < 18.5));
}

// Map: full-colour street map (Esri World Street Map, no key needed). Hidden where map images can't load.
const COL = { you: "#1a73e8", friend: "#e8710a", pin: "#d93025" };
let mapOK = false, map: L.Map | null = null, layer: L.LayerGroup | null = null, routeLayer: L.LayerGroup | null = null;
let lastA: Place, lastB: Place, lastTop: Result[], modes: [Mode, Mode];
let homeBounds: L.LatLngBounds | null = null;

function drawMap(A: Place, B: Place, top: Result[]): void {
  const box = $("map");
  lastA = A; lastB = B; lastTop = top;
  if (typeof L === "undefined") { box.hidden = true; return; }
  if (!map || mapOK) box.hidden = false;
  if (!map) {
    map = L.map(box, {
      zoomControl: true, scrollWheelZoom: true, wheelPxPerZoomLevel: 90, zoomSnap: 0.25, zoomDelta: 0.5,
      inertia: true, preferCanvas: false, ...({ tap: true } as L.MapOptions),
    });
    addMapButtons(map);
    const tiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 19, keepBuffer: 6, updateWhenZooming: false,
      attribution: "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    }).addTo(map);
    let loaded = false;
    tiles.on("tileload", () => { loaded = true; mapOK = true; box.hidden = false; });
    tiles.on("tileerror", () => { if (!loaded) box.hidden = true; });
    setTimeout(() => { if (!loaded) box.hidden = true; }, 2500);
  }
  if (layer) layer.remove();
  layer = L.layerGroup().addTo(map);
  const dot = (label: string, color: string) => L.divIcon({
    className: "", iconSize: [90, 22], iconAnchor: [8, 11],
    html: `<span class="dot"><i style="background:${color}"></i><span>${label}</span></span>`,
  });
  L.marker(A.p, { icon: dot("You", COL.you), keyboard: false }).addTo(layer);
  L.marker(B.p, { icon: dot("Friend", COL.friend), keyboard: false }).addTo(layer);
  top.forEach((r, i) => {
    const icon = L.divIcon({
      className: "", iconSize: [30, 40], iconAnchor: [15, 40],
      html: `<span class="pin" id="pin${i}"><svg viewBox="0 0 30 40"><path d="M15 0C6.7 0 0 6.6 0 14.8 0 25.9 15 40 15 40s15-14.1 15-25.2C30 6.6 23.3 0 15 0z" fill="${COL.pin}"/><text x="15" y="19" text-anchor="middle" font-size="13" font-weight="700" font-family="system-ui,sans-serif" fill="#fff">${i + 1}</text></svg></span>`,
    });
    L.marker(r.c.p, { icon, title: r.c.name, keyboard: false })
      .bindTooltip(r.c.name, { direction: "top", offset: [0, -38] })
      .on("click", () => select(i, false))
      .addTo(layer!);
  });
  map.invalidateSize();
  homeBounds = L.latLngBounds([A.p, B.p, ...top.map(r => r.c.p)]);
  map.fitBounds(homeBounds, { padding: [40, 40] });
  select(0, false);
}
function addMapButtons(m: L.Map): void {
  const Ctl = L.Control.extend({
    onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar mapbtns");
      d.innerHTML = '<a href="#" role="button" id="mbReset" title="Show all" aria-label="Show all spots">⤢</a><a href="#" role="button" id="mbFull" title="Full screen" aria-label="Full screen map">⛶</a>';
      L.DomEvent.disableClickPropagation(d);
      d.querySelector<HTMLElement>("#mbReset")!.onclick = e => {
        e.preventDefault();
        if (homeBounds) m.flyToBounds(homeBounds, { padding: [40, 40], duration: .5 });
      };
      d.querySelector<HTMLElement>("#mbFull")!.onclick = e => { e.preventDefault(); toggleFull(); };
      return d;
    },
  });
  new Ctl({ position: "topleft" }).addTo(m);
}
function toggleFull(): void {
  const box = $("map"), on = !box.classList.contains("full");
  box.classList.toggle("full", on);
  document.body.classList.toggle("noscroll", on);
  $("mbFull").setAttribute("aria-label", on ? "Exit full screen" : "Full screen map");
  setTimeout(() => { map!.invalidateSize(); if (homeBounds) map!.fitBounds(homeBounds, { padding: [40, 40] }); }, 50);
}
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("map").classList.contains("full")) toggleFull(); });

// Highlight one result and draw both routes to it.
// The map keeps your current zoom; it only slides if the spot is off screen.
const routeCache = new Map<string, Route>();
async function routeLine(from: LatLng, mode: Mode, dest: LatLng): Promise<Route> {
  const key = [from, mode, dest].join("|");
  const cached = routeCache.get(key);
  if (cached) return cached;
  let r: Route = { parts: [{ line: [from, dest], dashed: true }] };
  try {
    const url = MODES[mode].osrm.replace("/table/", "/route/") + `${from[1]},${from[0]};${dest[1]},${dest[0]}?overview=full&geometries=geojson`;
    const j = await getJSON<{ code: string; routes: { geometry: { coordinates: [number, number][] } }[] }>(url, 8000);
    if (j.code === "Ok") r = { parts: [{ line: j.routes[0].geometry.coordinates.map(c => [c[1], c[0]]), dashed: mode === "transit" }] };
  } catch { /* keep the straight dashed line */ }
  routeCache.set(key, r);
  return r;
}
/** Walks dotted, rides solid and labelled where you board. */
const tripRoute = (t: Trip): Route => ({
  parts: t.legs.map(l => ({ line: l.line, dashed: l.walk, label: l.walk ? undefined : l.label })),
});
let selSeq = 0;
async function select(i: number, reveal = false): Promise<void> {
  const seq = ++selSeq;
  document.querySelectorAll("#results li").forEach((li, k) => li.classList.toggle("sel", k === i));
  document.querySelectorAll(".pin").forEach((el, k) => el.classList.toggle("sel", k === i));
  if (!map || $("map").hidden) return;
  const m = map;
  const res = lastTop[i], dest = res.c.p;
  if (reveal && !m.getBounds().contains(dest)) m.panTo(dest, { animate: true, duration: .4 });
  // fetch both routes first, then swap in one go so nothing flickers
  const route = (from: LatLng, mode: Mode, trip?: Trip | null) =>
    trip ? Promise.resolve(tripRoute(trip)) : routeLine(from, mode, dest);
  const [ra, rb] = await Promise.all([route(lastA.p, modes[0], res.tripA), route(lastB.p, modes[1], res.tripB)]);
  if (seq !== selSeq) return; // a newer click won
  const g = L.layerGroup();
  for (const [r, color] of [[ra, COL.you], [rb, COL.friend]] as const) {
    for (const part of r.parts) {
      L.polyline(part.line, { color: "#fff", weight: 8, opacity: .9, interactive: false }).addTo(g);
      L.polyline(part.line, { color, weight: 5, opacity: .95, dashArray: part.dashed ? "2 9" : undefined, lineCap: "round", interactive: false }).addTo(g);
    }
    for (const part of r.parts) { // boarding labels on top of every line
      if (!part.label) continue;
      L.circleMarker(part.line[0], { radius: 5, color, weight: 3, fillColor: "#fff", fillOpacity: 1, interactive: false })
        .bindTooltip(esc(part.label), { permanent: true, direction: "left", offset: [-6, 0], className: "board" }) // left: "You"/"Friend" labels sit to the right
        .addTo(g);
    }
  }
  g.addTo(m);
  if (routeLayer) routeLayer.remove();
  routeLayer = g;
}
const link = (href: string, text: string, label: string) =>
  `<a href="${href}" target="_blank" rel="noopener" aria-label="${label}">${text}</a>`;

let busy = false;
const setGo = (on: boolean) => { $<HTMLButtonElement>("go").disabled = !on; };
const esc = (s: string) => s.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** Run `f` over `items`, at most `n` at a time. */
async function mapLimit<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await f(items[i]); }
  }));
  return out;
}
/**
 * Replace estimated public transport times on the shortlist with real trips.
 * Each lookup gets one retry; any that still fail keep their estimate (trip stays undefined).
 * If the first few all fail, the planner is treated as down and the rest are skipped.
 * Returns how many lookups failed out of how many were needed.
 */
async function addTransit(list: Result[], A: Place, B: Place, mA: Mode, mB: Mode, meetAt: Date | null) {
  let ok = 0, failed = 0;
  const jobs = list.flatMap(r => (["A", "B"] as const)
    .filter(who => (who === "A" ? mA : mB) === "transit")
    .map(who => ({ r, who })));
  await mapLimit(jobs, 3, async ({ r, who }) => {
    if (failed >= 3 && ok === 0) { failed++; return; } // planner looks down: don't keep the user waiting
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const trip = await transitTrip(who === "A" ? A.p : B.p, r.c.p, meetAt);
        const t = trip ? trip.cost : NO_TRIP;
        if (who === "A") { r.tripA = trip; r.tA = t; } else { r.tripB = trip; r.tB = t; }
        ok++;
        return;
      } catch {
        if (attempt === 0) await new Promise(res => setTimeout(res, 800));
      }
    }
    failed++;
  });
  return { failed, total: jobs.length };
}

async function run(): Promise<void> {
  if (busy) return;
  busy = true; setGo(false); $("err").textContent = "";
  try {
    const meetAt = select_("when").value === "meet" ? new Date(input("meetAt").value) : null;
    if (meetAt && !(meetAt.getTime() > Date.now())) { // also catches an empty or invalid time
      $("err").textContent = "Pick a meeting time in the future.";
      $("results").innerHTML = ""; $("summary").textContent = ""; $("status").textContent = "";
      return;
    }
    $("status").textContent = "Finding addresses…";
    const tA = input("addrA").value.trim(), tB = input("addrB").value.trim();
    const A = await locate(tA), B = await locate(tB);
    $("addrA").setAttribute("aria-invalid", String(!A));
    $("addrB").setAttribute("aria-invalid", String(!B));
    if (!A || !B) {
      $("err").textContent = `Can't find ${!A ? "your" : "your friend's"} address. Add the suburb and postcode, for example "13 Example Crescent, Rostrevor SA 5073".`;
      $("results").innerHTML = ""; $("summary").textContent = ""; $("status").textContent = "";
      return;
    }
    const mA = select_("modeA").value as Mode, mB = select_("modeB").value as Mode;
    const s = select_("strategy").value as Strategy, peak = isPeak(meetAt ?? new Date());
    const drive = mA === "drive" || mB === "drive", anyTransit = mA === "transit" || mB === "transit";
    $("status").textContent = "Finding cafés…";
    const { list } = await candidates(select_("area").value);
    if (!list.length) {
      $("err").textContent = "No cafés found in that area. Pick another area or Anywhere.";
      $("results").innerHTML = ""; $("status").textContent = "";
      return;
    }
    // keep the road-time request small: 60 places nearest the midpoint
    const mid: LatLng = [(A.p[0] + B.p[0]) / 2, (A.p[1] + B.p[1]) / 2];
    const pool = list.sort((x, y) => km(mid, x.p) - km(mid, y.p)).slice(0, 60);
    $("status").textContent = "Working out travel times…";
    let rA: RoadTimes | null = null, rB: RoadTimes | null = null;
    try { [rA, rB] = await Promise.all([roadTimes(A.p, mA, pool.map(c => c.p)), roadTimes(B.p, mB, pool.map(c => c.p))]); }
    catch { rA = rB = null; }
    const TA = times(A, mA, peak, pool, rA), TB = times(B, mB, peak, pool, rB);
    const rank = (rs: Result[]) => rs
      .map(r => ({ ...r, sc: score(r.tA, r.tB, s) - (r.c.known ? 2 : 0) }))
      .sort((x, y) => x.sc - y.sc);
    // Shortlist on estimates; for public transport, check real timetables for a few more spots than we show
    let top = rank(pool.map((c, i) => ({ c, tA: TA[i], tB: TB[i], sc: 0 }))).slice(0, anyTransit ? TRANSIT_SHORTLIST : 5);
    let transitNote = "";
    if (anyTransit) {
      $("status").textContent = "Checking bus, train and tram timetables…";
      const { failed, total } = await addTransit(top, A, B, mA, mB, meetAt);
      top = rank(top).slice(0, 5);
      if (failed === total) transitNote = "Couldn't reach the public transport planner, so public transport times are estimates.";
      else if (failed && top.some(r => (mA === "transit" && r.tripA === undefined) || (mB === "transit" && r.tripB === undefined)))
        transitNote = "The public transport planner didn't answer for every spot, so some times are estimates.";
    }
    $("summary").textContent = `You're ${km(A.p, B.p).toFixed(1)} km apart in a straight line.`;
    const fb = [
      !A.exact && `your trip starts from the centre of ${A.sub}`,
      !B.exact && `your friend's trip starts from the centre of ${B.sub}`,
    ].filter(Boolean);
    $("status").textContent = [
      fb.length ? `Address not found exactly, so ${fb.join(" and ")}.` : "",
      transitNote,
    ].filter(Boolean).join(" ");

    const mins = (t: number) => t >= NO_TRIP ? "no trip" : `${Math.round(t)} min`;
    const leave = (t: number, trip?: Trip | null) =>
      t >= NO_TRIP ? "no trip" : clock(trip ? trip.start : new Date(meetAt!.getTime() - t * 60000));
    const tripLine = (whose: string, mode: Mode, trip?: Trip | null) => {
      if (mode !== "transit" || trip === undefined) return "";
      if (!trip) return `<p>${whose} trip: no public transport ${meetAt ? "gets there in time" : "trip found"}</p>`;
      return `<p>${whose} trip: ${meetAt ? "" : `leave ${clock(trip.start)}, `}${esc(tripSteps(trip))}, arrive ${clock(trip.end)}</p>`;
    };
    $("results").innerHTML = top.map((r, i) => {
      const c = r.c, name = c.strip ? `${c.name}, ${c.where}` : c.name, dest = `${c.p[0]},${c.p[1]}`;
      const note = noteFor(c);
      const park = drive ? `<p id="park${i}">${note ? "Free parking: " + note : "Free parking: looking…"}</p>` : "";
      const search = c.strip ? "cafes near " + name + ", SA" : name + ", " + c.where + ", SA";
      return `<li><h3><button type="button" data-i="${i}">${i + 1}. ${name}</button></h3>
        ${c.strip ? "" : `<p>${c.where}${c.known ? " · well known" : ""}</p>`}
        <p>You ${mins(r.tA)} · Friend ${mins(r.tB)}${drive ? " · " + PARK[c.park].label : ""}</p>
        ${meetAt ? `<p>Leave by: you ${leave(r.tA, r.tripA)}, friend ${leave(r.tB, r.tripB)}</p>` : ""}
        ${tripLine("Your", mA, r.tripA)}${tripLine("Your friend's", mB, r.tripB)}
        ${park}
        <div class="links">
          ${link("https://www.google.com/maps/search/?api=1&query=" + enc(search), c.strip ? "Cafés" : "Map", "Map of " + name)}
          ${link(`https://www.google.com/maps/dir/?api=1&origin=${enc(tA)}&destination=${dest}&travelmode=${MODES[mA].gm}`, "Your route", "Your route to " + name)}
          ${link(`https://www.google.com/maps/dir/?api=1&origin=${enc(tB)}&destination=${dest}&travelmode=${MODES[mB].gm}`, "Friend's route", "Friend's route to " + name)}
        </div></li>`;
    }).join("");
    modes = [mA, mB];
    routeCache.clear();
    document.querySelectorAll<HTMLButtonElement>("#results h3 button").forEach(b => b.addEventListener("click", () => {
      select(+b.dataset.i!, true);
      $("map").scrollIntoView({ behavior: "smooth", block: "nearest" });
    }));
    drawMap(A, B, top);
    // Fill in free parking afterwards, without holding up the results
    if (drive) {
      busy = false; setGo(true);
      freeParking(top.map(r => r.c.p)).then(lots => {
        lots.forEach((lot, i) => {
          const el = $("park" + i);
          if (!el) return;
          if (lot) el.innerHTML = "Free parking: " + lotHTML(lot);
          else if (!noteFor(top[i].c)) el.textContent = "Free parking: none found within 600 m";
        });
      }).catch(() => { top.forEach((r, i) => { const el = $("park" + i); if (el && !noteFor(r.c)) el.textContent = ""; }); });
    }
  } finally { busy = false; setGo(true); }
}

// Clear old results as soon as anything changes, so nothing stale is shown
["addrA", "addrB", "modeA", "modeB", "area", "strategy", "when", "meetAt"].forEach(id => $(id).addEventListener("input", () => {
  $("results").innerHTML = ""; $("summary").textContent = ""; $("err").textContent = "";
  $("map").hidden = true; $("status").textContent = "Press Find spots to update.";
}));
$("form").addEventListener("submit", e => { e.preventDefault(); run(); });
run();
