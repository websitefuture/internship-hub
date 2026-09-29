import { miles } from "./geo";
import type { RawListing, RoleKey } from "./types";

// High-schooler internships essentially don't exist as formal job postings (confirmed by
// direct testing against the jobs-search API this app otherwise uses: searching "intern"
// returns thousands of college/grad-targeted programs; searching "high school intern" or
// "teen job" returns almost nothing real). Real paid/informal opportunities for teens come
// from cold-pitching actual local businesses, not from a job board, so for the high-school
// stage we search OpenStreetMap for real nearby businesses instead, and let the student pitch
// themselves. These are never confirmed openings; every result here is a suggested target,
// not a listing.
//
// Each filter matches specific tag VALUES via regex, never a bare tag-presence filter like
// ["shop"], tested directly against Overpass's public instance: a bare presence filter (which
// has to scan every subtype of that tag) reliably timed out once combined with even one more
// filter, while a handful of regex-narrowed value filters stayed fast. This also keeps the
// categories realistic for what a teen could plausibly walk into and ask about.
// "office=it" is OSM's tag for a software/IT company, the closest real proxy this data has
// for "tech company." Design, marketing, eng, and data are the roles a student most plausibly
// wants at a tech company specifically (vs. trades/healthcare/hospitality/retail, which are
// genuinely local-business roles), so each of those includes it, on top of the role's own
// more specific category, rather than only generic non-tech offices like real estate or
// insurance agencies, which read as an obviously wrong match for "I want a design internship."
const ROLE_OSM_FILTERS: Record<RoleKey, string[]> = {
  marketing: ['["office"~"^(it|advertising_agency|marketing|newspaper|publisher)$"]'],
  ops: ['["office"~"^(it|company|consulting|financial|coworking)$"]'],
  eng: ['["office"~"^(it|engineer|telecommunication)$"]', '["shop"="computer"]'],
  design: ['["office"~"^(it|architect)$"]', '["craft"~"^(photographer|sign_maker)$"]'],
  data: ['["office"~"^(it|research)$"]'],
  trades: ['["craft"~"^(electrician|plumber|carpenter|hvac|painter|roofer|metal_construction)$"]'],
  healthcare: ['["amenity"~"^(clinic|dentist|veterinary|pharmacy)$"]'],
  hospitality: ['["amenity"~"^(restaurant|cafe|fast_food|bar|ice_cream)$"]', '["tourism"="hotel"]'],
  retail: [
    '["shop"~"^(bakery|clothes|shoes|convenience|supermarket|pet|toys|books|florist|hairdresser|beauty|bicycle|garden_centre|coffee|deli|gift|jewelry|electronics)$"]',
  ],
};

const DEFAULT_FILTERS = [
  '["shop"~"^(bakery|clothes|convenience|supermarket|pet|toys|books|florist|hairdresser|coffee|deli|gift)$"]',
  '["amenity"~"^(restaurant|cafe|fast_food)$"]',
  '["office"~"^(estate_agent|insurance|company|consulting)$"]',
];

const ROLE_LABELS: Record<RoleKey, string> = {
  marketing: "marketing",
  ops: "business operations",
  eng: "engineering/tech",
  design: "design",
  data: "data/analytics",
  trades: "the trades",
  healthcare: "healthcare",
  hospitality: "hospitality",
  retail: "retail",
};

// Overpass query cost rises fast with radius in a dense city, capped well below what the
// "how far" question allows so the search stays reliably fast, and so results stay genuinely
// nearby enough for a teen to visit or call, which matters more here than for a
// remote-friendly internship search.
export const MAX_RADIUS_MILES = 50;
// Each query gets a workable timeout of its own rather than a share of one shared budget.
// Deriving it from a remainder starved the first query: with a 13s budget the opening 10mi
// query told Overpass [timeout:11], which a dense city cannot answer in, and Austin went from
// 60 results to zero.
//
// These are generous because the public instance genuinely is slow for this query: measured
// from Campbell, California, it took 14.8s to 28.8s for the same request. Cutting them back
// does not make the search faster, it only makes it come back empty.
const tierTimeoutMs = (radiusMiles: number) => (radiusMiles <= 15 ? 22_000 : 30_000);
// Overpass reports a freed slot in roughly five seconds, so a retry waits for one rather than
// immediately spending the client's second attempt on the same refusal.
const RETRY_WAIT_MS = 5_000;
// Overpass's public instance allows very few concurrent queries per client, so the cheapest
// way to be a good citizen of it is to ask less often. Students in the same town search the
// same box, and this is also what stops the automatic re-run for a returning account from
// costing a fresh query every time they open the site.
const BUSINESS_CACHE_TTL_MS = 60 * 60 * 1000;
const businessCache = new Map<string, { at: number; elements: OverpassElement[] }>();

