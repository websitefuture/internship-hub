import type { RawListing } from "./types";
import { ADZUNA_COUNTRIES, searchInternships } from "./jobs";
import { searchBoards } from "./boards";
import { geocodePlaces } from "./places";

// Listings used to come from Adzuna alone, which let one provider decide by itself what a
// student is allowed to find. This runs several in parallel and merges them.
//
// Measured live against each candidate before any of this was written:
//   Adzuna           the existing provider, and the only one that returns coordinates
//   The Muse         9,886 internships behind a real level=Internship filter, no API key
//   Employer boards  29 verified company boards across four applicant-tracking systems,
//                    read from the employer directly rather than an aggregator (boards.ts)
// Tested and rejected: Arbeitnow (a German board, 5 internships in 326), Jobicy / Himalayas /
// RemoteOK / WeWorkRemotely (remote only, 0-1 internships between them), CareerOneStop and
// SmartRecruiters' search (dead endpoints), USAJOBS (401 on every header form tried; its
// search genuinely requires a free key from developer.usajobs.gov).

const MUSE = "https://www.themuse.com/api/public/jobs";
const UA = "internship-nest/1.0 (+https://internship-nest.vercel.app)";

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

async function searchMuse(cityLabel: string, wantsRemote: boolean): Promise<RawListing[]> {
  // The Muse's location filter does not actually filter: asking it for "Austin, TX" returns
  // New York, San Francisco and Athens, Greece. So it is not a local source and is not
  // trusted as one; every listing it returns still gets geocoded and distance-checked like
  // any other. Where it is genuinely strong is remote postings, which have no location to
  // get wrong, so a student who asked for remote gets four pages instead of two.
  const pageNums = wantsRemote ? [0, 1, 2, 3] : [0, 1];
  const pages = await Promise.all(
    pageNums.map(async (page) => {
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

  // Resolve every distinct office location once. This is a table lookup, not a network call.
  const placeOf = (j: MuseJob) => (j.locations ?? []).map((l) => l.name ?? "").find((n) => n && !isRemoteLabel(n)) ?? "";
  const coords = geocodePlaces(jobs.map(placeOf));

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

export async function searchAllSources(opts: {
  countryCode: string;
  cityLabel: string;
  lat: number;
  lng: number;
  maxMiles: number;
  wantsRemote: boolean;
}): Promise<RawListing[]> {
  // Adzuna covers 18 countries; The Muse has no country filter and is overwhelmingly US; the
  // employer boards are US-centric but carry the listings no aggregator has. Asking a provider
  // about a place it does not cover only spends time, so each runs only where it has something
  // to say, all three at once, and none of them is allowed to fail the whole search.
  const [adzuna, muse, boards] = await Promise.all([
    ADZUNA_COUNTRIES.has(opts.countryCode)
      ? searchInternships(opts).catch(() => [] as RawListing[])
      : Promise.resolve([] as RawListing[]),
    searchMuse(opts.cityLabel, opts.wantsRemote).catch(() => [] as RawListing[]),
    searchBoards({ lat: opts.lat, lng: opts.lng, maxMiles: opts.maxMiles }).catch(() => [] as RawListing[]),
  ]);

  // Order decides which copy of a duplicate survives. Employer boards go first because a
  // listing read off the company's own board is the primary record: it is current, it links
  // to the real application page, and it has not been through an aggregator's reformatting.
  // Adzuna comes next since it is the only source carrying true coordinates.
  const merged = new Map<string, RawListing>();
  for (const l of [...boards, ...adzuna.map((a) => ({ ...a, source: a.source ?? "Adzuna" })), ...muse]) {
    const key = dedupeKey(l);
    if (!merged.has(key)) merged.set(key, l);
  }
  return Array.from(merged.values());
}
