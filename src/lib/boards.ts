import type { RawListing } from "./types";
import { geocodePlaces, type Coords } from "./places";
import { miles } from "./geo";

// Internships posted directly by employers, read from the applicant-tracking systems they
// actually use. An aggregator only carries what an employer chose to syndicate; these are
// the employer's own board, so a listing here is first-party and current.
//
// Every token below was verified live before being added, because none of these providers
// offers a cross-company search and a wrong token is indistinguishable from a company with
// no openings. Two things that measurement settled:
//
//   Guessing tenant names does not work. Of 79 guessed Workday tenants, 6 resolved: Vistra
//   is "vst", Caterpillar is "cat". Of ~180 companies probed on Greenhouse/Lever/Ashby, only
//   tech and aerospace firms use them at all; no energy, healthcare, bank, insurer, retailer
//   or manufacturer in that sample did.
//
//   So the two groups cover different ground and both are needed. The ATS boards concentrate
//   in the Bay Area and New York. The Workday tenants are where the rest of the country shows
//   up: ConocoPhillips alone posts internships in Houston, Bartlesville and Kenedy.

const UA = "internship-nest/1.0 (+https://internship-nest.vercel.app)";
const JSON_HEADERS = { "User-Agent": UA, "Content-Type": "application/json", Accept: "application/json" };

// Matches "Intern", "Internship", "Co-op". Anchored on word boundaries because a plain
// substring test also catches "International" and "Internal Audit", which inflated one
// company from 3 real internships to 13 when this was first measured.
const INTERN = /\b(intern|interns|internship|internships|co-?op)\b/i;

interface GreenhouseBoard {
  kind: "gh";
  token: string;
  name: string;
}
interface LeverBoard {
  kind: "lv";
  token: string;
  name: string;
}
interface AshbyBoard {
  kind: "ab";
  token: string;
  name: string;
}
interface WorkdayBoard {
  kind: "wd";
  tenant: string;
  host: string;
  site: string;
  name: string;
}
type Board = GreenhouseBoard | LeverBoard | AshbyBoard | WorkdayBoard;

const BOARDS: Board[] = [
  { kind: "gh", token: "rocketlab", name: "Rocket Lab" },
  { kind: "gh", token: "astranis", name: "Astranis" },
  { kind: "gh", token: "coinbase", name: "Coinbase" },
  { kind: "gh", token: "robinhood", name: "Robinhood" },
  { kind: "gh", token: "epicgames", name: "Epic Games" },
  { kind: "gh", token: "lyft", name: "Lyft" },
  { kind: "gh", token: "stripe", name: "Stripe" },
  { kind: "gh", token: "figma", name: "Figma" },
  { kind: "gh", token: "samsara", name: "Samsara" },
  { kind: "gh", token: "ginkgobioworks", name: "Ginkgo Bioworks" },
  { kind: "gh", token: "databricks", name: "Databricks" },
  { kind: "gh", token: "duolingo", name: "Duolingo" },
  { kind: "gh", token: "scaleai", name: "Scale AI" },
  { kind: "gh", token: "nuro", name: "Nuro" },
  { kind: "gh", token: "dropbox", name: "Dropbox" },
  { kind: "gh", token: "cloudflare", name: "Cloudflare" },
  { kind: "lv", token: "palantir", name: "Palantir" },
  { kind: "lv", token: "shieldai", name: "Shield AI" },
  { kind: "ab", token: "ramp", name: "Ramp" },
  { kind: "ab", token: "notion", name: "Notion" },
  // Large distributed employers. These are the ones posting outside the coasts.
  { kind: "wd", tenant: "conocophillips", host: "wd1", site: "External", name: "ConocoPhillips" },
  { kind: "wd", tenant: "oxy", host: "wd5", site: "UniversityRelations", name: "Occidental Petroleum" },
  { kind: "wd", tenant: "oxy", host: "wd5", site: "Corporate", name: "Occidental Petroleum" },
  { kind: "wd", tenant: "cat", host: "wd5", site: "CaterpillarCareers", name: "Caterpillar" },
  { kind: "wd", tenant: "3m", host: "wd1", site: "Search", name: "3M" },
  { kind: "wd", tenant: "target", host: "wd5", site: "targetcareers", name: "Target" },
  { kind: "wd", tenant: "bakerhughes", host: "wd5", site: "BakerHughes", name: "Baker Hughes" },
  { kind: "wd", tenant: "motorolasolutions", host: "wd5", site: "Careers", name: "Motorola Solutions" },
  { kind: "wd", tenant: "chevron", host: "wd5", site: "Jobs", name: "Chevron" },
];