export function radiusMilesForAnswers(max?: string): number {
  return Math.min(parseFloat(max || "10") || 10, MAX_RADIUS_MILES);
}

interface OverpassTags {
  name?: string;
  [key: string]: string | undefined;
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  timestamp?: string;
  tags?: OverpassTags;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// Raw OSM tag values ("it", "marketing", "advertising_agency") aren't sentence-ready nouns
// used bare, a description reads as "is a it" or "is a marketing". This maps each value this
// app actually queries for to a real noun phrase; anything unmapped falls back to a
// title-cased version of the raw value, which is at least grammatically a noun.
const NOUN_PHRASES: Record<string, string> = {
  "office=it": "IT company",
  "office=engineer": "engineering firm",
  "office=telecommunication": "telecom company",
  "office=marketing": "marketing agency",
  "office=advertising_agency": "advertising agency",
  "office=newspaper": "newspaper",
  "office=publisher": "publishing company",
  "office=architect": "architecture firm",
  "office=research": "research firm",
  "office=company": "company",
  "office=estate_agent": "real estate agency",
  "office=insurance": "insurance agency",
  "office=consulting": "consulting firm",
  "office=financial": "financial services firm",
  "office=coworking": "coworking space",
  "craft=photographer": "photography studio",
  "craft=sign_maker": "sign shop",
  "craft=electrician": "electrical contractor",
  "craft=plumber": "plumbing company",
  "craft=carpenter": "carpentry shop",
  "craft=hvac": "HVAC company",
  "craft=painter": "painting company",
  "craft=roofer": "roofing company",
  "craft=metal_construction": "metal fabrication shop",
  "amenity=clinic": "clinic",
  "amenity=dentist": "dental office",
  "amenity=veterinary": "veterinary clinic",
  "amenity=pharmacy": "pharmacy",
  "amenity=restaurant": "restaurant",
  "amenity=cafe": "cafe",
  "amenity=fast_food": "fast food restaurant",
  "amenity=bar": "bar",
  "amenity=ice_cream": "ice cream shop",
  "tourism=hotel": "hotel",
  "shop=clothes": "clothing store",
  "shop=shoes": "shoe store",
  "shop=convenience": "convenience store",
  "shop=pet": "pet store",
  "shop=toys": "toy store",
  "shop=books": "bookstore",
  "shop=florist": "flower shop",
  "shop=hairdresser": "hair salon",
  "shop=beauty": "beauty salon",
  "shop=bicycle": "bike shop",
  "shop=garden_centre": "garden center",
  "shop=coffee": "coffee shop",
  "shop=gift": "gift shop",
  "shop=jewelry": "jewelry store",
  "shop=electronics": "electronics store",
  "shop=computer": "computer store",
  "shop=art": "art shop",
};

function primaryTag(tags: OverpassTags): { key: string; value: string } | null {
  for (const key of ["shop", "office", "craft", "healthcare", "amenity", "tourism"]) {
    const v = tags[key];
    if (v && v !== "yes") return { key, value: v };
  }
  return null;
}

function titleCase(value: string): string {
  const words = value.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Short label used in the UI (result title, category pill), a plain title-cased tag value
// reads fine standing alone ("Marketing", "IT"), unlike inside a sentence.
function categoryLabel(tags: OverpassTags): string {
  const tag = primaryTag(tags);
  if (!tag) return "Local business";
  if (tag.key === "office" && tag.value === "it") return "IT";
  return titleCase(tag.value);
}

// Sentence-ready noun phrase with its article, for use in generated descriptions
// e.g. "a marketing agency", "an IT company", "a bakery".
function categoryNounPhrase(tags: OverpassTags): string {
  const tag = primaryTag(tags);
  const phrase = tag ? NOUN_PHRASES[`${tag.key}=${tag.value}`] || titleCase(tag.value).toLowerCase() : "local business";
  const article = /^[aeiou]/i.test(phrase) ? "an" : "a";
  return `${article} ${phrase}`;
}

function formatAddress(tags: OverpassTags, fallbackCity: string): string {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const city = tags["addr:city"] || fallbackCity;
  const state = tags["addr:state"];
  return [street, city, state].filter(Boolean).join(", ") || fallbackCity;
}

// A bbox filter lets Overpass use its spatial index directly, tested directly against the
// public instance, this consistently ran several times faster than the equivalent "around"
// (radial) filter, which has to evaluate a precise distance check against every candidate
// before Overpass can narrow the search. The bbox is a rectangle, not a circle, so the exact
// radius is re-applied client-side afterward (see below) before anything is shown.
function buildQuery(lat: number, lng: number, radiusMiles: number, filters: string[], budgetMs: number): string {
  // Overpass's own timeout is told the time we actually have left, never more, so the server
  // gives up before our fetch does rather than us abandoning work it is still doing.
  const budget = Math.max(10, Math.floor(budgetMs / 1000) - 2);
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  const south = lat - dLat;
  const north = lat + dLat;
  const west = lng - dLng;
  const east = lng + dLng;
  const clauses = filters.map((f) => `  node${f}["name"];\n  way${f}["name"];`).join("\n");
  // No "meta". It was added to carry each record's last-edited date, on the belief that it
  // cost nothing measurable. Re-measured from Campbell, California, that was wrong: the same
  // query ran 14.8s, 19.7s and 28.8s with meta against a steady 17.0s, 16.6s and 17.1s
  // without it. The variance is what mattered, because a run past the timeout returns nothing
  // at all. Knowing a business record is old is worth less than the search finishing.
  return `[out:json][timeout:${budget}][bbox:${south},${west},${north},${east}];\n(\n${clauses}\n);\nout center 200;`;
}

export async function fetchLocalBusinesses(opts: {
  lat: number;
  lng: number;
  radiusMiles: number;
  roles: RoleKey[];
  cityLabel: string;
  roleOther?: string;
}): Promise<RawListing[]> {
  const filters = opts.roles.length ? opts.roles.flatMap((r) => ROLE_OSM_FILTERS[r] ?? []) : DEFAULT_FILTERS;
  const uniqueFilters = Array.from(new Set(filters.length ? filters : DEFAULT_FILTERS));
  // "Something else" has no OSM tag of its own, the search still falls back to the
  // fixed-category filters above, but the free text is worked into the label so the
  // generated description honestly reflects what the student actually typed.
  const roleNames = [...opts.roles.map((r) => ROLE_LABELS[r]), ...(opts.roleOther?.trim() ? [opts.roleOther.trim()] : [])];
  const roleLabel = roleNames.length ? roleNames.join("/") : "internship-style";

  async function runTier(radiusMiles: number, budgetMs: number): Promise<OverpassElement[]> {
    const params = new URLSearchParams();
    params.set("data", buildQuery(opts.lat, opts.lng, radiusMiles, uniqueFilters, budgetMs));
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: params,
      // Overpass's Apache front-end 406s requests with no Accept/User-Agent header at all.
      headers: { Accept: "*/*", "User-Agent": "internship-nest/1.0 (student cold-outreach finder)" },
      signal: AbortSignal.timeout(budgetMs),
    });
    // Deliberately thrown rather than returning []. Overpass answers 429 when its public
    // instance is out of slots and 504 when a query outruns the server's own timeout, and
    // swallowing those made a busy service indistinguishable from an empty neighbourhood:
    // the page told students "0 real businesses within 30 miles" when the truth was that
    // nobody had looked yet. The caller decides what to do with a failure.
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const body = (await res.json()) as OverpassResponse;
    return body.elements ?? [];
  }

