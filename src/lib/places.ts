import { lookupPlace, type LatLng } from "./gazetteer";

// Resolving the place names that arrive with a listing.
//
// Adzuna returns coordinates; nothing else does. The Muse gives "Bellevue, Washington" and
// employer boards give "Long Beach, CA", so those have to become coordinates before a listing
// can be ranked or filtered by distance.
//
// This used to call Photon, a free keyless geocoder. It was dropped after that endpoint began
// refusing connections outright under sustained use, failing even single sequential requests.
// A student would have seen that as an empty results page, not as an outage, which is the
// worst way for it to fail. Lookups now come from a table compiled into the bundle
// (gazetteer.ts), so they are synchronous, free, and cannot fail, rate-limit or time out.

export type Coords = LatLng;

export function geocodePlace(place: string): Coords | null {
  return lookupPlace(place);
}

/**
 * Resolve many place names at once. Kept as a batch call because callers work in listing
 * sets, and unresolved names map to null rather than being dropped, so the caller decides
 * what an unplaceable listing is worth.
 */
export function geocodePlaces(places: string[]): Map<string, Coords | null> {
  const out = new Map<string, Coords | null>();
  for (const raw of places) {
    const key = (raw || "").trim();
    if (!key || out.has(key)) continue;
    out.set(key, lookupPlace(key));
  }
  return out;
}