// A posting before its description has been fetched. Greenhouse and Workday return only
// titles and locations in a list response; Lever and Ashby include the full text.
interface Posting {
  provider: string;
  company: string;
  title: string;
  place: string; // normalized for geocoding, "" when the source gave nothing placeable
  url: string;
  description: string;
  created: string | null;
  remote: boolean;
  ref:
    | { kind: "gh"; token: string; id: number }
    | { kind: "wd"; tenant: string; host: string; site: string; path: string }
    | { kind: "done" };
}

// Strings that are not places. These providers use the location field for workplace policy
// as often as for geography, and handing those to a geocoder returns confident nonsense.
const NOT_A_PLACE = /^(remote|fully remote|in-?office|hybrid|multiple locations|various|flexible|anywhere|us|usa|united states|blank)$/i;

// Board location strings arrive in at least four shapes, measured across the tokens above:
//   "Houston, TX"                            already usable
//   "US, Minnesota, Maplewood"               country first, city last
//   "1100 S Willow Ave, Cookeville,TN 38501" a street address with a zip
//   "Bellevue, WA; Menlo Park, CA"           several offices in one field
// Anything that survives this and still is not a real place fails geocoding and gets dropped,
// so the aim is to recover the common shapes, not to be exhaustive.
export function normalizePlace(raw: string): string {
  let s = (raw || "").replace(/\s+/g, " ").trim();
  if (!s) return "";

  // Several offices in one field: rank against the first rather than invent a midpoint.
  s = s.split(/[•;|]/)[0].trim();
  if (/^\d+\s+locations?$/i.test(s)) return "";

  s = s.replace(/\b\d{5}(-\d{4})?\b/g, ""); // US zip
  s = s.replace(/\([A-Z0-9]{2,}\)/g, ""); // internal site codes such as "(ZHK46)"
  s = s.replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim().replace(/,$/, "");

  const parts = s.split(",").map((p) => p.trim()).filter((p) => p && !/^blank$/i.test(p));
  if (parts.length === 0) return "";

  // "US, Minnesota, Maplewood" reads outward-in; every other shape reads inward-out.
  if (parts.length >= 3 && /^[A-Z]{2}$/.test(parts[0])) {
    return parts.slice(1).reverse().join(", ");
  }
  // A leading street number means the city sits at the end, not the start.
  if (parts.length >= 2 && /^\d/.test(parts[0])) {
    return parts.slice(-2).join(", ");
  }
  const out = parts.slice(0, 2).join(", ");
  return NOT_A_PLACE.test(out) ? "" : out;
}

// Workday puts the city in the URL path even when locationsText collapses to "5 Locations",
// so a posting that looks unplaceable in the list usually is not.
function workdayPlace(locationsText: string, externalPath: string): string {
  const direct = normalizePlace(locationsText);
  if (direct) return direct;
  const m = externalPath.match(/^\/job\/([^/]+)\//);
  if (!m) return "";
  const seg = decodeURIComponent(m[1]).replace(/-/g, " ").trim();
  // "Kenedy TX" -> "Kenedy, TX", so the geocoder reads the state as a state.
  const st = seg.match(/^(.*)\s+([A-Z]{2})$/);
  return st ? `${st[1]}, ${st[2]}` : seg;
}

// One warm Vercel instance serves many searches, and a company's board does not change minute
// to minute. Caching the list pass keeps a repeat search from re-downloading ~3 MB.
const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; posts: Posting[] }>();
const cacheKey = (b: Board) => (b.kind === "wd" ? `wd:${b.tenant}:${b.site}` : `${b.kind}:${b.token}`);

