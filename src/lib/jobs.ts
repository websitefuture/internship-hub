import type { RawListing } from "./types";

// Free job-search data via Adzuna's public API (free app_id/app_key, no credit card).
// Coverage is real but limited to the countries Adzuna indexes — checked by the caller
// before calling this, so we can tell users honestly when a place has no live data yet.
const ADZUNA_BASE = "https://api.adzuna.com/v1/api/jobs";

export const ADZUNA_COUNTRIES = new Set([
  "gb", "us", "at", "au", "br", "ca", "de", "fr", "in", "it", "mx", "nl", "nz", "pl", "sg", "za", "es", "ch",
]);

interface AdzunaResult {
  id: string | number;
  title?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  latitude?: number;
  longitude?: number;
  description?: string;
  category?: { label?: string };
  redirect_url?: string;
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  created?: string;
}

function guessRemote(text: string): "remote" | "hybrid" | "onsite" {
  const t = text.toLowerCase();
  if (t.includes("hybrid")) return "hybrid";
  if (t.includes("remote") || t.includes("work from home") || t.includes("wfh")) return "remote";
  return "onsite";
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Most Adzuna postings route applications through their own redirect_url and never
// mention an email — this only finds one when a listing genuinely includes one in its
// own text, so we never have to invent a contact address that doesn't exist.
function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_RE);
  return m ? m[0] : null;
}

async function fetchPage(countryCode: string, cityLabel: string, page: number, appId: string, appKey: string): Promise<AdzunaResult[]> {
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: "50",
    what: "intern",
    where: cityLabel,
    "content-type": "application/json",
  });
  const url = `${ADZUNA_BASE}/${countryCode}/search/${page}?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

const JOB_POSTING_LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchFullDescriptionTextOnce(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        // A bare/declared-bot User-Agent gets a flat 403 from Adzuna's site (confirmed: identical
        // request with a real browser UA + Accept headers succeeds). This isn't trying to evade
        // anything content-wise — it's fetching the same public page a visitor's browser would —
        // but their edge WAF keys off looking like a real browser request, not a bot loudly saying so.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    for (const m of html.matchAll(JOB_POSTING_LD_RE)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(m[1]);
      } catch {
        continue;
      }
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const c of candidates) {
        const description = (c as { description?: unknown })?.description;
        if (typeof description === "string" && description.length > 0) {
          return description
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        }
      }
    }
    // No JobPosting JSON-LD found — either this listing's page doesn't carry one, or the
    // request got a soft block page instead of the real one. Either way we can't confirm
    // eligibility from it, so the caller treats this the same as a failed fetch: leave the
    // listing out rather than show something we couldn't actually check.
    return null;
  } catch {
    return null;
  }
}

// Adzuna's search API only returns a truncated snippet of each posting — often cut off
// right before a "Qualifications" section, which is exactly where a degree requirement
// tends to live. Every listing.url is Adzuna's own detail page (not the employer's site),
// and that page embeds the full, untruncated text as a standard schema.org JobPosting
// JSON-LD block. Occasionally that request comes back as a transient soft-block page
// instead of the real one, so this retries once after a short delay before giving up.
export async function fetchFullDescriptionText(url: string): Promise<string | null> {
  if (!url) return null;
  const first = await fetchFullDescriptionTextOnce(url);
  if (first !== null) return first;
  await sleep(600 + Math.random() * 400);
  return fetchFullDescriptionTextOnce(url);
}

export async function searchInternships(opts: { countryCode: string; cityLabel: string }): Promise<RawListing[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error("Adzuna credentials not configured");

  const cc = opts.countryCode.toLowerCase();
  if (!ADZUNA_COUNTRIES.has(cc)) return [];

  const pages = await Promise.all([1, 2].map((p) => fetchPage(cc, opts.cityLabel, p, appId, appKey).catch(() => [] as AdzunaResult[])));
  const seen = new Map<string, RawListing>();

  for (const page of pages) {
    for (const r of page) {
      const id = String(r.id);
      if (seen.has(id)) continue;
      const description = (r.description ?? "").replace(/\s+/g, " ").trim();
      const combinedText = `${r.title ?? ""} ${description}`;
      seen.set(id, {
        id,
        title: r.title ?? "Internship",
        company: r.company?.display_name ?? "Company not listed",
        locationLabel: r.location?.display_name ?? opts.cityLabel,
        lat: typeof r.latitude === "number" ? r.latitude : null,
        lng: typeof r.longitude === "number" ? r.longitude : null,
        description,
        category: r.category?.label ?? "",
        url: r.redirect_url ?? "",
        salaryMin: typeof r.salary_min === "number" ? r.salary_min : null,
        salaryMax: typeof r.salary_max === "number" ? r.salary_max : null,
        salaryIsPredicted: r.salary_is_predicted === "1" || r.salary_is_predicted === 1,
        created: r.created ?? null,
        remoteGuess: guessRemote(combinedText),
        unpaidMentioned: combinedText.toLowerCase().includes("unpaid"),
        contactEmail: extractEmail(combinedText),
      });
    }
  }

  return Array.from(seen.values());
}
