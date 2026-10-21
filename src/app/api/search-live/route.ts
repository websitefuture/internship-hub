import { NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/geocode";
import { ADZUNA_COUNTRIES } from "@/lib/jobs";
import { searchAllSources } from "@/lib/sources";
import { miles } from "@/lib/geo";
import { fetchLocalBusinesses, radiusMilesForAnswers } from "@/lib/localBusinesses";
import { sanitizeElements, type OverpassElement } from "@/lib/overpass";
import { getDriveTimes } from "@/lib/routing";
import { deadLinks } from "@/lib/linkCheck";
import { Deadline, KEEPALIVE_MS, SEARCH_BUDGET_MS } from "@/lib/deadline";
import { scoreLive } from "@/lib/scoring";
import type { Answers, DriveTime, LocationAnswer, RawListing, RoleKey } from "@/lib/types";

const PRELIM_RADIUS_MILES = 300;
const PRELIM_CAP = 50;
const HS_BUSINESS_CAP = 60;

const isContactable = (r: RawListing) => Boolean(r.websiteUrl || r.phone || r.contactEmail);

export async function POST(req: Request) {
  // One clock for the whole request. The host cuts the response off at about 30s (see
  // lib/deadline.ts), and a cut-off response is not this route's own JSON, which the results
  // screen words properly. Every network call below takes its timeout from this budget, so the
  // route always answers for itself, with whatever it managed to find, before then.
  const deadline = new Deadline(SEARCH_BUDGET_MS);
  const body = await req.json();
  const { answers, loc, osm } = body as { answers: Answers; loc: LocationAnswer; osm?: unknown };

  if (!loc || typeof loc.lat !== "number" || typeof loc.lng !== "number") {
    return NextResponse.json({ error: "Missing location" }, { status: 400 });
  }

  // High-school searches: the business records the student's browser fetched from Overpass
  // (see lib/overpass.ts). Untrusted, so sanitized; absent when the browser's query failed.
  const elements = sanitizeElements(osm);
  return streamWithKeepAlive(search(answers, loc, deadline, elements));
}

// Sends the search result as JSON once it is ready, with a single space before it every
// KEEPALIVE_MS while it runs. JSON allows leading whitespace, so the client's res.json() reads
// the body unchanged. The status is committed as 200 when the first byte goes out, which is
// fine because every outcome below already has a 200 shape the results screen handles. An
// unexpected throw becomes the same "Search failed" shape, not a broken body.
function streamWithKeepAlive(work: Promise<Response>): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let done = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (!done) controller.enqueue(encoder.encode(text));
      };
      send(" ");
      timer = setInterval(() => send(" "), KEEPALIVE_MS);
      work
        .then((res) => res.text())
        .catch(() => JSON.stringify({ results: [], coverage: true, error: "Search failed" }))
        .then((json) => {
          clearInterval(timer);
          send(json);
          if (!done) controller.close();
          done = true;
        });
    },
    // The browser went away. Stop the keepalive; the search finishes and its result is dropped.
    cancel() {
      done = true;
      clearInterval(timer);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function search(answers: Answers, loc: LocationAnswer, deadline: Deadline, elements: OverpassElement[] = []): Promise<Response> {
  // Reverse-geocode server-side so we always search with a real place name
  // "your current location" (the label from the browser geolocation path) would
  // otherwise be sent straight to the jobs API as junk search text.
  let countryCode = "";
  let cityLabel = loc.label;
  try {
    const rev = await reverseGeocode(loc.lat, loc.lng, deadline);
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
      raw = await fetchLocalBusinesses({ lat: loc.lat, lng: loc.lng, radiusMiles, roles, cityLabel, roleOther: answers.roleOther, deadline, elements });
    } catch {
      return NextResponse.json({ results: [], coverage: true, coldOutreach: true, error: "Search failed" });
    }

    // A business is only worth pitching if the student can reach it. An OpenStreetMap entry with
    // no website, phone, email, or street address gives them nothing to act on; in Campbell the
    // top result was one of these ("Civil Engineering Associates", a name and a pin, nothing that
    // could be checked or contacted), so they are left out.
    raw = raw.filter((r) => isContactable(r) || r.addressIsStreet);

    if (raw.length === 0) {
      return NextResponse.json({ results: [], coverage: true, coldOutreach: true, hsRadiusMiles: radiusMiles, hsCity: cityLabel });
    }

    const capped = raw
      .map((r) => ({ r, dist: miles(loc.lat, loc.lng, r.lat!, r.lng!) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, HS_BUSINESS_CAP)
      .map((x) => x.r);

    // Drive times and the website check run side by side, each within the request's budget.
    const [driveResult, dead] = await Promise.all([
      getDriveTimes(
        { lat: loc.lat, lng: loc.lng },
        capped.map((l) => ({ lat: l.lat!, lng: l.lng! })),
        deadline,
      ).catch(() => undefined), // scoreLive falls back to a straight-line estimate per listing
      deadLinks(capped.flatMap((l) => (l.websiteUrl ? [l.websiteUrl] : [])), deadline),
    ]);
    const driveTimes: (DriveTime | null)[] | undefined = driveResult;
    for (const l of capped) if (l.websiteUrl && dead.has(l.websiteUrl)) l.websiteUrl = null;

    // Businesses with a website, phone, or email come first, in score order; the ones a student
    // could only visit in person follow. A listed website or phone is also what lets a student
    // check the business is still there before writing to it.
    const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, capped, driveTimes);
    const ranked = [...scored.filter(isContactable), ...scored.filter((r) => !isContactable(r))];
    return NextResponse.json({
      results: ranked,
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
      deadline,
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
      deadline,
    );
  } catch {
    // scoreLive falls back to a straight-line estimate per listing
  }

  const scored = scoreLive(answers, { lat: loc.lat, lng: loc.lng }, listings, driveTimes);
  return NextResponse.json({ results: scored, coverage: true });
}