interface GhJob {
  id: number;
  title?: string;
  location?: { name?: string };
  absolute_url?: string;
  updated_at?: string;
}
interface LvJob {
  text?: string;
  categories?: { location?: string };
  hostedUrl?: string;
  createdAt?: number;
  workplaceType?: string;
  descriptionPlain?: string;
}
interface AbJob {
  title?: string;
  location?: string;
  isRemote?: boolean;
  jobUrl?: string;
  publishedAt?: string;
  descriptionPlain?: string;
}
interface WdJob {
  title?: string;
  externalPath?: string;
  locationsText?: string;
  remoteType?: string;
}

async function getJson(url: string, timeout: number): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function listBoard(b: Board): Promise<Posting[]> {
  if (b.kind === "gh") {
    // Deliberately without content=true: that response is 5-9.5 MB per company against
    // 433 KB for the plain list. Descriptions are fetched later, only for the few listings
    // that survive the distance filter.
    const d = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${b.token}/jobs`, 12000)) as { jobs?: GhJob[] };
    return (d.jobs ?? [])
      .filter((j) => INTERN.test(j.title ?? ""))
      .map((j) => ({
        provider: "Greenhouse",
        company: b.name,
        title: j.title ?? "",
        place: normalizePlace(j.location?.name ?? ""),
        url: j.absolute_url ?? "",
        description: "",
        created: j.updated_at ?? null,
        remote: /remote/i.test(j.location?.name ?? ""),
        ref: { kind: "gh", token: b.token, id: j.id },
      }));
  }

  if (b.kind === "lv") {
    const d = (await getJson(`https://api.lever.co/v0/postings/${b.token}?mode=json`, 14000)) as LvJob[];
    return (Array.isArray(d) ? d : [])
      .filter((j) => INTERN.test(j.text ?? ""))
      .map((j) => ({
        provider: "Lever",
        company: b.name,
        title: j.text ?? "",
        place: normalizePlace(j.categories?.location ?? ""),
        url: j.hostedUrl ?? "",
        description: j.descriptionPlain ?? "",
        created: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        remote: (j.workplaceType ?? "").toLowerCase() === "remote",
        ref: { kind: "done" },
      }));
  }

  if (b.kind === "ab") {
    const d = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${b.token}`, 14000)) as { jobs?: AbJob[] };
    return (d.jobs ?? [])
      .filter((j) => INTERN.test(j.title ?? ""))
      .map((j) => ({
        provider: "Ashby",
        company: b.name,
        title: j.title ?? "",
        place: normalizePlace(j.location ?? ""),
        url: j.jobUrl ?? "",
        description: j.descriptionPlain ?? "",
        created: j.publishedAt ?? null,
        remote: j.isRemote === true,
        ref: { kind: "done" },
      }));
  }

  // Workday: POST-only, paged, and its searchText is fuzzy, so the title still has to be
  // checked. Three pages is 60 hits per board, past which the matches stop being internships.
  const base = `https://${b.tenant}.${b.host}.myworkdayjobs.com/wday/cxs/${b.tenant}/${b.site}`;
  const out: Posting[] = [];
  for (let offset = 0; offset < 60; offset += 20) {
    const res = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "intern" }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) break;
    const d = (await res.json()) as { jobPostings?: WdJob[] };
    const page = d.jobPostings ?? [];
    for (const j of page) {
      if (!INTERN.test(j.title ?? "")) continue;
      const path = j.externalPath ?? "";
      out.push({
        provider: "Workday",
        company: b.name,
        title: j.title ?? "",
        place: workdayPlace(j.locationsText ?? "", path),
        url: `https://${b.tenant}.${b.host}.myworkdayjobs.com/${b.site}${path}`,
        description: "",
        created: null,
        remote: /remote/i.test(j.remoteType ?? ""),
        ref: { kind: "wd", tenant: b.tenant, host: b.host, site: b.site, path },
      });
    }
    if (page.length < 20) break;
  }
  return out;
}

