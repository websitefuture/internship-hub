import { miles } from "./geo";
import type { RawListing, RoleKey } from "./types";

// High-schooler internships essentially don't exist as formal job postings (confirmed by
// direct testing against the jobs-search API this app otherwise uses: searching "intern"
// returns thousands of college/grad-targeted programs; searching "high school intern" or
// "teen job" returns almost nothing real). Real paid/informal opportunities for teens come
// from cold-pitching actual local businesses, not from a job board — so for the high-school
// stage we search OpenStreetMap for real nearby businesses instead, and let the student pitch
// themselves. These are never confirmed openings; every result here is a suggested target,
// not a listing.
//
// Each filter matches specific tag VALUES via regex, never a bare tag-presence filter like
// ["shop"] — tested directly against Overpass's public instance: a bare presence filter (which
// has to scan every subtype of that tag) reliably timed out once combined with even one more
// filter, while a handful of regex-narrowed value filters stayed fast. This also keeps the
// categories realistic for what a teen could plausibly walk into and ask about.
// "office=it" is OSM's tag for a software/IT company, the closest real proxy this data has
// for "tech company." Design, marketing, eng, and data are the roles a student most plausibly
// wants at a tech company specifically (vs. trades/healthcare/hospitality/retail, which are
// genuinely local-business roles), so each of those includes it — on top of the role's own
// more specific category — rather than only generic non-tech offices like real estate or
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

// Overpass query cost rises fast with radius in a dense city — capped well below what the
// "how far" question allows so the search stays reliably fast, and so results stay genuinely
// nearby enough for a teen to visit or call, which matters more here than for a
// remote-friendly internship search.
const MAX_RADIUS_MILES = 10;

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
  tags?: OverpassTags;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// Raw OSM tag values ("it", "marketing", "advertising_agency") aren't sentence-ready nouns —
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

// Short label used in the UI (result title, category pill) — a plain title-cased tag value
// reads fine standing alone ("Marketing", "IT"), unlike inside a sentence.
function categoryLabel(tags: OverpassTags): string {
  const tag = primaryTag(tags);
  if (!tag) return "Local business";
  if (tag.key === "office" && tag.value === "it") return "IT";
  return titleCase(tag.value);
}

// Sentence-ready noun phrase with its article, for use in generated descriptions —
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

// A bbox filter lets Overpass use its spatial index directly — tested directly against the
// public instance, this consistently ran several times faster than the equivalent "around"
// (radial) filter, which has to evaluate a precise distance check against every candidate
// before Overpass can narrow the search. The bbox is a rectangle, not a circle, so the exact
// radius is re-applied client-side afterward (see below) before anything is shown.
function buildQuery(lat: number, lng: number, radiusMiles: number, filters: string[]): string {
  const dLat = radiusMiles / 69;
  const dLng = radiusMiles / (69 * Math.cos((lat * Math.PI) / 180));
  const south = lat - dLat;
  const north = lat + dLat;
  const west = lng - dLng;
  const east = lng + dLng;
  const clauses = filters.map((f) => `  node${f}["name"];\n  way${f}["name"];`).join("\n");
  return `[out:json][timeout:25][bbox:${south},${west},${north},${east}];\n(\n${clauses}\n);\nout center 200;`;
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
  // "Something else" has no OSM tag of its own — the search still falls back to the
  // fixed-category filters above, but the free text is worked into the label so the
  // generated description honestly reflects what the student actually typed.
  const roleNames = [...opts.roles.map((r) => ROLE_LABELS[r]), ...(opts.roleOther?.trim() ? [opts.roleOther.trim()] : [])];
  const roleLabel = roleNames.length ? roleNames.join("/") : "internship-style";

  const query = buildQuery(opts.lat, opts.lng, opts.radiusMiles, uniqueFilters);

  let data: OverpassResponse;
  try {
    const params = new URLSearchParams();
    params.set("data", query);
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: params,
      // Overpass's Apache front-end 406s requests with no Accept/User-Agent header at all.
      headers: { Accept: "*/*", "User-Agent": "internship-hub/1.0 (student cold-outreach finder)" },
      signal: AbortSignal.timeout(28000),
    });
    if (!res.ok) return [];
    data = (await res.json()) as OverpassResponse;
  } catch {
    return [];
  }

  const seen = new Map<string, RawListing>();
  for (const el of data.elements) {
    const tags = el.tags;
    if (!tags?.name) continue;
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;
    if (lat === null || lon === null) continue;
    // The query itself only bounds by a rectangle (bbox), so a corner of that rectangle can be
    // meaningfully further than the requested radius — re-check the real circular distance here.
    if (miles(opts.lat, opts.lng, lat, lon) > opts.radiusMiles) continue;
    const id = `osm-${el.type}-${el.id}`;
    if (seen.has(id)) continue;

    const category = categoryLabel(tags);
    seen.set(id, {
      id,
      title: category,
      company: tags.name,
      locationLabel: formatAddress(tags, opts.cityLabel),
      lat,
      lng: lon,
      description: `${tags.name} is ${categoryNounPhrase(tags)} near ${opts.cityLabel}. There's no internship posting here — this is a suggested cold-outreach target based on your interest in ${roleLabel} work nearby.`,
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
    });
  }

  return Array.from(seen.values());
}
