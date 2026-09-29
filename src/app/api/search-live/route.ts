import { NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import { ADZUNA_COUNTRIES } from "@/lib/jobs";
import { searchAllSources } from "@/lib/sources";
import { miles } from "@/lib/geo";
import { fetchLocalBusinesses, radiusMilesForAnswers } from "@/lib/localBusinesses";
import { getDriveTimes } from "@/lib/routing";
import { scoreLive } from "@/lib/scoring";
import type { Answers, DriveTime, LocationAnswer, RawListing, RoleKey } from "@/lib/types";

const PRELIM_RADIUS_MILES = 300;
const PRELIM_CAP = 50;
const HS_BUSINESS_CAP = 60;

export async function POST(req: Request) {
  const body = await req.json();
  const { answers, loc } = body as { answers: Answers; loc: LocationAnswer };

  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
    return NextResponse.json({ error: "Missing location" }, { status: 400 });
  }

  // Reverse-geocode server-side so we always search with a real place name
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

  // High schoolers: formal "internship" postings open to them are essentially nonexistent
  // on the jobs-search API this app otherwise uses (confirmed directly: searching "intern"
  // returns thousands of college/grad-targeted programs; "high school intern" returns
  // almost nothing real). So instead of searching job postings, this finds real nearby
  // businesses (via OpenStreetMap) that fit the student's interests and drafts a cold-pitch
  // email, every result here is a suggested outreach target, never a confirmed opening.
  if (answers.stage === "hs") {
    const radiusMiles = radiusMilesForAnswers(answers.max);
    const roles: RoleKey[] = (answers.role || []).filter((r): r is RoleKey => r !== "other");

    let raw: RawListing[] = [];
    try {
      raw = await fetchLocalBusinesses({ lat: loc.lat, lng: loc.lng, radiusMiles, roles, cityLabel, roleOther: answers.roleOther });
    } catch {
      return NextResponse.json({ results: [], coverage: true, coldOutreach: true, error: "Search failed" });
    }

    if (raw.length === 0) {
      return NextResponse.json({ results: [], coverage: true, coldOutreach: true, hsRadiusMiles: radiusMiles, hsCity: cityLabel });
    }

    const capped = raw
      .map((r) => ({ r, dist: miles(loc.lat, loc.lng, r.lat!, r.lng!) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, HS_BUSINESS_CAP)
      .map((x) => x.r);

    let driveTimes: (DriveTime | null)[] | undefined;
    try {
      driveTimes = await getDriveTimes(
        { lat: loc.lat, lng: loc.lng },
        capped.map((l) => ({ lat: l.lat!, lng: l.lng! })),
      );
    } catch {
      // scoreLive falls back to a straight-line estimate per listing
    }

    const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, capped, driveTimes);
    return NextResponse.json({
      results: scored,
      coverage: true,
      coldOutreach: true,
      hsRadiusMiles: radiusMiles,
      hsCity: cityLabel,
    });
  }

  let raw: RawListing[] = [];
  try {
    raw = await searchAllSources({
      countryCode,
      cityLabel,
      lat: loc.lat,
      lng: loc.lng,
      // Deliberately the same radius the prelim filter below uses, not the student's stated
      // maximum. Distance is scored, not gated, so cutting the employer boards tighter than
      // every other source would hide listings purely for coming from a board.
      maxMiles: PRELIM_RADIUS_MILES,
      wantsRemote: answers.mode === "remote",
    });
  } catch {
    return NextResponse.json({ results: [], coverage: true, error: "Search failed" });
  }

  if (raw.length === 0) {
    // Nothing found, and outside Adzuna's countries that is a coverage gap rather than a
    // genuinely empty search, which the results screen words differently.
    return NextResponse.json({ results: [], coverage: ADZUNA_COUNTRIES.has(countryCode) });
  }

  const byDistance = raw
    .map((r) => ({ r, dist: r.lat !== null && r.lng !== null ? miles(loc.lat, loc.lng, r.lat, r.lng) : null }))
    .filter((x) => x.dist === null || x.dist <= PRELIM_RADIUS_MILES)
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));

  // Taking the nearest 50 outright lets one provider own the whole shortlist. In a city where
  // Adzuna alone returns fifty listings inside a mile, every employer-board result sorts below
  // the cut and the student never sees it, even though a posting read off the company's own
  // board is the better link to apply through. Measured before this: San Francisco and Austin
  // came back 50/50 Adzuna while the boards held internships in both.
  //
  // So each provider is guaranteed a small share first, and only then is the rest filled by
  // distance. This picks candidates; scoreLive still ranks what survives, so a reserved slot
  // buys a listing consideration, not a place at the top.
  const RESERVED_PER_SOURCE = 8;
  const chosen = new Set<(typeof byDistance)[number]>();
  const perSource = new Map<string, number>();

  for (const x of byDistance) {
    const src = x.r.source ?? "Other";
    const used = perSource.get(src) ?? 0;
    if (used >= RESERVED_PER_SOURCE || chosen.size >= PRELIM_CAP) continue;
    perSource.set(src, used + 1);
    chosen.add(x);
  }
  for (const x of byDistance) {
    if (chosen.size >= PRELIM_CAP) break;
    chosen.add(x);
  }

  const prelim = byDistance.filter((x) => chosen.has(x));
  const listings = prelim.map((x) => x.r);

  let driveTimes: (DriveTime | null)[] | undefined;
  try {
    driveTimes = await getDriveTimes(
      { lat: loc.lat, lng: loc.lng },
      listings.map((l) => (l.lat === null || l.lng === null ? null : { lat: l.lat, lng: l.lng })),
    );
  } catch {
    // scoreLive falls back to a straight-line estimate per listing
  }

  const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, listings, driveTimes);
  return NextResponse.json({ results: scored, coverage: true });
}