async function cachedBoard(b: Board): Promise<Posting[]> {
  const key = cacheKey(b);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.posts;
  try {
    const posts = await listBoard(b);
    cache.set(key, { at: Date.now(), posts });
    return posts;
  } catch {
    // A board that is down or rate-limiting must not fail the search. Two tenants that
    // answered during testing returned 422 twenty minutes later, so this is routine, not
    // exceptional. Serving the stale copy beats serving nothing: these listings stay open
    // for weeks.
    return hit?.posts ?? [];
  }
}

// Greenhouse and Workday return descriptions as HTML. Every other source in this app is plain
// text and the result cards render text, so tags are stripped rather than sanitized.
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

// Fetch the full description, but only for listings that already passed the distance filter.
// Measured: 16 KB and ~110 ms each on Greenhouse, 7.6 KB and ~360 ms on Workday.
async function hydrate(p: Posting): Promise<Posting> {
  try {
    if (p.ref.kind === "gh") {
      const d = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${p.ref.token}/jobs/${p.ref.id}`, 9000)) as {
        content?: string;
      };
      return { ...p, description: stripHtml(d.content ?? "") };
    }
    if (p.ref.kind === "wd") {
      const r = p.ref;
      const d = (await getJson(`https://${r.tenant}.${r.host}.myworkdayjobs.com/wday/cxs/${r.tenant}/${r.site}${r.path}`, 9000)) as {
        jobPostingInfo?: { jobDescription?: string; location?: string; startDate?: string; externalUrl?: string };
      };
      const info = d.jobPostingInfo ?? {};
      return {
        ...p,
        description: stripHtml(info.jobDescription ?? ""),
        // The detail record names one city even where the list said "5 Locations".
        place: normalizePlace(info.location ?? "") || p.place,
        created: info.startDate ?? p.created,
        url: info.externalUrl ?? p.url,
      };
    }
  } catch {
    // Keep the listing. A missing description costs it some role-fit accuracy, which beats
    // dropping a real internship because one extra request timed out.
  }
  return p;
}

// How many listings get a description fetched. Past this the extra requests cost more time
// than the accuracy is worth, and the shortlist shows a fraction of them anyway.
const HYDRATE_CAP = 24;

export async function searchBoards(opts: { lat: number; lng: number; maxMiles: number; budgetMs?: number }): Promise<RawListing[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 14000);

  const lists = await Promise.all(BOARDS.map((b) => cachedBoard(b)));
  const posts = lists.flat();
  if (posts.length === 0) return [];

  // Synchronous: this is a table lookup, not a network call.
  const coords = geocodePlaces(posts.map((p) => p.place));

  // A remote posting has no coordinates by definition, so it is kept with a null distance
  // rather than discarded, and the scorer decides what it is worth to a student who did or
  // did not ask for remote.
  const placed: { p: Posting; c: Coords | null; d: number | null }[] = posts.map((p) => {
    const c = p.place ? coords.get(p.place) ?? null : null;
    const d = c ? miles(opts.lat, opts.lng, c.lat, c.lng) : null;
    return { p, c, d };
  });

  const near = placed
    .filter((x) => (x.d !== null && x.d <= opts.maxMiles) || (x.d === null && x.p.remote))
    .sort((a, b) => (a.d ?? 1e9) - (b.d ?? 1e9))
    .slice(0, HYDRATE_CAP);

  const full = Date.now() < deadline ? await Promise.all(near.map((x) => hydrate(x.p).then((p) => ({ ...x, p })))) : near;

  return full.map(({ p, c }) => ({
    id: `board-${p.provider.toLowerCase()}-${p.url}`,
    title: p.title,
    company: p.company,
    locationLabel: p.place || (p.remote ? "Remote" : "Location not listed"),
    lat: c?.lat ?? null,
    lng: c?.lng ?? null,
    description: p.description,
    category: "",
    url: p.url,
    salaryMin: null,
    salaryMax: null,
    salaryIsPredicted: false,
    created: p.created,
    remoteGuess: p.remote ? "remote" : "onsite",
    unpaidMentioned: /\bunpaid\b/i.test(p.description),
    contactEmail: null,
    source: p.provider,
  }));
}
