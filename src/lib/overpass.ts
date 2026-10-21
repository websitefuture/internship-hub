import type { RoleKey } from "./types";

// The OpenStreetMap business search (Overpass), shared by the browser and the server.
//
// The browser runs it first. A high-school search's Overpass query takes 17s to 28s on the
// public instance, and Netlify cuts a function's response off at about 30s: measured on
// 2026-10-20, three production searches from Campbell, California each ended at 30.4s with
// nothing but keepalive spaces, even though the route had a 50s budget. A browser has no such
// limit, and each student asks from their own address, so Overpass's per-address rate limit
// (two concurrent queries) is spent per student instead of shared by every user of the site.
// The browser sends the raw records to /api/search-live, which only scores them.
//
// If the browser's query fails, the route still tries Overpass itself, within the time it has.
//
// Each filter matches specific tag VALUES via regex, never a bare tag-presence filter like
// ["shop"], tested directly against Overpass's public instance: a bare presence filter (which
// has to scan every subtype of that tag) reliably timed out once combined with even one more
// filter, while a handful of regex-narrowed value filters stayed fast. This also keeps the
// categories realistic for what a teen could plausibly walk into and ask about.
// "office=it" is OSM's tag for a software/IT company, the closest real proxy this data has
// for "tech company." Design, marketing, eng, and data are the roles a student most plausibly
// wants at a tech company specifically (vs. trades/healthcare/hospitality/retail, which are
// genuinely local-business roles), so each of those includes it, on top of the role's own
// more specific category.
export const ROLE_OSM_FILTERS: Record<RoleKey, string[]> = {
  marketing: ['["office"~"^(it|advertising_agency|marketing|newspaper|publisher)$"]'],
  ops: ['["office"~"^(it|company|consulting|financial|coworking)$"]'],
  eng: ['["office"~"^(it|engineer|telecommunication)$"]', '["shop"="computer"]'],
  design: ['["office"~"^(it|architect)$"]', '["craft"~"^(photographer|sign_maker)$"]'],
  data: ['["office"~"^(it|research)$"]'],
  trades: ['["craft"~"^(electrician|plumber|carpenter|hvac|painter|roofer|metal_construction)$"]'],
  healthcare: ['["amenity"~"^(clinic|dentist|veterinary|pharmacy)$"]'],
  hospitality: ['["amenity"~"^(restaurant|cafe|fast_food|bar|ice_cream)$"]', '["tourism"="hotel"]'],
  retail: [
    '["shop"~"^(bakery|clothes|shoes|convenience|supermarket|pet|toys|books|florist|hairdresser|beauty|bicycle|garden_centre|coffee|deli|gift|jewelry|electronics)$"]',
  ],
};

export const DEFAULT_FILTERS = [
  '["shop"~"^(bakery|clothes|convenience|supermarket|pet|toys|books|florist|hairdresser|coffee|deli|gift)$"]',
  '["amenity"~"^(restaurant|cafe|fast_food)$"]',
  '["office"~"^(estate_agent|insurance|company|consulting)$"]',
];

// Overpass query cost rises fast with radius in a dense city, capped well below what the
// "how far" question allows so results stay genuinely nearby enough for a teen to visit or call.
export const MAX_RADIUS_MILES = 50;

export function radiusMilesForAnswers(max?: string): number {
  return Math.min(parseFloat(max || "10") || 10, MAX_RADIUS_MILES);
}

export function filtersForRoles(roles: RoleKey[]): string[] {
  const filters = roles.length ? roles.flatMap((r) => ROLE_OSM_FILTERS[r] ?? []) : DEFAULT_FILTERS;
  return Array.from(new Set(filters.length ? filters : DEFAULT_FILTERS));
}

export interface OverpassTags {
  name?: string;
  [key: string]: string | undefined;
}

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  timestamp?: string;
  tags?: OverpassTags;
}

interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

// A bbox filter lets Overpass use its spatial index directly, tested directly against the
// public instance, this consistently ran several times faster than the equivalent "around"
// (radial) filter. The bbox is a rectangle, not a circle, so the exact radius is re-applied
// afterward (fetchLocalBusinesses) before anything is shown.
export function buildQuery(lat: number, lng: number, radiusMiles: number, filters: string[], budgetMs: number): string {
  // Overpass's own timeout is told the time we actually have left, never more, so the server
  // gives up before our fetch does rather than us abandoning work it is still doing.
  const budget = Math.max(10, Math.floor(budgetMs / 1000) - 2);
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  const south = lat - dLat;
  const north = lat + dLat;
  const west = lng - dLng;
  const east = lng + dLng;
  const clauses = filters.map((f) => `  node${f}["name"];\n  way${f}["name"];`).join("\n");
  // No "meta": measured from Campbell, California, it made the same query's time swing from a
  // steady ~17s to as much as 28.8s, and a run past the timeout returns nothing at all.
  return `[out:json][timeout:${budget}][bbox:${south},${west},${north},${east}];\n(\n${clauses}\n);\nout center 200;`;
}

