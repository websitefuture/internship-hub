import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";
import { clientIp, DEVICE_ID_RE, visitorFromDevice, visitorFromRequest } from "@/lib/visitorId";

// The site's own page-view counter (see sql/page_views.sql). Host-agnostic on purpose: it reads
// whichever country header the current host sets, so it keeps working after a move off Vercel.
//
// No IP address is stored. The visitor id is a hash of the browser's random anonymous device id
// (or, without one, of the IP, browser and date) with a server secret, so it counts devices
// without identifying anyone.

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i;

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

// The app or browser a view came from. In-app browsers first: their user agents also say Safari
// or Chrome.
function browserOf(ua: string): string {
  if (/Instagram/i.test(ua)) return "Instagram app";
  if (/musical_ly|TikTok|BytedanceWebview/i.test(ua)) return "TikTok app";
  if (/FBAN|FBAV|FB_IAB/i.test(ua)) return "Facebook app";
  if (/Snapchat/i.test(ua)) return "Snapchat app";
  if (/Edg\//.test(ua)) return "Edge";
  if (/SamsungBrowser/.test(ua)) return "Samsung Internet";
  if (/Firefox|FxiOS/.test(ua)) return "Firefox";
  if (/CriOS|Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
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
  // The site owner, while signed in to the stats page on this browser, is never counted.
  const email = (await auth())?.user?.email?.toLowerCase();
  if (email && ADMINS.includes(email)) return new Response(null, { status: 204 });

  const deviceRaw = typeof body.device === "string" && DEVICE_ID_RE.test(body.device) ? body.device : null;
  const day = new Date().toISOString().slice(0, 10);
  const visitor = deviceRaw ? visitorFromDevice(deviceRaw) : visitorFromRequest(clientIp(h), ua, day);

  const row = {
    path,
    referrer_host: referrerHost,
    utm_source: clip(body.utm, 60)?.toLowerCase() ?? null,
    country: country(h),
    device: /mobi|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop",
    visitor,
  };
  // Which address was used (the new domain or the old vercel.app one) and which app or browser,
  // so the owner can tell real visitors from Instagram or TikTok apart from anything else.
  let { error } = await supabase
    .from("page_views")
    .insert({ ...row, site: host?.replace(/^www\./, "").slice(0, 80) ?? null, browser: browserOf(ua) });
  // Until sql/page_views.sql's newer columns exist, save the view without them.
  if (error && /site|browser/.test(error.message)) ({ error } = await supabase.from("page_views").insert(row));
  if (error) console.error("[track] insert failed:", error.code, error.message);

  return new Response(null, { status: 204 });
}
