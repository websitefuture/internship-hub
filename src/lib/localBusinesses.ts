import { miles } from "./geo";
import type { RawListing, RoleKey } from "./types";
import { budgetFor, BudgetSpentError, MIN_CALL_MS, SAFETY_MARGIN_MS, type Deadline } from "./deadline";
import { buildQuery, filtersForRoles, OVERPASS_MAIN, OVERPASS_MIRROR, postOverpass, searchNominatim, type OverpassElement, type OverpassTags } from "./overpass";

// High-schooler internships essentially don't exist as formal job postings (confirmed by
// direct testing against the jobs-search API this app otherwise uses: searching "intern"
// returns thousands of college/grad-targeted programs; searching "high school intern" or
// "teen job" returns almost nothing real). Real paid/informal opportunities for teens come
// from cold-pitching actual local businesses, not from a job board, so for the high-school
// stage we search OpenStreetMap for real nearby businesses instead, and let the student pitch
// themselves. These are never confirmed openings; every result here is a suggested target,
// not a listing. The query itself lives in overpass.ts, shared with the browser.

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

// The server's own Overpass attempt (used only when the browser's failed) gets the whole budget
// left; the request's Deadline cuts it to what fits under the host's response limit.
const tierTimeoutMs = 30_000;
// Overpass reports a freed slot in roughly five seconds, so a retry waits for one rather than
// immediately spending the client's second attempt on the same refusal.
const RETRY_WAIT_MS = 5_000;
// The retry is only worth its wait if the query it buys has a real chance. This query costs
// about 17s at any radius, so a retry left with less than this is not attempted.
const MIN_RETRY_QUERY_MS = 15_000;
// Time kept back from Overpass for the Nominatim fallback (overpass.ts): enough for about five
// category queries at its one-per-second limit.
const NOMINATIM_RESERVE_MS = 7_000;
// Students in the same town search the same box, and this is also what stops the automatic
// re-run for a returning account from costing a fresh query every time they open the site.
const BUSINESS_CACHE_TTL_MS = 60 * 60 * 1000;
const businessCache = new Map<string, { at: number; elements: OverpassElement[] }>();

export { radiusMilesForAnswers, MAX_RADIUS_MILES } from "./overpass";

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

