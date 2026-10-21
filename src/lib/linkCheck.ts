import { budgetFor, type Deadline } from "./deadline";

// Business websites come from OpenStreetMap, typed in by volunteers, sometimes years ago. Checked
// from Campbell, California on 2026-10-20, two of the ten top results linked to dead sites: one
// redirected to a 404 page, the other had an expired certificate and a 404 behind it. A student
// should not be handed a link that goes nowhere, so each one is opened before it is shown.
//
// Only a link that is plainly dead is dropped: a 404 or 410, or a site that cannot be reached at
// all (no such host, refused, a broken certificate). Anything else is kept, including a slow site
// and a 403, because large stores answer bots with a challenge page (Micro Center's does) while
// the same page opens fine in a student's browser.

const CHECK_TIMEOUT_MS = 4_000;
const MAX_REDIRECTS = 3;

// The URLs can arrive from the browser (see overpass.ts), so the server only ever opens public
// web addresses: never a bare IP, a local name, or a port of the caller's choosing.
function isPublicWebUrl(u: URL): boolean {
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.port && u.port !== "80" && u.port !== "443") return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  return true;
}

async function isDead(url: string, deadline?: Deadline): Promise<boolean> {
  let current: URL;
  try {
    current = new URL(url);
  } catch {
    return true;
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isPublicWebUrl(current)) return hop === 0;
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; internship-nest link check)", Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(budgetFor(CHECK_TIMEOUT_MS, deadline)),
      });
    } catch (err) {
      // Out of time says nothing about the site; anything else means it could not be reached.
      const name = (err as Error).name;
      return name !== "TimeoutError" && name !== "AbortError" && name !== "BudgetSpentError";
    }
    await res.body?.cancel().catch(() => {});
    const next = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && next) {
      try {
        current = new URL(next, current);
      } catch {
        return true;
      }
      continue;
    }
    return res.status === 404 || res.status === 410;
  }
  return false;
}

// The set of URLs (from those given) that are dead. Checked all at once, each within the
// request's remaining budget.
export async function deadLinks(urls: string[], deadline?: Deadline): Promise<Set<string>> {
  const unique = Array.from(new Set(urls));
  const results = await Promise.all(unique.map((u) => isDead(u, deadline).catch(() => false)));
  return new Set(unique.filter((_, i) => results[i]));
}
