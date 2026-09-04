import { NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import { ADZUNA_COUNTRIES, fetchFullDescriptionText, searchInternships } from "@/lib/jobs";
import { miles } from "@/lib/geo";
import { getDriveTimes } from "@/lib/routing";
import { excludesHighSchoolers, scoreLive, textIndicatesCollegeOnly } from "@/lib/scoring";
import type { Answers, DriveTime, LocationAnswer, RawListing } from "@/lib/types";

const PRELIM_RADIUS_MILES = 300;
const PRELIM_CAP = 50;
// Kept modest (rather than firing all 50 checks at once) so one student's search doesn't
// look like a scrape burst to Adzuna's own site and get soft-blocked.
const HS_VERIFY_CONCURRENCY = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(req: Request) {
  const body = await req.json();
  const { answers, loc } = body as { answers: Answers; loc: LocationAnswer };

  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
    return NextResponse.json({ error: "Missing location" }, { status: 400 });
  }

  // Reverse-geocode server-side so we always search with a real place name —
  // "your current location" (the label from the browser geolocation path) would
  // otherwise be sent straight to the jobs API as junk search text.
  let countryCode = "";
  let cityLabel = loc.label;
  try {
    const rev = await reverseGeocode(loc.lat, loc.lng);
    countryCode = rev.countryCode;
    cityLabel = rev.label;
  } catch {
    return NextResponse.json({ results: [], coverage: false });
  }

  if (!ADZUNA_COUNTRIES.has(countryCode)) {
    return NextResponse.json({ results: [], coverage: false });
  }

  let raw: RawListing[] = [];
  try {
    raw = await searchInternships({ countryCode, cityLabel });
  } catch {
    return NextResponse.json({ results: [], coverage: true, error: "Search failed" });
  }

  // Cheap first pass: drop anything that already shows a college/grad requirement in
  // the search API's own (truncated) snippet, title, or category.
  let hsBlockedCount = 0;
  let hsUnverifiedCount = 0;
  if (answers.stage === "hs") {
    const before = raw.length;
    raw = raw.filter((l) => !excludesHighSchoolers(l));
    hsBlockedCount = before - raw.length;
  }

  if (raw.length === 0) {
    return NextResponse.json({ results: [], coverage: true, hsFilteredCount: hsBlockedCount });
  }

  const prelim = raw
    .map((r) => ({ r, dist: r.lat !== null && r.lng !== null ? miles(loc.lat, loc.lng, r.lat, r.lng) : null }))
    .filter((x) => x.dist === null || x.dist <= PRELIM_RADIUS_MILES)
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))
    .slice(0, PRELIM_CAP);

  let verifiedListings = prelim.map((x) => x.r);

  // Adzuna's snippet is truncated — it often cuts off right before a "Qualifications"
  // section, which is exactly where a degree requirement tends to live (confirmed against
  // real listings that passed the cheap check above but required a degree). For a high
  // schooler we fetch each listing's full posting text and re-check against that.
  //
  // Adzuna's site blocks a meaningful share of automated fetches for its full pages —
  // confirmed this isn't about request volume or headers (still happens at low, staggered
  // concurrency with browser-like headers, from both this dev machine and the deployed
  // server's own IP), so it's not something we can reliably code around without doing
  // something closer to impersonating a real browser, which isn't the right move here.
  // Listings we DO confirm are marked "confirmed"; ones we can't load are kept but marked
  // "unverified" and flagged in the UI, rather than either hiding them (too few results
  // left to be useful) or showing them as if they were checked (dishonest either way).
  if (answers.stage === "hs" && verifiedListings.length > 0) {
    const checked = await mapWithConcurrency(verifiedListings, HS_VERIFY_CONCURRENCY, async (listing, i) => {
      // Small stagger per lane so requests land spread out rather than in one burst.
      if (i >= HS_VERIFY_CONCURRENCY) await sleep(50 + Math.random() * 100);
      const full = await fetchFullDescriptionText(listing.url);
      if (full === null) return { listing, keep: true, reason: "unverified" as const };
      return { listing, keep: !textIndicatesCollegeOnly(full), reason: "checked" as const };
    });
    verifiedListings = [];
    for (const c of checked) {
      if (c.reason === "unverified") {
        hsUnverifiedCount++;
        verifiedListings.push({ ...c.listing, hsEligibility: "unverified" });
      } else if (c.keep) {
        verifiedListings.push({ ...c.listing, hsEligibility: "confirmed" });
      } else {
        hsBlockedCount++;
      }
    }
  }

  if (verifiedListings.length === 0) {
    return NextResponse.json({
      results: [],
      coverage: true,
      hsFilteredCount: hsBlockedCount,
      hsUnverifiedCount,
    });
  }

  let driveTimes: (DriveTime | null)[] | undefined;
  try {
    driveTimes = await getDriveTimes(
      { lat: loc.lat, lng: loc.lng },
      verifiedListings.map((l) => (l.lat === null || l.lng === null ? null : { lat: l.lat, lng: l.lng })),
    );
  } catch {
    // scoreLive falls back to a straight-line estimate per listing
  }

  const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, verifiedListings, driveTimes);
  return NextResponse.json({
    results: scored,
    coverage: true,
    hsFilteredCount: hsBlockedCount,
    hsUnverifiedCount,
  });
}
