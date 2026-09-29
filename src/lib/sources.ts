import type { RawListing } from "./types";
import { ADZUNA_COUNTRIES, searchInternships } from "./jobs";

// Listings used to come from Adzuna alone, which let one provider decide by itself what a
// student is allowed to find. This runs several in parallel and merges them.
//
// Measured live against each candidate before any of this was written:
//   The Muse   9,886 internships behind a real level=Internship filter, no API key
//   Adzuna     the existing provider, and the only one that returns coordinates
// Tested and rejected: Arbeitnow (a German board, 5 internships in 326), Jobicy / Himalayas /
// RemoteOK / WeWorkRemotely (remote only, 0-1 internships between them), CareerOneStop and
// SmartRecruiters' search (dead endpoints), USAJOBS (401, needs a free key).

const PHOTON = "https://photon.komoot.io/api";
const MUSE = "https://www.themuse.com/api/public/jobs";
const UA = "internship-nest/1.0 (+https://internship-nest.vercel.app)";

// Adzuna hands back lat/lng; nobody else does, they give strings like "Bellevue, Washington".
// Distance ranking is the entire product, so those have to be resolved. Nominatim's usage
// policy is one request per second, which would spend 15s inside a single search. Photon
// answered 16 places in parallel in 2.0s with no failures and no key, so this uses that.
//
// The cache lives at module scope, which on Vercel means it survives for the life of a warm
// function instance. Cities repeat constantly across searches, so most lookups cost nothing.
const placeCache = new Map<string, { lat: number; lng: number } | null>();
const MAX_GEOCODES_PER_SEARCH = 20;

async function geocodeOne(place: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const res = await fetch(`${PHOTON}/?limit=1&q=${encodeURIComponent(place)}`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { features?: { geometry?: { coordinates?: number[] } }[] };
    const c = data.features?.[0]?.geometry?.coordinates;
    if (!c || c.length < 2) return null;
    return { lat: c[1], lng: c[0] };
  } catch {
    return null;
  }
}

async function geocodePlaces(places: string[]): Promise<Map<string, { lat: number; lng: number } | null>> {
  const unique = Array.from(new Set(places.filter(Boolean)));
  const missing = unique.filter((p) => !placeCache.has(p)).slice(0, MAX_GEOCODES_PER_SEARCH);
  const found = await Promise.all(missing.map(geocodeOne));
  missing.forEach((p, i) => placeCache.set(p, found[i]));
  const out = new Map<string, { lat: number; lng: number } | null>();
  for (const p of unique) out.set(p, placeCache.get(p) ?? null);
  return out;
}

interface MuseJob {
  id?: number;
  name?: string;
  contents?: string;
  company?: { name?: string };
  locations?: { name?: string }[];
  categories?: { name?: string }[];
  refs?: { landing_page?: string };
  publication_date?: string;
}

// The Muse returns descriptions as HTML. Stripping the tags rather than rendering them keeps
// every result card plain text, the same as every other source.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// "Flexible / Remote" is The Muse's own wording for a job with no fixed office, so it marks a
// remote listing rather than a place that can be geocoded.
const isRemoteLabel = (name: string) => /flexible|remote/i.test(name);

async function searchMuse(cityLabel: string): Promise<RawListing[]> {
  // Two pages is 40 listings, already more than the shortlist shows, and it keeps this inside
  // its time budget while other providers run alongside it.
  const pages = await Promise.all(
    [0, 1].map(async (page) => {
      try {
        const url = `${MUSE}?level=Internship&location=${encodeURIComponent(cityLabel)}&page=${page}`;
        const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return [] as MuseJob[];
        const data = (await res.json()) as { results?: MuseJob[] };
        return data.results ?? [];
      } catch {
        return [] as MuseJob[];
      }
    }),
  );

  const jobs = pages.flat();
  if (jobs.length === 0) return [];

  // Resolve every distinct office location in one parallel batch rather than once per listing.
  const placeOf = (j: MuseJob) => (j.locations ?? []).map((l) => l.name ?? "").find((n) => n && !isRemoteLabel(n)) ?? "";
  const coords = await geocodePlaces(jobs.map(placeOf));

  const out: RawListing[] = [];
  for (const j of jobs) {
    if (!j.id || !j.name) continue;
    const place = placeOf(j);
    const here = place ? coords.get(place) ?? null : null;
    const description = stripHtml(j.contents ?? "");
    out.push({
      id: `muse-${j.id}`,
      title: j.name,
      company: j.company?.name ?? "Company not listed",
      locationLabel: place || "Remote",
      lat: here?.lat ?? null,
      lng: here?.lng ?? null,
      description,
      category: j.categories?.[0]?.name ?? "",
      url: j.refs?.landing_page ?? "",
      salaryMin: null,
      salaryMax: null,
      salaryIsPredicted: false,
      created: j.publication_date ?? null,
      remoteGuess: place ? "onsite" : "remote",
      unpaidMentioned: /\bunpaid\b/i.test(description),
      contactEmail: null,
      source: "The Muse",
    });
  }
  return out;
}

// Two providers listing the same internship should appear once. Matched on company plus title,
// since their ids are unrelated to each other.
const dedupeKey = (l: RawListing) =>
  `${l.company.toLowerCase().replace(/[^a-z0-9]/g, "")}|${l.title.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

export async function searchAllSources(opts: { countryCode: string; cityLabel: string }): Promise<RawListing[]> {
  // Adzuna covers 18 countries; The Muse has no country filter and is overwhelmingly US.
  // Asking a provider about a place it does not cover only spends time, so each runs only
  // where it has something to say. Neither is allowed to fail the whole search.
  const [adzuna, muse] = await Promise.all([
    ADZUNA_COUNTRIES.has(opts.countryCode)
      ? searchInternships(opts).catch(() => [] as RawListing[])
      : Promise.resolve([] as RawListing[]),
    searchMuse(opts.cityLabel).catch(() => [] as RawListing[]),
  ]);

  // Adzuna first, so where both list the same role the copy with real coordinates wins.
  const merged = new Map<string, RawListing>();
  for (const l of [...adzuna.map((a) => ({ ...a, source: a.source ?? "Adzuna" })), ...muse]) {
    const key = dedupeKey(l);
    if (!merged.has(key)) merged.set(key, l);
  }
  return Array.from(merged.values());
}