// Which Overpass server to ask. One at a time, in order: a mirror first, then the main instance.
// overpass-api.de is the main public instance and is overloaded at times (on 2026-10-15 it took
// 33s for a trivial query; on 2026-10-20 it answered "at capacity" for most of an afternoon).
// overpass.private.coffee's policy allows this use (OSM wiki, "Overpass API": "Feel free to use
// our service in any project, there is no rate limit in place"); it is also down at times.
// The servers are tried in turn, never raced: racing would double every search's load on
// volunteer servers.
export const OVERPASS_MIRROR = "https://overpass.private.coffee/api/interpreter";
export const OVERPASS_MAIN = "https://overpass-api.de/api/interpreter";

export async function postOverpass(endpoint: string, query: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<OverpassElement[]> {
  const params = new URLSearchParams();
  params.set("data", query);
  const res = await fetch(endpoint, { method: "POST", body: params, headers, signal: AbortSignal.timeout(timeoutMs) });
  // Thrown rather than returning []: Overpass answers 429 when out of slots and 502/504 when
  // overloaded, and swallowing those made a busy service indistinguishable from an empty
  // neighbourhood ("0 real businesses within 30 miles" when nobody had looked).
  if (!res.ok) throw new Error(`Overpass ${res.status} from ${new URL(endpoint).host}`);
  const body = (await res.json()) as OverpassResponse;
  // A query that runs out of time on the server can still come back as HTTP 200, with the error
  // in "remark" and the elements empty or cut short. That counts as a failure too.
  if (body.remark && /error/i.test(body.remark)) throw new Error(`Overpass: ${body.remark}`);
  return body.elements ?? [];
}

// Nominatim, the fallback. Overpass is one service on a handful of servers, and all of them can
// be out at once: on 2026-10-20 overpass-api.de and overpass.private.coffee both stopped
// answering connections from Campbell, California for over an hour, from a browser and from
// Node alike, while nominatim.openstreetmap.org answered in half a second. Nominatim is a
// search over the same OpenStreetMap data, so its records are the same businesses with the
// same tags. It is not a bulk API: one query per category, at most NOMINATIM_MAX_QUERIES of
// them, one at a time and at least a second apart (its usage policy: "an absolute maximum of
// 1 request per second"), each returning at most 40 places. So it finds fewer businesses than
// Overpass would, but real ones, which beats telling a student the search failed.
export const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_MAX_QUERIES = 8;
const NOMINATIM_SPACING_MS = 1_100;
const NOMINATIM_TIMEOUT_MS = 6_000;

// The [key, value] pairs a list of filters matches, e.g. '["office"~"^(it|engineer)$"]' gives
// office=it and office=engineer. Taken round-robin across the filters, so that when the query
// cap cuts the list short, every role the student picked still gets its first categories in.
export function tagPairs(filters: string[]): [string, string][] {
  const lists = filters.flatMap((f) => {
    const m = /^\["(\w+)"(?:~"\^\(([^)]+)\)\$"|="([^"]+)")\]$/.exec(f);
    return m ? [(m[2] ?? m[3]).split("|").map((v): [string, string] => [m[1], v])] : [];
  });
  const out: [string, string][] = [];
  const seen = new Set<string>();
  for (let i = 0; lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const pair = l[i];
      if (!pair || seen.has(pair.join("="))) continue;
      seen.add(pair.join("="));
      out.push(pair);
    }
  }
  return out;
}

interface NominatimPlace {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  category?: string;
  type?: string;
  name?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
}

