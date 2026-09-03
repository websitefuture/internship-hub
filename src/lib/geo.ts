const R_EARTH = 3958.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function miles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const y = Math.sin(toRad(bLng - aLng)) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLng - aLng));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Every company in a city currently shares that city's centre coordinates.
// This spreads their dots apart on the dial so they don't render as one stacked point.
export function jitter(name: string, amplitude: number): [number, number] {
  const h = hash(name);
  return [
    (((h % 1000) / 1000) - 0.5) * amplitude,
    ((((h >> 10) % 1000) / 1000) - 0.5) * amplitude,
  ];
}
