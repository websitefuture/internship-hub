// Checks that POST /api/search-live always answers with its own JSON inside its time budget,
// however slow the outside services are. Netlify kills a function at 60s; the route's budget
// is 50s (src/lib/deadline.ts).
//
// Every outside service is replaced by a stub on globalThis.fetch, so nothing real is called.
// Stubs honour the abort signal the way real fetch does. The clock is real, so this takes
// about two and a half minutes.
//
//   npm run test:search-budget

import { POST } from "../src/app/api/search-live/route";
import { SEARCH_BUDGET_MS } from "../src/lib/deadline";

// Placeholders so the Adzuna path runs (into a stub) instead of bailing out on missing keys.
process.env.ADZUNA_APP_ID ??= "test-only";
process.env.ADZUNA_APP_KEY ??= "test-only";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
let route: Handler = () => Promise.reject(new Error("no scenario running"));
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
  route(input instanceof Request ? input.url : String(input), init)) as typeof fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Resolves after `ms`, or rejects as soon as the caller's signal aborts, like a real request.
function after(ms: number, init: RequestInit | undefined, make: () => Response): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => resolve(make()), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}
const hang = (init?: RequestInit) => after(1_000_000_000, init, () => json({}));

const place = (city: string, state: string) => ({
  address: { city, state, country_code: "us" },
  display_name: `${city}, ${state}, United States`,
});

function businesses(lat: number, lng: number) {
  return {
    elements: Array.from({ length: 6 }, (_, i) => ({
      type: "node",
      id: 1000 + i,
      lat: lat + i * 0.002,
      lon: lng + i * 0.002,
      tags: { name: `Test Bakery ${i}`, shop: "bakery" },
    })),
  };
}

function osrmOk(url: string) {
  const n = (new URL(url).searchParams.get("destinations") ?? "").split(";").filter(Boolean).length;
  return json({ code: "Ok", durations: [Array(n).fill(600)], distances: [Array(n).fill(8000)] });
}

const workdayPage = () =>
  json({
    jobPostings: Array.from({ length: 20 }, (_, i) => ({
      title: `Engineering Intern ${i}`,
      externalPath: `/job/Houston-TX/Engineering-Intern_${i}`,
      locationsText: "Houston, TX",
    })),
  });

interface Scenario {
  name: string;
  oldWorstSec: number; // the same stubs against the timeouts as they were, added up by hand
  lat: number;
  lng: number;
  answers: Record<string, unknown>;
  handler: () => Handler;
  expect: (body: Record<string, unknown>) => string | null;
}

const hasResults = (b: Record<string, unknown>) =>
  Array.isArray(b.results) && b.results.length > 0 ? null : "expected some results";

const scenarios: Scenario[] = [
  {
    name: "Fast services: unchanged behaviour",
    oldWorstSec: 0.3,
    lat: 41.88,
    lng: -87.63,
    answers: { stage: "hs", max: "30", role: ["retail"], how: "drive", mode: "onsite" },
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(50, init, () => json(place("Chicago", "Illinois")));
      if (url.includes("overpass")) return after(50, init, () => json(businesses(41.88, -87.63)));
      if (url.includes("project-osrm")) return after(50, init, () => osrmOk(url));
      return hang(init);
    },
    // The stubbed drive distances (8,000 m = 4.97 mi) came through, so drive times were not cut.
    expect: (b) =>
      hasResults(b) ??
      ((b.results as { d: number | null }[]).every((r) => r.d !== null && Math.abs(r.d - 4.97) < 0.01)
        ? null
        : "drive-time distances missing"),
  },
  {
    name: "High school: Overpass busy (429), slow retry, drive times hang",
    oldWorstSec: 7.5 + 5 + 26 + 15,
    lat: 37.29,
    lng: -121.95,
    answers: { stage: "hs", max: "30", role: ["retail"], how: "drive", mode: "onsite" },
    handler: () => {
      let overpassCalls = 0;
      return (url, init) => {
        if (url.includes("nominatim")) return after(7_500, init, () => json(place("Campbell", "California")));
        if (url.includes("overpass")) {
          overpassCalls += 1;
          if (overpassCalls === 1) return Promise.resolve(json({ remark: "rate limited" }, 429));
          return after(26_000, init, () => json(businesses(37.29, -121.95)));
        }
        return hang(init); // OSRM never answers
      };
    },
    // Businesses found; drive times dropped, so scoring fell back to straight-line distance.
    expect: (b) => hasResults(b) ?? (b.coldOutreach === true ? null : "expected coldOutreach"),
  },
  {
    name: "High school: Overpass never answers",
    oldWorstSec: 7.5 + 30 + 5 + 30,
    lat: 30.27,
    lng: -97.74,
    answers: { stage: "hs", max: "30", role: ["retail"], how: "drive", mode: "onsite" },
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(7_500, init, () => json(place("Austin", "Texas")));
      return hang(init);
    },
    // The first query uses its full 30s, then the retry is skipped: 12.5s left cannot cover
    // the 5s wait plus a query with a real chance (15s).
    expect: (b) =>
      Array.isArray(b.results) && b.results.length === 0 && b.error === "Search failed" && b.coldOutreach === true
        ? null
        : "expected the 'Search failed' cold-outreach shape",
  },
  {
    name: "College: slow Workday pages, other boards and drive times hang",
    oldWorstSec: 7.5 + 3 * 11.5 + 15,
    lat: 29.76,
    lng: -95.37,
    answers: { stage: "ug", max: "30", role: ["eng"], how: "drive", mode: "onsite" },
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(7_500, init, () => json(place("Houston", "Texas")));
      if (url.includes("myworkdayjobs.com") && url.endsWith("/jobs")) return after(11_500, init, workdayPage);
      return hang(init); // Adzuna, The Muse, Greenhouse, Lever, Ashby, OSRM
    },
    expect: hasResults,
  },
];

async function main() {
  console.log(`Budget ${SEARCH_BUDGET_MS / 1000}s, Netlify limit 60s\n`);
  let failed = 0;
  for (const s of scenarios) {
    route = s.handler();
    const started = Date.now();
    const res = await POST(
      new Request("http://localhost/api/search-live", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: s.answers, loc: { lat: s.lat, lng: s.lng, label: "test" } }),
      }),
    );
    const secs = (Date.now() - started) / 1000;
    const body = (await res.json()) as Record<string, unknown>;
    const problems = [
      res.status === 200 ? null : `status ${res.status}`,
      secs * 1000 < SEARCH_BUDGET_MS ? null : `took ${secs}s, over the budget`,
      s.expect(body),
    ].filter(Boolean);
    const shape = JSON.stringify({ ...body, results: `[${(body.results as unknown[])?.length ?? "?"} items]` });
    console.log(`${problems.length ? "FAIL" : "PASS"}  ${s.name}`);
    console.log(`      returned in ${secs.toFixed(1)}s (old timeouts: ~${s.oldWorstSec.toFixed(1)}s)  ${shape}`);
    for (const p of problems) console.log(`      ${p}`);
    if (problems.length) failed += 1;
  }
  console.log(failed ? `\n${failed} scenario(s) failed` : "\nAll scenarios passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
