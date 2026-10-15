import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// The site's own page-view counter (see sql/page_views.sql). Host-agnostic on purpose: it reads
// whichever country header the current host sets, so it keeps working after a move off Vercel.
//
// No IP address is stored. The visitor id is a hash of the browser's random anonymous device id
// (or, without one, of the IP, browser and date) with a server secret, so it counts devices
// without identifying anyone.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
const SALT = process.env.AUTH_SECRET ?? "";

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i;

function clientIp(h: Headers): string {
  return (
    h.get("x-nf-client-connection-ip") ??
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    ""
  );
}

function country(h: Headers): string | null {
  const direct = h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry") ?? h.get("x-country");
  if (direct && direct !== "XX") return direct.toUpperCase();
  const nf = h.get("x-nf-geo"); // Netlify: base64 JSON with country.code
  if (nf) {
    try {
      const geo = JSON.parse(Buffer.from(nf, "base64").toString("utf8")) as { country?: { code?: string } };
      if (geo.country?.code) return geo.country.code.toUpperCase();
    } catch {
      // unreadable geo header; country stays unknown
    }
  }
  return null;
}

function clip(s: unknown, n: number): string | null {
  return typeof s === "string" && s.trim() ? s.trim().slice(0, n) : null;
}

export async function POST(req: Request) {
  const h = req.headers;
  const ua = h.get("user-agent") ?? "";
  if (!ua || BOT.test(ua)) return new Response(null, { status: 204 });

  // Only count beacons sent by our own pages, whatever domain the site is on today.
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = h.get("origin");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) return new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  }

  let body: { path?: unknown; referrer?: unknown; utm?: unknown; device?: unknown };
  try {
    const raw = await req.text();
    if (raw.length > 2000) return new Response(null, { status: 204 });
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 204 });
  }

  const path = clip(body.path, 200);
  if (!path || !path.startsWith("/") || path.startsWith("/admin") || path.startsWith("/api")) {
    return new Response(null, { status: 204 });
  }

  let referrerHost: string | null = null;
  const ref = clip(body.referrer, 500);
  if (ref) {
    try {
      const rh = new URL(ref).host.replace(/^www\./, "");
      if (rh && rh !== host) referrerHost = rh;
    } catch {
      // not a URL; ignore
    }
  }

  // Preferred: the browser's own random device id (see ViewTracker), so one device stays one
  // visitor when its network address changes. Hashed with the server secret so the stored value
  // can't be matched back to the id in anyone's browser. Fallback for browsers without storage:
  // the old per-day hash of address and browser, which can overcount a device that switches
  // networks but stores no address either.
  const deviceRaw = typeof body.device === "string" && /^[0-9a-f-]{36}$/i.test(body.device) ? body.device : null;
  const day = new Date().toISOString().slice(0, 10);
  const visitor = deviceRaw
    ? "d" + crypto.createHash("sha256").update(`${SALT}|device|${deviceRaw}`).digest("hex").slice(0, 15)
    : crypto.createHash("sha256").update(`${SALT}|${clientIp(h)}|${ua}|${day}`).digest("hex").slice(0, 16);

  const { error } = await supabase.from("page_views").insert({
    path,
    referrer_host: referrerHost,
    utm_source: clip(body.utm, 60)?.toLowerCase() ?? null,
    country: country(h),
    device: /mobi|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop",
    visitor,
  });
  if (error) console.error("[track] insert failed:", error.code, error.message);

  return new Response(null, { status: 204 });
}
