import { miles } from "./geo";
import { radiusMilesForAnswers } from "./localBusinesses";
import type { Answers, DriveTime, LiveScoreParts, RawListing, RoleKey, ScoredListing } from "./types";

const ROLE_KEYWORDS: Record<RoleKey, string[]> = {
  marketing: ["marketing", "growth", "content", "social media", "seo", "brand", "communications"],
  ops: ["operations", "business operations", "administrative", "admin", "coordinator", "office support"],
  eng: ["software", "engineer", "developer", "programming", "it support", "technical", "web dev"],
  design: ["design", "ux", "ui", "graphic", "creative"],
  data: ["data", "analytics", "research assistant", "reporting", "business intelligence"],
  trades: ["electrician", "plumb", "carpentry", "construction", "mechanic", "technician", "hvac", "welding", "workshop", "manufactur", "machinist", "fabricat"],
  healthcare: ["health", "medical", "clinical", "nursing", "care assistant", "pharmacy", "patient"],
  hospitality: ["hospitality", "restaurant", "hotel", "food service", "catering", "chef", "kitchen", "barista", "event"],
  retail: ["retail", "sales assistant", "customer service", "cashier", "store"],
};

const BASE: Record<"commute" | "fit" | "pay" | "mode", number> = {
  commute: 35,
  fit: 35,
  pay: 15,
  mode: 15,
};

// Suburban/exurban average speed assumption used only as a fallback when live
// routing is unavailable for a listing, real drive time from getDriveTimes()
// is used whenever we have it.
const FALLBACK_MPH = 24;

// Typical ratio of transit time to driving time for a trip that isn't a dense
// city core (buses and light rail rarely run point-to-point), a documented
// estimate, not measured, because there is no free worldwide transit-routing API.
const TRANSIT_VS_DRIVE_MULTIPLIER = 2.3;

// A listing where the user's chosen fields have essentially nothing to do with it
// shouldn't outrank a genuinely relevant one just for being close, this scales
// continuously with role fit instead of a fixed-percentage cutoff.
const RELEVANCE_FLOOR_THRESHOLD = 0.4;
const RELEVANCE_FLOOR_MIN = 0.5;

// Cold-outreach ("hs" stage) listings are real OSM businesses, not job postings, every one of
// them shares a generic templated description that literally names the searched role (see
// localBusinesses.ts), so the keyword search in roleFit() below matches almost every result at
// the same tier and produces near-identical scores regardless of category. This table instead
// grades fit directly from the specific OSM tag that matched the search (RawListing.matchTag),
// scoring how central that exact business type is to the requested role, e.g. an IT office is
// a strong match for "eng" (it's literally the tech-company proxy) but only a weak, generic
// match for "ops" or "marketing" (included there only as a loose stand-in for "office job").
const ROLE_TAG_WEIGHTS: Partial<Record<RoleKey, Record<string, number>>> = {
  marketing: { advertising_agency: 1, marketing: 1, publisher: 0.85, newspaper: 0.85, it: 0.55 },
  ops: { consulting: 0.9, financial: 0.8, coworking: 0.75, company: 0.7, it: 0.55 },
  eng: { engineer: 1, computer: 0.9, it: 0.9, telecommunication: 0.85 },
  design: { architect: 1, photographer: 0.9, sign_maker: 0.75, it: 0.55 },
  data: { research: 1, it: 0.6 },
  trades: { electrician: 1, plumber: 1, hvac: 0.95, carpenter: 0.95, roofer: 0.9, painter: 0.85, metal_construction: 0.85 },
  healthcare: { clinic: 1, dentist: 1, veterinary: 0.9, pharmacy: 0.8 },
  hospitality: { restaurant: 1, hotel: 1, cafe: 0.9, bar: 0.85, fast_food: 0.75, ice_cream: 0.7 },
  retail: {
    clothes: 1,
    shoes: 1,
    electronics: 1,
    jewelry: 0.95,
    bicycle: 0.9,
    toys: 0.9,
    books: 0.9,
    bakery: 0.85,
    supermarket: 0.85,
    gift: 0.85,
    florist: 0.85,
    garden_centre: 0.85,
    convenience: 0.8,
    deli: 0.8,
    coffee: 0.75,
    hairdresser: 0.6,
    beauty: 0.6,
  },
};

// Businesses OSM has no tag-weight entry for (e.g. the generic default-search filters like
// "estate_agent"/"insurance") still passed the role's own search filter, so they're relevant
// enough to show, just not specifically graded, hence a moderate rather than low default.
const UNRATED_TAG_FIT = 0.5;

function coldOutreachRoleFit(roles: RoleKey[], customWords: string[], listing: RawListing): number {
  // "Something else" has no tag-weight table (the student typed free text with no OSM
  // equivalent), fall back to matching their own words against the title/description.
  if (customWords.length) {
    const title = listing.title.toLowerCase();
    const body = `${listing.category} ${listing.description}`.toLowerCase();
    if (customWords.some((w) => title.includes(w))) return 1;
    if (customWords.some((w) => body.includes(w))) return 0.6;
  }
  if (!listing.matchTag) return UNRATED_TAG_FIT;
  let best = 0;
  for (const role of roles) {
    const weight = ROLE_TAG_WEIGHTS[role]?.[listing.matchTag];
    if (weight !== undefined) best = Math.max(best, weight);
  }
  return best || UNRATED_TAG_FIT;
}

