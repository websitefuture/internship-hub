import type { GeoResult } from "./types";

// Free worldwide geocoding via OpenStreetMap's Nominatim (no API key, no billing).
// Usage policy requires an identifying User-Agent and asks for light traffic
// fine for this app's per-question search volume.
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const USER_AGENT = "InternshipNest/1.0 (+https://github.com/websitefuture/internship-hub)";

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
  country_code?: string;
}

interface NominatimRow {
  display_name: string;
  lat: string;
  lon: string;
  name?: string;
  addresstype?: string;
  importance?: number;
  address?: NominatimAddress;
}

// preferOwnName is only correct when the row came from a search the student typed. There,
// row.name is the place they asked for, and using it avoids falling through to display_name,
// which is what put "Austin County, Texas, 91184" on screen: an address with a postcode, not
// the name of a place to search from.
//
// A reverse geocode must never use it. The nearest named feature to a set of coordinates is
// usually a business, so this labelled a Campbell search "Iyngar Yoga South Bay, California".
// There the administrative fields are the only trustworthy source of a place name.
function conciseLabel(row: NominatimRow, preferOwnName: boolean): string {
  const a = row.address;
  const place = (preferOwnName ? row.name : "") || a?.city || a?.town || a?.village || a?.county;
  const region = a?.state || a?.country;
  if (place && region && place !== region) return `${place}, ${region}`;
  if (place) return place;
  return row.display_name.split(",").slice(0, 2).join(",").trim();
}

// Typing a city should offer that city first. Nominatim ranks purely by its own importance
// score, which interleaves a city, the county sharing its name, and individual street
// addresses: searching "Austin" returns the city and "Austin County" back to back. A student
// who picks the county then searches from a rural centroid tens of miles from the city they
// meant, and every distance on the results page is quietly wrong.
//
// So results are grouped by what kind of place they are, settlements first, and ordered by
// Nominatim's own score only within a group. Nothing is discarded, because specific places
// are a real need too: someone typing their own street address should still find it.
const PLACE_RANK: Record<string, number> = {
  city: 0,
  town: 1,
  municipality: 1,
  borough: 2,
  village: 2,
  hamlet: 3,
  suburb: 4,
  neighbourhood: 5,
  county: 6,
  state_district: 7,
  state: 8,
  province: 8,
  country: 9,
};

function placeRank(row: NominatimRow): number {
  const t = (row.addresstype || "").toLowerCase();
  // Anything not named above is a road, building or postcode: real, but never the broad
  // answer, so it sorts below every settlement instead of being dropped.
  return t in PLACE_RANK ? PLACE_RANK[t] : 10;
}

// How well a result answers what was actually typed, which outranks both the kind of place
// and Nominatim's own score. Ranking by kind alone was not enough: "Campbell, California"
// put "California, Kentucky" first, because both are cities and the Kentucky one scores
// higher, so the student's own town came second to a place they had not mentioned.
//
// Comparing against the first segment means a typed "Austin County" still surfaces the
// county ahead of the city, which is the point: broad and specific both have to be reachable.
function queryMatch(row: NominatimRow, query: string): number {
  const typed = query.split(",")[0].trim().toLowerCase();
  const name = (row.name || "").toLowerCase();
  if (!typed || !name) return 3;
  if (name === typed) return 0;
  if (name.startsWith(typed)) return 1;
  if (name.includes(typed)) return 2;
  return 3;
}

async function nominatim(params: string): Promise<NominatimRow[]> {
  const res = await fetch(`${NOMINATIM_BASE}/search?${params}`, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  return (await res.json()) as NominatimRow[];
}

export async function searchPlaces(query: string): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const base = `format=jsonv2&addressdetails=1&q=${encodeURIComponent(q)}`;

  let rows = await nominatim(`${base}&limit=10`);

  // If the plain search surfaced no settlement at all, ask again for towns and cities only.
  // featureType=city drops counties outright, checked against the live service. It is a
  // fallback rather than a second request every time, because Nominatim asks callers to keep
  // traffic light and the common case already contains the city.
  if (!rows.some((r) => placeRank(r) <= 5)) {
    try {
      const broad = await nominatim(`${base}&limit=6&featureType=city`);
      const seen = new Set(rows.map((r) => `${r.lat},${r.lon}`));
      rows = [...broad, ...rows.filter((r) => !seen.has(`${r.lat},${r.lon}`))];
    } catch {
      // The first search already succeeded; losing the broader one is not worth failing over.
    }
  }

  const out: GeoResult[] = [];
  const seenLabels = new Set<string>();
  for (const r of rows
    .filter((r) => r.lat && r.lon)
    .sort(
      (a, b) =>
        queryMatch(a, q) - queryMatch(b, q) ||
        placeRank(a) - placeRank(b) ||
        (b.importance ?? 0) - (a.importance ?? 0),
    )) {
    const label = conciseLabel(r, true);
    // The same place can come back as both a boundary and a place node. One entry per name
    // keeps the list readable and stops an identical choice appearing twice.
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    out.push({
      label,
      fullLabel: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      countryCode: (r.address?.country_code || "").toLowerCase(),
    });
    if (out.length >= 8) break;
  }
  return out;
}

export async function reverseGeocode(lat: number, lng: number): Promise<{ countryCode: string; label: string }> {
  const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Reverse geocoding failed: ${res.status}`);
  const row: NominatimRow = await res.json();
  return { countryCode: (row.address?.country_code || "").toLowerCase(), label: conciseLabel(row, false) };
}
