import crypto from "crypto";

// How a browser's anonymous device id (see components/ViewTracker.tsx) becomes the stored
// visitor value. Shared by the tracker and by the owner's "your own visits" cleanup on
// /admin/stats, which must compute exactly the same value to find that browser's past rows.
const SALT = process.env.AUTH_SECRET ?? "";

export const DEVICE_ID_RE = /^[0-9a-f-]{36}$/i;
// Stored visitor values are 16 lowercase hex-ish characters ("d" + 15 hex for device ids).
export const VISITOR_RE = /^[0-9a-f]{16}$/;

export function visitorFromDevice(deviceId: string): string {
  return "d" + crypto.createHash("sha256").update(`${SALT}|device|${deviceId}`).digest("hex").slice(0, 15);
}

// Fallback for browsers without storage (and every view recorded before device ids existed):
// per-day hash of address and browser. `day` is the UTC date of the view. Can't be linked to a
// device across days, by design.
export function visitorFromRequest(ip: string, ua: string, day: string): string {
  return crypto.createHash("sha256").update(`${SALT}|${ip}|${ua}|${day}`).digest("hex").slice(0, 16);
}

export function clientIp(h: Headers): string {
  return (
    h.get("x-nf-client-connection-ip") ??
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

/** Every visitor value this browser could have been stored under: its device id, plus the
 * address-and-browser hash for each UTC day from `firstDay` to today. Only matches older rows
 * made from the same network, since the address is part of that hash. */
export function ownVisitorIds(h: Headers, device: string | null, firstDay: string): string[] {
  const ids: string[] = [];
  if (device && DEVICE_ID_RE.test(device)) ids.push(visitorFromDevice(device));
  const ip = clientIp(h), ua = h.get("user-agent") ?? "";
  if (ip && ua) {
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date(firstDay + "T00:00:00Z");
    for (let i = 0; i < 400 && d.toISOString().slice(0, 10) <= today; i++, d.setUTCDate(d.getUTCDate() + 1)) {
      ids.push(visitorFromRequest(ip, ua, d.toISOString().slice(0, 10)));
    }
  }
  return ids;
}