function roleFit(roles: RoleKey[], customWords: string[], listing: RawListing): number {
  const title = listing.title.toLowerCase();
  const body = `${listing.category} ${listing.description}`.toLowerCase();
  let best = 0.15; // weak baseline rather than 0, the search already filtered for "intern"
  for (const role of roles) {
    const words = ROLE_KEYWORDS[role];
    if (words.some((w) => title.includes(w))) best = Math.max(best, 1);
    else if (words.some((w) => body.includes(w))) best = Math.max(best, 0.6);
  }
  // "Something else" has no fixed keyword list, match whatever words the student typed
  // themselves instead.
  if (customWords.length) {
    if (customWords.some((w) => title.includes(w))) best = Math.max(best, 1);
    else if (customWords.some((w) => body.includes(w))) best = Math.max(best, 0.6);
  }
  return best;
}

function payFit(pref: Answers["pay"], listing: RawListing): number {
  const hasSalary = listing.salaryMin !== null || listing.salaryMax !== null;
  if (pref === "no") return 0.75;
  if (listing.unpaidMentioned) return pref === "yes" ? 0.05 : 0.3;
  if (hasSalary) return listing.salaryIsPredicted ? 0.8 : 1;
  return pref === "yes" ? 0.4 : 0.6; // salary not stated, honestly unknown, not assumed unpaid
}

function modeFit(pref: Answers["mode"], remoteGuess: RawListing["remoteGuess"]): number {
  if (!pref) return 0.6;
  if (pref === "remote") return remoteGuess === "remote" ? 1 : remoteGuess === "hybrid" ? 0.5 : 0.1;
  if (pref === "hybrid") return remoteGuess === "hybrid" ? 1 : 0.7;
  return remoteGuess === "onsite" ? 1 : remoteGuess === "hybrid" ? 0.6 : 0.2; // onsite
}

export function scoreLive(
  answers: Answers,
  origin: { lat: number; lng: number },
  listings: RawListing[],
  driveTimes?: (DriveTime | null)[],
): ScoredListing[] {
  const a = answers;
  const w = { ...BASE };
  (a.pri || []).forEach((p) => {
    if (w[p] !== undefined) w[p] += 12;
  });
  const totalWeight = Object.values(w).reduce((x, y) => x + y, 0);
  (Object.keys(w) as (keyof typeof w)[]).forEach((k) => {
    w[k] = (w[k] / totalWeight) * 100;
  });

  const maxMiles = parseFloat(a.max || "30");
  const baseTimeBudget = Math.max(4, (maxMiles / FALLBACK_MPH) * 60);
  const how = a.how || "drive";
  const pickedRoles = (a.role || []).filter((r): r is RoleKey => r !== "other");
  const roles: RoleKey[] = a.role && a.role.length ? pickedRoles : ["marketing"];
  const customWords = (a.roleOther || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);

  const out: ScoredListing[] = listings.map((listing, i) => {
    const remote = listing.lat === null || listing.lng === null;
    const dt = driveTimes?.[i];
    let d: number | null = null;
    let cs: number;

    if (listing.coldOutreach && !remote) {
      // These are real nearby businesses, not job postings reachable by any commute mode
      // and since fetchLocalBusinesses/route.ts already cap results to the requested radius,
      // driving-time-vs-budget scoring (tuned for a job search radius of up to 30mi) saturates
      // near 1 for every result: a 0.3mi and a 1mi walk are both well under budget. Score
      // distance directly as a fraction of the actual search radius instead, so "closer" keeps
      // meaning something across a cluster of businesses that are all a few minutes apart.
      d = dt?.miles ?? miles(origin.lat, origin.lng, listing.lat!, listing.lng!);
      const hsRadius = Math.max(0.5, radiusMilesForAnswers(a.max));
      cs = Math.max(0, 1 - d / hsRadius);
    } else if (remote) {
      cs = a.mode === "remote" ? 0.95 : a.mode === "hybrid" ? 0.6 : 0.2;
    } else if (how === "none" || a.mode === "remote") {
      cs = 0.15;
      d = dt?.miles ?? miles(origin.lat, origin.lng, listing.lat!, listing.lng!);
    } else {
      const driveMinutes = dt?.minutes ?? (miles(origin.lat, origin.lng, listing.lat!, listing.lng!) / FALLBACK_MPH) * 60;
      d = dt?.miles ?? miles(origin.lat, origin.lng, listing.lat!, listing.lng!);

      let t: number;
      let budget: number;
      if (how === "driven") {
        t = driveMinutes;
        budget = baseTimeBudget * 0.75; // asking someone else for a ride has a lower tolerance
      } else if (how === "transit") {
        t = driveMinutes * TRANSIT_VS_DRIVE_MULTIPLIER;
        budget = baseTimeBudget;
      } else {
        t = driveMinutes;
        budget = baseTimeBudget;
      }
      cs = t <= budget ? 1 - 0.5 * (t / budget) : Math.max(0, 0.5 - (t - budget) / budget);
    }

    const fit = listing.coldOutreach ? coldOutreachRoleFit(roles, customWords, listing) : roleFit(roles, customWords, listing);
    const pay = payFit(a.pay, listing);
    const mode = modeFit(a.mode, listing.remoteGuess);
    let s = w.commute * cs + w.fit * fit + w.pay * pay + w.mode * mode;

    const relevancePenalty =
      fit < RELEVANCE_FLOOR_THRESHOLD
        ? RELEVANCE_FLOOR_MIN + (fit / RELEVANCE_FLOOR_THRESHOLD) * (1 - RELEVANCE_FLOOR_MIN)
        : 1;
    s = s * relevancePenalty;

    const parts: LiveScoreParts = { Commute: cs, "Role fit": fit, Pay: pay, Mode: mode };
    const entries = Object.entries(parts) as [keyof LiveScoreParts, number][];
    const best = [...entries].sort((x, y) => y[1] - x[1])[0];
    const worst = [...entries].sort((x, y) => x[1] - y[1])[0];

    return { ...listing, d, s: Math.round(Math.min(100, s)), parts, best, worst };
  });

  out.sort((x, y) => y.s - x.s);
  return out;
}
