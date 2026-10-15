"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Sends one beacon per page view to /api/track. No cookies, nothing stored in the browser.
// The UTM source is read from the URL so bio links like ?utm_source=instagram show up as
// "instagram" in the dashboard, since in-app browsers often send no referrer at all.
// Guards against the same view being sent twice in quick succession (React runs effects twice
// in development, and a fast re-render can repeat one), which would double-count it.
let lastKey = "";
let lastAt = 0;

export default function ViewTracker() {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname || pathname.startsWith("/admin")) return;
    const key = pathname + window.location.search;
    if (key === lastKey && Date.now() - lastAt < 2000) return;
    lastKey = key;
    lastAt = Date.now();
    const utm = new URLSearchParams(window.location.search).get("utm_source");
    const body = JSON.stringify({ path: pathname, referrer: document.referrer, utm });
    try {
      if (!navigator.sendBeacon?.("/api/track", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/track", { method: "POST", body, keepalive: true, headers: { "Content-Type": "application/json" } });
      }
    } catch {
      // counting a view must never break the page
    }
  }, [pathname]);

  return null;
}
