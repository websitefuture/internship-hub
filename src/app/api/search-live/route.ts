import { NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import { ADZUNA_COUNTRIES, searchInternships } from "@/lib/jobs";
import { miles } from "@/lib/geo";
import { getDriveTimes } from "@/lib/routing";
import { scoreLive } from "@/lib/scoring";
import type { Answers, DriveTime, LocationAnswer, RawListing } from "@/lib/types";

const PRELIM_RADIUS_MILES = 300;
const PRELIM_CAP = 50;

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

  if (raw.length === 0) {
    return NextResponse.json({ results: [], coverage: true });
  }

  const prelim = raw
    .map((r) => ({ r, dist: r.lat !== null && r.lng !== null ? miles(loc.lat, loc.lng, r.lat, r.lng) : null }))
    .filter((x) => x.dist === null || x.dist <= PRELIM_RADIUS_MILES)
    .sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9))
    .slice(0, PRELIM_CAP);

  let driveTimes: (DriveTime | null)[] | undefined;
  try {
    driveTimes = await getDriveTimes(
      { lat: loc.lat, lng: loc.lng },
      prelim.map((x) => (x.r.lat === null || x.r.lng === null ? null : { lat: x.r.lat, lng: x.r.lng })),
    );
  } catch {
    // scoreLive falls back to a straight-line estimate per listing
  }

  const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, prelim.map((x) => x.r), driveTimes);
  return NextResponse.json({ results: scored, coverage: true });
}
