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
