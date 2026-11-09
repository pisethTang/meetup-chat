// Public transport trips from Transitous (https://transitous.org), a free community-run router
// that uses Adelaide Metro's published timetables. No API key; please keep request volumes low.
import type { LatLng } from "./data";
import { enc, getJSON } from "./http";

const API = "https://api.transitous.org/api/v5/plan";
// How trips are compared when picking the best one for a person (like Google Maps / OpenTripPlanner,
// a trip that is a bit later but has much less walking wins):
/** Extra minutes a change of vehicle "costs". */
const TRANSFER_PENALTY = 5;
/** Extra cost per minute of walking on top of the minute itself, i.e. walking counts double. */
const WALK_EXTRA = 1;
/** When leaving now, waiting at home for a later bus only counts half (you're not on the road yet). */
const HOME_WAIT_WEIGHT = 0.5;

export interface Leg {
  walk: boolean;
  /** e.g. "Bus 263", "Train to Seaford", "Walk" */
  label: string;
  start: Date;
  end: Date;
  line: LatLng[];
}
export interface Trip {
  start: Date;
  end: Date;
  transfers: number;
  legs: Leg[];
  /** Minutes of the person's time: leaving home until the meeting time (or arrival, when leaving now). */
  cost: number;
}

interface ApiLeg {
  mode: string;
  startTime: string;
  endTime: string;
  routeShortName?: string;
  headsign?: string;
  cancelled?: boolean;
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  legGeometry?: { points: string; precision: number };
}
interface ApiItinerary { startTime: string; endTime: string; transfers: number; legs: ApiLeg[] }
interface PlanResponse { itineraries?: ApiItinerary[]; direct?: ApiItinerary[] }

/** Decode a Google-style encoded polyline. Uses arithmetic, not bit ops, so precision 7 can't overflow. */
export function decodePolyline(str: string, precision: number): LatLng[] {
  const f = 10 ** precision, out: LatLng[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, mul = 1, b: number;
    do { b = str.charCodeAt(i++) - 63; result += (b % 32) * mul; mul *= 32; } while (b >= 32);
    return result % 2 ? -(result + 1) / 2 : result / 2;
  };
  while (i < str.length) { lat += next(); lon += next(); out.push([lat / f, lon / f]); }
  return out;
}

function legLabel(l: ApiLeg): string {
  const to = l.headsign ? ` to ${l.headsign}` : "";
  switch (l.mode) {
    case "WALK": return "Walk";
    case "BUS": case "COACH": return l.routeShortName ? `Bus ${l.routeShortName}` : "Bus" + to;
    case "TRAM": return "Tram" + to;
    case "FERRY": return "Ferry" + to;
    default: return "Train" + to; // RAIL, REGIONAL_RAIL, SUBURBAN, METRO, ...
  }
}

function toTrip(it: ApiItinerary, meetAt: Date | null, now: Date): Trip {
  const start = new Date(it.startTime), end = new Date(it.endTime);
  const cost = meetAt ? (meetAt.getTime() - start.getTime()) / 60000 : (end.getTime() - now.getTime()) / 60000;
  return {
    start, end, cost, transfers: it.transfers,
    legs: it.legs.map(l => ({
      walk: l.mode === "WALK",
      label: legLabel(l),
      start: new Date(l.startTime),
      end: new Date(l.endTime),
      line: l.legGeometry ? decodePolyline(l.legGeometry.points, l.legGeometry.precision)
        : [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]],
    })),
  };
}

/**
 * The best public transport trip from `from` to `to`.
 * meetAt = null: leave now, best = earliest arrival.
 * meetAt = a time: arrive by then, best = leave as late as possible.
 * Returns null when no trip exists (e.g. late at night); throws if Transitous can't be reached.
 */
export async function transitTrip(from: LatLng, to: LatLng, meetAt: Date | null): Promise<Trip | null> {
  const now = new Date();
  const url = `${API}?fromPlace=${from[0]},${from[1]}&toPlace=${to[0]},${to[1]}` +
    `&time=${enc((meetAt ?? now).toISOString())}${meetAt ? "&arriveBy=true" : ""}`;
  const j = await getJSON<PlanResponse>(url, 15000);
  const trips = [...(j.direct || []), ...(j.itineraries || [])]
    .filter(it => !it.legs.some(l => l.cancelled))
    .map(it => toTrip(it, meetAt, now))
    .filter(t => meetAt ? t.end.getTime() <= meetAt.getTime() + 60000 && t.start >= now : true);
  const feel = (t: Trip) => {
    const walk = t.legs.filter(l => l.walk).reduce((s, l) => s + (l.end.getTime() - l.start.getTime()) / 60000, 0);
    const homeWait = meetAt ? 0 : Math.max(0, (t.start.getTime() - now.getTime()) / 60000);
    return t.cost - (1 - HOME_WAIT_WEIGHT) * homeWait + WALK_EXTRA * walk + TRANSFER_PENALTY * t.transfers;
  };
  trips.sort((a, b) => feel(a) - feel(b));
  return trips[0] ?? null;
}

const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export { time as clock };

/** "walk 7 min → Bus 263 → walk 9 min" (very short walks left out). */
export function tripSteps(t: Trip): string {
  return t.legs
    .map(l => {
      const min = Math.round((l.end.getTime() - l.start.getTime()) / 60000);
      return l.walk ? (min >= 2 ? `walk ${min} min` : "") : l.label;
    })
    .filter(Boolean).join(" → ");
}