  // One query, and at most one retry. Not two queries, and not a ladder of widening tiers.
  //
  // The tiers came first: each radius in turn, sharing a 20s budget. That starved itself,
  // because this query costs about 17s at *any* radius (the work is scanning tag filters, not
  // covering area), so the opening tier spent 18 of the 20 seconds and every later one broke
  // on the leftovers. A student got an empty page after a 20s wait. Reproduced from Campbell,
  // California: 60 businesses in 10.4s, then zero in 20.4s, same city, same answers.
  //
  // Running two radii in parallel fixed the arithmetic and then failed for a worse reason.
  // Overpass's public instance publishes its own limit, and it is small:
  //     Rate limit: 2
  //     1 slots available now.
  // Two concurrent queries claim both slots, so the app was rate-limiting itself. Measured
  // directly, that pair came back HTTP 429, and 504 on the next attempt. Half the searches
  // returned nothing.
  //
  // So: one request at a time. A failure waits for a slot and tries once more, because the
  // status endpoint reports slots freeing in about five seconds, which is worth waiting for
  // when the alternative is telling a student their town is empty.
  const cacheKey = `${opts.lat.toFixed(2)},${opts.lng.toFixed(2)},${opts.radiusMiles},${uniqueFilters.join("|")}`;
  const cached = businessCache.get(cacheKey);