// OSM's website tag is sometimes typed without a scheme ("www.example.com"), which a link would
// treat as a path on this site.
function withScheme(url: string | undefined): string | null {
  const u = url?.trim();
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

function formatAddress(tags: OverpassTags, fallbackCity: string): string {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const city = tags["addr:city"] || fallbackCity;
  const state = tags["addr:state"];
  return [street, city, state].filter(Boolean).join(", ") || fallbackCity;
}

// After a mirror failure, the server goes straight to the main instance for a while, so later
// searches on the same server instance don't wait on a mirror that just failed.
const MIRROR_TIMEOUT_MS = 10_000;
const MIRROR_COOLDOWN_MS = 2 * 60 * 1000;
let mirrorDownUntil = 0;
const SERVER_HEADERS = { Accept: "*/*", "User-Agent": "internship-nest/1.0 (student cold-outreach finder)" };

// Asks the mirror, then the main instance. `cap` lets a caller with an overall time limit
// shorten either call, and it may throw to mean no time is left. The query is rebuilt for each
// server, so the timeout written into it matches that server's fetch timeout.
async function queryOverpass(budgetMs: number, build: (timeoutMs: number) => string, cap: (ms: number) => number = (ms) => ms): Promise<OverpassElement[]> {
  if (Date.now() >= mirrorDownUntil) {
    const mirrorMs = cap(Math.min(MIRROR_TIMEOUT_MS, budgetMs));
    try {
      return await postOverpass(OVERPASS_MIRROR, build(mirrorMs), mirrorMs, SERVER_HEADERS);
    } catch {
      mirrorDownUntil = Date.now() + MIRROR_COOLDOWN_MS;
    }
  }
  const mainMs = cap(budgetMs);
  return postOverpass(OVERPASS_MAIN, build(mainMs), mainMs, SERVER_HEADERS);
}

export async function fetchLocalBusinesses(opts: {
  lat: number;
  lng: number;
  radiusMiles: number;
  roles: RoleKey[];
  cityLabel: string;
  roleOther?: string;
  // The search request's shared time budget. Without one, every query gets its full timeout.
  deadline?: Deadline;
  // Records the student's browser already fetched from Overpass (see overpass.ts). When
  // present, the server does not query Overpass at all. Already sanitized by the route.
  elements?: OverpassElement[];
}): Promise<RawListing[]> {
  const uniqueFilters = filtersForRoles(opts.roles);
  // "Something else" has no OSM tag of its own, the search still falls back to the
  // fixed-category filters above, but the free text is worked into the label so the
  // generated description honestly reflects what the student actually typed.
  const roleNames = [...opts.roles.map((r) => ROLE_LABELS[r]), ...(opts.roleOther?.trim() ? [opts.roleOther.trim()] : [])];
  const roleLabel = roleNames.length ? roleNames.join("/") : "internship-style";

  async function runTier(radiusMiles: number): Promise<OverpassElement[]> {
    // Each server gets its own timeout, cut only if the request's budget cannot cover it at
    // the moment that server is asked. The first query starts after at most one 8s geocode
    // and a mirror attempt of at most 10s. With a 50s budget, the main instance still gets
    // its full tier timeout, up to the longest at 30s (50 - 8 - 10 - 2s margin = 30s). Only a
    // late retry can come out shorter, which is the point of the budget.
    return queryOverpass(
      tierTimeoutMs,
      (ms) => buildQuery(opts.lat, opts.lng, radiusMiles, uniqueFilters, ms),
      (ms) => {
        const capped = budgetFor(ms, opts.deadline);
        if (!opts.deadline) return capped;
        const beforeReserve = opts.deadline.remaining() - SAFETY_MARGIN_MS - NOMINATIM_RESERVE_MS;
        if (beforeReserve < MIN_CALL_MS) throw new BudgetSpentError();
        return Math.min(capped, beforeReserve);
      },
    );
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
  // when the alternative is telling a student their town is empty. Unless the request is
  // already too late for it: the wait plus a workable query must fit in what is left, or the
  // retry only pushes the function past the host's limit, which ends in an error page rather
  // than the "search failed" message the results screen knows how to show.
  const canAffordRetry = () =>
    !opts.deadline || opts.deadline.remaining() - SAFETY_MARGIN_MS - NOMINATIM_RESERVE_MS - RETRY_WAIT_MS >= MIN_RETRY_QUERY_MS;
  const cacheKey = `${opts.lat.toFixed(2)},${opts.lng.toFixed(2)},${opts.radiusMiles},${uniqueFilters.join("|")}`;
  const cached = businessCache.get(cacheKey);

  let elements: OverpassElement[];
  let fromFallback = false;
  if (opts.elements && opts.elements.length) {
    // Fetched by the student's own browser. Not cached: it only ever shapes their own results.
    elements = opts.elements;
  } else if (cached && Date.now() - cached.at < BUSINESS_CACHE_TTL_MS) {
    elements = cached.elements;
  } else {
    try {
      elements = await runTier(opts.radiusMiles);
    } catch {
      try {
        if (!canAffordRetry()) throw new Error("No time left for an Overpass retry");
        await new Promise((r) => setTimeout(r, RETRY_WAIT_MS));
        elements = await runTier(opts.radiusMiles);
      } catch {
        // A stale copy is far better than a false "there is nothing near you". These are
        // businesses; they do not move between one search and the next.
        if (cached) {
          elements = cached.elements;
        } else {
          try {
            elements = await searchNominatim(opts.lat, opts.lng, opts.radiusMiles, uniqueFilters, {
              headers: SERVER_HEADERS,
              cap: (ms) => budgetFor(ms, opts.deadline),
            });
            // A partial list: not cached, so the next search here still gets Overpass's full one.
            fromFallback = true;
          } catch {
            // Nothing is known about this area, so nothing is claimed about it. Reported as a
            // failure rather than an empty result, because telling a student there are no
            // businesses near them is a claim this search has not earned, and it sends them off
            // to widen a radius that was never the problem.
            throw new Error("Business search unavailable");
          }
        }
      }
    }
    if (!fromFallback) businessCache.set(cacheKey, { at: Date.now(), elements });
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
      description: `OpenStreetMap lists ${tags.name} as ${categoryNounPhrase(tags)} near ${opts.cityLabel}. There's no internship posting here. This is a suggested cold-outreach target based on your interest in ${roleLabel} work nearby.`,
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
      websiteUrl: withScheme(tags.website || tags["contact:website"]),
      phone: tags.phone || tags["contact:phone"] || null,
      matchTag: tag?.value ?? null,
      sourceUpdated: el.timestamp ?? null,
      addressIsStreet: Boolean(tags["addr:street"]),
      source: "OpenStreetMap",
    });
  }

  return Array.from(seen.values());
}