// A Nominatim place in Overpass's shape, so everything downstream treats both the same way.
function fromNominatim(p: NominatimPlace): OverpassElement | null {
  const type = p.osm_type;
  if (type !== "node" && type !== "way" && type !== "relation") return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (typeof p.osm_id !== "number" || !p.name || !p.category || !p.type || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const a = p.address ?? {};
  const tags: OverpassTags = { ...(p.extratags ?? {}), name: p.name, [p.category]: p.type };
  // Nominatim fills "road" in for every place, with the nearest street when the place has no
  // address of its own, so a street is only taken along with the house number it came with.
  if (a.house_number && a.road) {
    tags["addr:housenumber"] = a.house_number;
    tags["addr:street"] = a.road;
  }
  const city = a.city || a.town || a.village;
  if (city) tags["addr:city"] = city;
  return { type, id: p.osm_id, lat, lon, tags };
}

// `cap` works as in the server's Overpass call: it may shorten a query's timeout, and throws
// when no time is left, which ends the search with whatever was found so far. Throws only if
// every query failed; an area with no matching businesses is an empty list, not an error.
export async function searchNominatim(
  lat: number,
  lng: number,
  radiusMiles: number,
  filters: string[],
  opts: { headers?: Record<string, string>; cap?: (ms: number) => number } = {},
): Promise<OverpassElement[]> {
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  const viewbox = [lng - dLng, lat + dLat, lng + dLng, lat - dLat].map((n) => n.toFixed(5)).join(",");
  const out = new Map<string, OverpassElement>();
  let answered = 0;
  let lastError: unknown = new Error("Nominatim: nothing to search for");
  const pairs = tagPairs(filters).slice(0, NOMINATIM_MAX_QUERIES);
  for (let i = 0; i < pairs.length; i++) {
    let timeoutMs: number;
    try {
      if (i > 0) {
        (opts.cap ?? ((ms: number) => ms))(NOMINATIM_SPACING_MS + 1_000);
        await new Promise((r) => setTimeout(r, NOMINATIM_SPACING_MS));
      }
      timeoutMs = (opts.cap ?? ((ms: number) => ms))(NOMINATIM_TIMEOUT_MS);
    } catch {
      break;
    }
    const [key, value] = pairs[i];
    const params = new URLSearchParams({
      q: `[${key}=${value}]`,
      format: "jsonv2",
      limit: "40",
      viewbox,
      bounded: "1",
      addressdetails: "1",
      extratags: "1",
    });
    try {
      const res = await fetch(`${NOMINATIM_SEARCH}?${params}`, { headers: opts.headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) throw new Error("Nominatim: unexpected response");
      answered += 1;
      for (const p of body as NominatimPlace[]) {
        const el = fromNominatim(p);
        if (el) out.set(`${el.type}-${el.id}`, el);
      }
    } catch (err) {
      lastError = err;
    }
  }
  if (!answered) throw lastError;
  return [...out.values()];
}

// Browser side. The browser sets its own User-Agent (it may not be overridden). Mirror first
// with a short timeout. If it fails, the main instance and Nominatim are asked side by side:
// when Overpass is down its servers often just hang until the timeout, and waiting out 35s
// before starting the fallback made a search take over a minute. The main instance's fuller
// answer wins whenever it comes back. Throws only if everything failed; the caller then lets
// the server try.
export async function searchOsmFromBrowser(lat: number, lng: number, radiusMiles: number, roles: RoleKey[]): Promise<OverpassElement[]> {
  const filters = filtersForRoles(roles);
  try {
    return await postOverpass(OVERPASS_MIRROR, buildQuery(lat, lng, radiusMiles, filters, 12_000), 12_000);
  } catch {
    // Next servers.
  }
  const fallback = searchNominatim(lat, lng, radiusMiles, filters);
  fallback.catch(() => {});
  try {
    return await postOverpass(OVERPASS_MAIN, buildQuery(lat, lng, radiusMiles, filters, 35_000), 35_000);
  } catch {
    return fallback;
  }
}

// The records a browser sends are untrusted input. Only well-formed elements with a name and
// coordinates are kept, tag values must be strings, and the count is capped. The records only
// ever shape the sender's own results; the server never caches them for anyone else.
export function sanitizeElements(input: unknown, max = 2_000): OverpassElement[] {
  if (!Array.isArray(input)) return [];
  const out: OverpassElement[] = [];
  for (const raw of input.slice(0, max)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "node" && e.type !== "way" && e.type !== "relation") continue;
    if (typeof e.id !== "number" || !Number.isFinite(e.id)) continue;
    const tagsIn = e.tags;
    if (!tagsIn || typeof tagsIn !== "object") continue;
    const tags: OverpassTags = {};
    for (const [k, v] of Object.entries(tagsIn as Record<string, unknown>)) {
      if (typeof v === "string" && k.length <= 64 && v.length <= 500) tags[k] = v;
    }
    if (!tags.name) continue;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const c = e.center as Record<string, unknown> | undefined;
    const center = c && num(c.lat) !== undefined && num(c.lon) !== undefined ? { lat: num(c.lat)!, lon: num(c.lon)! } : undefined;
    const el: OverpassElement = { type: e.type, id: e.id, lat: num(e.lat), lon: num(e.lon), center, tags };
    if ((el.lat === undefined || el.lon === undefined) && !el.center) continue;
    out.push(el);
  }
  return out;
}
