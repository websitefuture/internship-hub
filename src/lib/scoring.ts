import { miles } from "./geo";
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
// routing is unavailable for a listing — real drive time from getDriveTimes()
// is used whenever we have it.
const FALLBACK_MPH = 24;

// Typical ratio of transit time to driving time for a trip that isn't a dense
// city core (buses and light rail rarely run point-to-point) — a documented
// estimate, not measured, because there is no free worldwide transit-routing API.
const TRANSIT_VS_DRIVE_MULTIPLIER = 2.3;

// A listing where the user's chosen fields have essentially nothing to do with it
// shouldn't outrank a genuinely relevant one just for being close — this scales
// continuously with role fit instead of a fixed-percentage cutoff.
const RELEVANCE_FLOOR_THRESHOLD = 0.4;
const RELEVANCE_FLOOR_MIN = 0.5;

// Signals that a listing is explicitly scoped to college/grad students — a real
// degree requirement, not just "smart, motivated students welcome." A high schooler
// can't meet these, so listings matching any of these are dropped entirely for them
// rather than merely down-ranked (a high score they can't actually act on is worse
// than no listing at all).
const HS_INELIGIBLE_PATTERNS: RegExp[] = [
  /\bbachelor'?s?\b/i,
  /\bmaster'?s?\b/i,
  /\bphd\b/i,
  /\bdoctoral\b/i,
  /\bgraduate\b/i, // catches "graduate student", "Intern, Graduate", and Adzuna's "Graduate Jobs" category — not "undergraduate" (no word boundary before "graduate" there)
  /undergraduate/i,
  /college (junior|senior|sophomore|student)/i,
  /university student/i,
  /currently enrolled (in|at)\s+(an?\s+)?(accredited\s+)?(college|university)/i,
  /pursuing a (bachelor|master|doctoral|graduate) degree/i,
];

export function textIndicatesCollegeOnly(text: string): boolean {
  return HS_INELIGIBLE_PATTERNS.some((re) => re.test(text));
}

export function excludesHighSchoolers(listing: RawListing): boolean {
  return textIndicatesCollegeOnly(`${listing.title} ${listing.category} ${listing.description}`);
}

function roleFit(roles: RoleKey[], listing: RawListing): number {
  const title = listing.title.toLowerCase();
  const body = `${listing.category} ${listing.description}`.toLowerCase();
  let best = 0.15; // weak baseline rather than 0 — the search already filtered for "intern"
  for (const role of roles) {
    const words = ROLE_KEYWORDS[role];
    if (words.some((w) => title.includes(w))) best = Math.max(best, 1);
    else if (words.some((w) => body.includes(w))) best = Math.max(best, 0.6);
  }
  return best;
}

function payFit(pref: Answers["pay"], listing: RawListing): number {
  const hasSalary = listing.salaryMin !== null || listing.salaryMax !== null;
  if (pref === "no") return 0.75;
  if (listing.unpaidMentioned) return pref === "yes" ? 0.05 : 0.3;
  if (hasSalary) return listing.salaryIsPredicted ? 0.8 : 1;
  return pref === "yes" ? 0.4 : 0.6; // salary not stated — honestly unknown, not assumed unpaid
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
  const roles: RoleKey[] = a.role && a.role.length ? a.role : ["marketing"];

  const out: ScoredListing[] = listings.map((listing, i) => {
    const remote = listing.lat === null || listing.lng === null;
    const dt = driveTimes?.[i];
    let d: number | null = null;
    let cs: number;

    if (remote) {
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

    const fit = roleFit(roles, listing);
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
