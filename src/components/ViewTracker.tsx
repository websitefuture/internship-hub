"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Sends one beacon per page view to /api/track. No cookies. The UTM source is read from the URL
// so bio links like ?utm_source=instagram show up as "instagram" in the dashboard, since in-app
// browsers often send no referrer at all.
//
// What is NOT counted, so the dashboard reflects real visitors:
// - Automated browsers (navigator.webdriver), and scanners that open a page and leave at once:
//   a view only counts after the page has been visible for 2 seconds. A brand-new domain is
//   visited by certificate-log scanners within minutes, and they inflated the first day.
// - The site owner's own devices, after "Don't count my visits" on /admin/stats. That sets one
//   localStorage key on that device and nothing else.
export const DONT_COUNT_KEY = "nest-dont-count";
const VISIBLE_FOR_MS = 2000;

// A random, anonymous id for this browser, so one device counts as one visitor even when its
// network address changes (Wi-Fi to mobile data, or the move between hosts). It is not linked
// to a name, email or account, and never leaves the site. Without storage it is simply omitted
// and the server falls back to its per-day address-based count.
const DEVICE_KEY = "nest-device";
function deviceId(): string | null {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

// Guards against the same view being sent twice in quick succession (React runs effects twice
// in development, and a fast re-render can repeat one), which would double-count it.
let lastKey = "";
let lastAt = 0;

function excluded(): boolean {
  if (navigator.webdriver) return true;
  try {
    return localStorage.getItem(DONT_COUNT_KEY) === "1";
  } catch {
    return false;
  }
}

function send(path: string, referrer: string, utm: string | null) {
  const body = JSON.stringify({ path, referrer, utm, device: deviceId() });
  try {
    if (!navigator.sendBeacon?.("/api/track", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/track", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } });
    }
  } catch {
    // counting a view must never break the page
  }
}

export default function ViewTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin") || excluded()) return;
    const key = pathname + window.location.search;
    if (key === lastKey && Date.now() - lastAt < 2000) return;
    lastKey = key;
    lastAt = Date.now();

    // Captured now, so a later in-page change can't alter what this view is attributed to.
    const referrer = document.referrer;
    const utm = new URLSearchParams(window.location.search).get("utm_source");

    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent = false;
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible" || sent) return;
      timer = setTimeout(() => {
        if (document.visibilityState === "visible" && !sent) {
          sent = true;
          send(pathname, referrer, utm);
        }
      }, VISIBLE_FOR_MS);
    };
    arm();
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", arm);
    };
  }, [pathname]);

  return null;
}
