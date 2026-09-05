import type { GeoResult } from "./types";

// Free worldwide geocoding via OpenStreetMap's Nominatim (no API key, no billing).
// Usage policy requires an identifying User-Agent and asks for light traffic —
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
  address?: NominatimAddress;
}

function conciseLabel(row: NominatimRow): string {
  const a = row.address;
  const place = a?.city || a?.town || a?.village || a?.county;
  const region = a?.state || a?.country;
  if (place && region && place !== region) return `${place}, ${region}`;
  if (place) return place;
  return row.display_name.split(",").slice(0, 2).join(",").trim();
}

export async function searchPlaces(query: string): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `${NOMINATIM_BASE}/search?format=jsonv2&addressdetails=1&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status}`);
  const rows: NominatimRow[] = await res.json();
  return rows
    .filter((r) => r.lat && r.lon)
    .map((r) => ({
      label: conciseLabel(r),
      fullLabel: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      countryCode: (r.address?.country_code || "").toLowerCase(),
    }));
}

export async function reverseGeocode(lat: number, lng: number): Promise<{ countryCode: string; label: string }> {
  const url = `${NOMINATIM_BASE}/reverse?format=jsonv2&addressdetails=1&lat=${lat}&lon=${lng}`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Reverse geocoding failed: ${res.status}`);
  const row: NominatimRow = await res.json();
  return { countryCode: (row.address?.country_code || "").toLowerCase(), label: conciseLabel(row) };
}
