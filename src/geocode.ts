// Address lookup: OpenStreetMap (Nominatim) first, then Photon, then the suburb or postcode found in the text.
import { SUBURBS } from "./data";
import type { LatLng, Suburb } from "./data";
import { enc, getJSON } from "./http";

/** `exact: false` means we fell back to the centre of suburb `sub`. */
export interface Place { p: LatLng; exact: boolean; sub?: string }

const byPost = new Map<string, Suburb>();
SUBURBS.forEach(s => { if (!byPost.has(s[1])) byPost.set(s[1], s); });

/** The longest suburb name that appears as whole words in the text. */
function suburbIn(text: string): Suburb | null {
  const t = " " + text.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ") + " ";
  let best: Suburb | null = null;
  for (const s of SUBURBS) {
    if (t.includes(" " + s[0].toLowerCase() + " ") && (!best || s[0].length > best[0].length)) best = s;
  }
  return best;
}
export function suburbFrom(text: string): Suburb | null {
  const best = suburbIn(text);
  if (best) return best;
  const pc = text.match(/\b5\d{3}\b/);
  return pc ? byPost.get(pc[0]) ?? null : null;
}

/**
 * The text with the suburb name taken out, keeping the street and postcode.
 * OpenStreetMap's suburb boundaries don't always match what people (or Australia Post) call
 * a suburb: e.g. Ash Avenue is "Tonsley" in OSM but "Clovelly Park" in many addresses.
 */
function withoutSuburb(text: string): string {
  const s = suburbIn(text);
  if (!s) return text;
  const i = text.toLowerCase().lastIndexOf(s[0].toLowerCase()); // last match, so "Prospect Rd, Prospect" keeps the road
  return (text.slice(0, i) + " " + text.slice(i + s[0].length)).replace(/\s*,\s*,/g, ",").replace(/\s+/g, " ").trim();
}
const stripNumber = (text: string) => text.replace(/^\s*(unit\s*)?\d+[a-z]?(\s*\/\s*\d+[a-z]?)?\s*,?\s*/i, "");

const STREET_TYPES = new Set(("avenue ave av street st road rd crescent cres cr court ct terrace tce drive dr place pl " +
  "grove gr gve way parade pde lane ln highway hwy close cl boulevard blvd bvd circuit cct square sq esplanade esp " +
  "mews rise row parkway pkwy gardens gdns walk mall").split(" "));
/** "Ash Avenue" / "Ash Ave" -> "ash", so different spellings of a street compare equal. */
function streetCore(s: string): string {
  const w = s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean);
  if (w.length > 1 && STREET_TYPES.has(w[w.length - 1])) w.pop();
  return w.join(" ");
}
/** The street (or place name) the user typed, e.g. "17A Ash Avenue Clovelly Park SA 5042" -> "ash". */
function typedStreet(text: string): string {
  const t = stripNumber(withoutSuburb(text)).split(",")[0]
    .replace(/\b5\d{3}\b/g, "").replace(/\b(sa|south australia|australia)\b/gi, "");
  return streetCore(t);
}

const geoCache = new Map<string, Place>();
async function nominatim(text: string): Promise<Place | null> {
  const key = text.trim().toLowerCase();
  const cached = geoCache.get(key);
  if (cached) return cached;
  const noLetter = text.replace(/\b(\d+)[a-z]\b/i, "$1");
  const tries = [...new Set([
    text,
    noLetter,
    withoutSuburb(noLetter), // street + postcode, in case OSM files the street under another suburb
    stripNumber(text),
  ])].filter(q => q.trim().length > 3);
  let answered = false;
  for (const [i, q] of tries.entries()) {
    try {
      const j = await getJSON<{ lat: string; lon: string }[]>(
        "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=au&viewbox=138.3,-34.6,138.9,-35.3&bounded=1&q=" + enc(q));
      answered = true;
      if (j.length) { const r: Place = { p: [+j[0].lat, +j[0].lon], exact: true }; geoCache.set(key, r); return r; }
    } catch {
      // One query can fail on its own (Nominatim sometimes serves a cached reply without CORS headers,
      // which the browser blocks), so carry on with the other spellings rather than giving up.
    }
    if (i < tries.length - 1) await new Promise(r => setTimeout(r, 1100)); // Nominatim allows 1 request per second
  }
  if (!answered) throw new Error("nominatim unreachable");
  return null;
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { name?: string; street?: string };
}
// Backup address search (Photon, also built on OpenStreetMap).
// Photon is fuzzy: it will happily return a station or park that only matches the suburb,
// so only accept a result that is actually on (or named after) the street that was typed.
async function photon(text: string): Promise<Place | null> {
  const want = typedStreet(text);
  const onStreet = (f: PhotonFeature) => !want || [f.properties.street, f.properties.name]
    .some(n => n && (" " + streetCore(n) + " ").includes(" " + want + " "));
  const noLetter = text.replace(/\b(\d+)[a-z]\b/i, "$1");
  // as typed, then without the suburb (see withoutSuburb) — the second only runs if the first misses
  for (const q of new Set([noLetter, withoutSuburb(noLetter)])) {
    const j = await getJSON<{ features?: PhotonFeature[] }>(
      "https://photon.komoot.io/api/?limit=5&bbox=138.3,-35.3,138.9,-34.6&q=" + enc(q));
    const f = (j.features || []).find(onStreet);
    if (!f) continue;
    const r: Place = { p: [f.geometry.coordinates[1], f.geometry.coordinates[0]], exact: true };
    geoCache.set(text.trim().toLowerCase(), r);
    return r;
  }
  return null;
}

let online = true;
export async function locate(text: string): Promise<Place | null> {
  if (online) {
    try { const g = await nominatim(text) || await photon(text); if (g) return g; }
    catch {
      try { const g = await photon(text); if (g) return g; } catch { online = false; }
    }
  }
  const s = suburbFrom(text);
  return s ? { p: [s[2], s[3]], exact: false, sub: s[0] } : null;
}