  let elements: OverpassElement[];
  if (cached && Date.now() - cached.at < BUSINESS_CACHE_TTL_MS) {
    elements = cached.elements;
  } else {
    try {
      elements = await runTier(opts.radiusMiles, tierTimeoutMs(opts.radiusMiles));
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
      try {
        elements = await runTier(opts.radiusMiles, tierTimeoutMs(opts.radiusMiles));
      } catch {
        // A stale copy is far better than a false "there is nothing near you". These are
        // businesses; they do not move between one search and the next.
        if (cached) {
          elements = cached.elements;
        } else {
          // Nothing is known about this area, so nothing is claimed about it. Reported as a
          // failure rather than an empty result, because telling a student there are no
          // businesses near them is a claim this search has not earned, and it sends them off
          // to widen a radius that was never the problem.
          throw new Error("Business search unavailable");
        }
      }
    }
    businessCache.set(cacheKey, { at: Date.now(), elements });
  }

  const byKey = new Map<string, OverpassElement>();
  for (const el of elements) byKey.set(`${el.type}-${el.id}`, el);
  if (byKey.size === 0) return [];

  const seen = new Map<string, RawListing>();
  for (const el of byKey.values()) {
    const tags = el.tags;
    if (!tags?.name) continue;
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;
    if (lat === null || lon === null) continue;
    // The query itself only bounds by a rectangle (bbox), so a corner of that rectangle can be
    // meaningfully further than the requested radius, re-check the real circular distance here.
    if (miles(opts.lat, opts.lng, lat, lon) > opts.radiusMiles) continue;
    const id = `osm-${el.type}-${el.id}`;
    if (seen.has(id)) continue;

    const category = categoryLabel(tags);
    const tag = primaryTag(tags);
    seen.set(id, {
      id,
      title: category,
      company: tags.name,
      locationLabel: formatAddress(tags, opts.cityLabel),
      lat,
      lng: lon,
      description: `${tags.name} is ${categoryNounPhrase(tags)} near ${opts.cityLabel}. There's no internship posting here. This is a suggested cold-outreach target based on your interest in ${roleLabel} work nearby.`,
      category,
      url: "",
      salaryMin: null,
      salaryMax: null,
      salaryIsPredicted: false,
      created: null,
      remoteGuess: "onsite",
      unpaidMentioned: false,
      contactEmail: tags.email || tags["contact:email"] || null,
      coldOutreach: true,
      websiteUrl: tags.website || tags["contact:website"] || null,
      phone: tags.phone || tags["contact:phone"] || null,
      matchTag: tag?.value ?? null,
      sourceUpdated: el.timestamp ?? null,
      source: "OpenStreetMap",
    });
  }

  return Array.from(seen.values());
}
