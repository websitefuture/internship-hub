import crypto from "crypto";

// How a browser's anonymous device id (see components/ViewTracker.tsx) becomes the stored
// visitor value. Shared by the tracker and by the owner's "don't count my visits" cleanup, which
// must compute exactly the same value to find that device's past rows.
const SALT = process.env.AUTH_SECRET ?? "";

export const DEVICE_ID_RE = /^[0-9a-f-]{36}$/i;

export function visitorFromDevice(deviceId: string): string {
  return "d" + crypto.createHash("sha256").update(`${SALT}|device|${deviceId}`).digest("hex").slice(0, 15);
}

// Fallback for browsers without storage: per-day hash of address and browser. Can't be linked to
// a device across days, by design.
export function visitorFromRequest(ip: string, ua: string, day: string): string {
  return crypto.createHash("sha256").update(`${SALT}|${ip}|${ua}|${day}`).digest("hex").slice(0, 16);
}
