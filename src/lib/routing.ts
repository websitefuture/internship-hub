import type { DriveTime } from "./types";

// Real driving routes via OSRM's free public demo server (no API key, no billing).
// Fair-use / light-traffic only — one table request per completed questionnaire.
// Would need a self-hosted OSRM instance (or a paid provider) to handle real production traffic.
const OSRM_BASE = "https://router.project-osrm.org/table/v1/driving";

export async function getDriveTimes(
  origin: { lat: number; lng: number },
  destinations: ({ lat: number; lng: number } | null)[],
): Promise<DriveTime[]> {
  const validIndexes: number[] = [];
  const coords = [`${origin.lng},${origin.lat}`];
  destinations.forEach((d, i) => {
    if (d) {
      validIndexes.push(i);
      coords.push(`${d.lng},${d.lat}`);
    }
  });

  const results: DriveTime[] = destinations.map(() => ({ minutes: null, miles: null }));
  if (validIndexes.length === 0) return results;

  const destParam = validIndexes.map((_, i) => i + 1).join(";");
  const url = `${OSRM_BASE}/${coords.join(";")}?sources=0&destinations=${destParam}&annotations=duration,distance`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`OSRM request failed: ${res.status}`);
  const data = await res.json();
  if (data.code !== "Ok") throw new Error(`OSRM error: ${data.code}`);

  const durations: (number | null)[] = data.durations[0];
  const distances: (number | null)[] = data.distances[0];

  validIndexes.forEach((originalIndex, i) => {
    const seconds = durations[i];
    const meters = distances[i];
    results[originalIndex] = {
      minutes: seconds == null ? null : seconds / 60,
      miles: meters == null ? null : meters / 1609.344,
    };
  });

  return results;
}
