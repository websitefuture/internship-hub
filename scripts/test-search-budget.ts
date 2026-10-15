// Checks that POST /api/search-live always answers with its own JSON, inside its time budget,
// and keeps bytes flowing while it works, however slow or broken the outside services are.
//
// Two host limits matter (see src/lib/deadline.ts): Netlify kills a function at 60s, and its
// edge drops a response that is silent for ~30s. The route has a 50s budget and streams a
// space every KEEPALIVE_MS until the JSON is ready.
//
// Every outside service is replaced by a stub on globalThis.fetch, so nothing real is called.
// Stubs honour the abort signal the way real fetch does. The clock is real. Each scenario runs
// in its own child process, so module state (caches, the Overpass mirror cooldown) can't leak
// between them, and they run in parallel: about 50s in total.
//
//   npm run test:search-budget

import { spawn } from "node:child_process";
import { POST } from "../src/app/api/search-live/route";
import { KEEPALIVE_MS, SEARCH_BUDGET_MS } from "../src/lib/deadline";

// Placeholders so the Adzuna path runs (into a stub) instead of bailing out on missing keys.
process.env.ADZUNA_APP_ID ??= "test-only";
process.env.ADZUNA_APP_KEY ??= "test-only";

const MIRROR = "overpass.private.coffee";
const MAIN = "overpass-api.de";

type Handler = (url: string, init?: RequestInit) => Promise<Response>;
const calls: Record<string, number> = {};
let route: Handler = () => Promise.reject(new Error("no scenario running"));
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const host = new URL(url).host;
  calls[host] = (calls[host] ?? 0) + 1;
  return route(url, init);
}) as typeof fetch;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const errorPage = (status: number) => new Response("<html>error</html>", { status, headers: { "content-type": "text/html" } });

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
      tags: { name: `Test Clinic ${i}`, amenity: "clinic" },
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

type Body = Record<string, unknown>;
interface Scenario {
  name: string;
  // What the same stubs cost on master (no budget, no mirror, no keepalive), added up by hand.
  // Any response silent for ~30s gets Netlify's "Inactivity Timeout" page.
  oldSec: string;
  lat: number;
  lng: number;
  answers: Record<string, unknown>;
  handler: () => Handler;
  expect: (body: Body, calls: Record<string, number>) => string | null;
}

const HS = { stage: "hs", max: "15", role: ["healthcare"], how: "drive", mode: "onsite" };
const hasResults = (b: Body) => (Array.isArray(b.results) && b.results.length > 0 ? null : "expected some results");
const searchFailed = (b: Body) =>
  Array.isArray(b.results) && b.results.length === 0 && b.error === "Search failed" && b.coldOutreach === true
    ? null
    : "expected the 'Search failed' cold-outreach shape";
const callCount = (c: Record<string, number>, mirror: number, main: number) =>
  (c[MIRROR] ?? 0) === mirror && (c[MAIN] ?? 0) === main
    ? null
    : `expected ${mirror} mirror / ${main} main Overpass calls, got ${c[MIRROR] ?? 0} / ${c[MAIN] ?? 0}`;

const scenarios: Scenario[] = [
  {
    name: "Everything fast: unchanged behaviour",
    oldSec: "0.2s",
    lat: 41.88,
    lng: -87.63,
    answers: HS,
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(50, init, () => json(place("Chicago", "Illinois")));
      if (url.includes(MIRROR)) return after(50, init, () => json(businesses(41.88, -87.63)));
      if (url.includes("project-osrm")) return after(50, init, () => osrmOk(url));
      return hang(init);
    },
    // The stubbed drive distances (8,000 m = 4.97 mi) came through, so drive times were not cut.
    expect: (b, c) =>
      hasResults(b) ??
      callCount(c, 1, 0) ??
      ((b.results as { d: number | null }[]).every((r) => r.d !== null && Math.abs(r.d - 4.97) < 0.01)
        ? null
        : "drive-time distances missing"),
  },
  {
    name: "Main instance slow (33s), mirror fast",
    oldSec: "33s, silent: inactivity page",
    lat: 30.27,
    lng: -97.74,
    answers: HS,
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(300, init, () => json(place("Austin", "Texas")));
      if (url.includes(MIRROR)) return after(900, init, () => json(businesses(30.27, -97.74)));
      if (url.includes(MAIN)) return after(33_000, init, () => json(businesses(30.27, -97.74)));
      if (url.includes("project-osrm")) return after(300, init, () => osrmOk(url));
      return hang(init);
    },
    expect: (b, c) => hasResults(b) ?? callCount(c, 1, 0),
  },
  {
    name: "Mirror 500, main busy (429) then slow retry, drive times hang",
    oldSec: "40.5s, silent: inactivity page",
    lat: 37.29,
    lng: -121.95,
    answers: HS,
    handler: () => {
      let mainCalls = 0;
      return (url, init) => {
        if (url.includes("nominatim")) return after(7_500, init, () => json(place("Campbell", "California")));
        if (url.includes(MIRROR)) return Promise.resolve(errorPage(500));
        if (url.includes(MAIN)) {
          mainCalls += 1;
          if (mainCalls === 1) return Promise.resolve(json({ remark: "rate limited" }, 429));
          return after(13_000, init, () => json(businesses(37.29, -121.95)));
        }
        return hang(init); // OSRM never answers
      };
    },
    // The retry skipped the mirror that had just failed: one mirror call, two main calls.
    expect: (b, c) => hasResults(b) ?? callCount(c, 1, 2),
  },
  {
    name: "All Overpass servers hang",
    oldSec: "56.5s, silent: inactivity page",
    lat: 32.78,
    lng: -96.8,
    answers: HS,
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(7_500, init, () => json(place("Dallas", "Texas")));
      return hang(init);
    },
    // Mirror 10s, then main with its full 22s, then no time for a retry.
    expect: (b, c) => searchFailed(b) ?? callCount(c, 1, 1),
  },
  {
    name: "All Overpass servers fail fast (500 / 503)",
    oldSec: "5.3s",
    lat: 29.42,
    lng: -98.49,
    answers: HS,
    handler: () => (url, init) => {
      if (url.includes("nominatim")) return after(300, init, () => json(place("San Antonio", "Texas")));
      if (url.includes(MIRROR)) return Promise.resolve(errorPage(500));
      if (url.includes(MAIN)) return Promise.resolve(errorPage(503));
      return hang(init);
    },
    // Still one query and one retry against the main instance, never a burst.
    expect: (b, c) => searchFailed(b) ?? callCount(c, 1, 2),
  },
  {
    name: "College: slow Workday pages, other boards and drive times hang",
    oldSec: "57s, silent: inactivity page",
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

interface Outcome {
  name: string;
  oldSec: string;
  secs: number;
  firstByteSec: number;
  maxGapSec: number;
  shape: string;
  problems: string[];
}

async function runOne(s: Scenario): Promise<Outcome> {
  route = s.handler();
  const started = Date.now();
  const res = await POST(
    new Request("http://localhost/api/search-live", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers: s.answers, loc: { lat: s.lat, lng: s.lng, label: "test" } }),
    }),
  );

  // Read the stream the way the browser receives it, timing every chunk.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let last = started;
  let firstByte = -1;
  let maxGap = 0;
  for (;;) {
    const { value, done } = await reader.read();
    const now = Date.now();
    if (done) break;
    if (firstByte < 0) firstByte = now - started;
    maxGap = Math.max(maxGap, now - last);
    last = now;
    text += decoder.decode(value, { stream: true });
  }
  const secs = (Date.now() - started) / 1000;

  const problems: string[] = [];
  let body: Body = {};
  try {
    body = JSON.parse(text) as Body; // exactly what the client's res.json() does
  } catch {
    problems.push(`body is not JSON: ${JSON.stringify(text.slice(0, 80))}`);
  }
  if (res.status !== 200) problems.push(`status ${res.status}`);
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) problems.push("content-type is not JSON");
  if (secs * 1000 >= SEARCH_BUDGET_MS) problems.push(`took ${secs}s, over the budget`);
  if (firstByte > 1000) problems.push(`first byte after ${firstByte}ms`);
  if (maxGap > KEEPALIVE_MS + 1000) problems.push(`silent for ${maxGap}ms`);
  const expected = s.expect(body, calls);
  if (expected) problems.push(expected);

  return {
    name: s.name,
    oldSec: s.oldSec,
    secs,
    firstByteSec: firstByte / 1000,
    maxGapSec: maxGap / 1000,
    shape: JSON.stringify({ ...body, results: `[${(body.results as unknown[])?.length ?? "?"} items]` }),
    problems,
  };
}

// Child: run one scenario and report it on stdout.
async function child(index: number) {
  const outcome = await runOne(scenarios[index]);
  console.log(`RESULT ${JSON.stringify(outcome)}`);
  process.exit(0);
}

// Parent: run every scenario in its own process, in parallel, and summarise.
async function parent() {
  console.log(`Budget ${SEARCH_BUDGET_MS / 1000}s, keepalive every ${KEEPALIVE_MS / 1000}s, Netlify limits 60s total / ~30s silence\n`);
  const outcomes = await Promise.all(
    scenarios.map(
      (_, i) =>
        new Promise<Outcome>((resolve) => {
          const p = spawn(process.execPath, [...process.execArgv, process.argv[1], String(i)], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          p.stdout.on("data", (d) => (out += d));
          p.on("close", () => {
            const line = out.split("\n").find((l) => l.startsWith("RESULT "));
            resolve(
              line
                ? (JSON.parse(line.slice(7)) as Outcome)
                : { name: scenarios[i].name, oldSec: "", secs: NaN, firstByteSec: NaN, maxGapSec: NaN, shape: "", problems: ["child crashed"] },
            );
          });
        }),
    ),
  );

  let failed = 0;
  for (const o of outcomes) {
    console.log(`${o.problems.length ? "FAIL" : "PASS"}  ${o.name}`);
    console.log(
      `      done in ${o.secs.toFixed(1)}s (master: ~${o.oldSec}), first byte ${o.firstByteSec.toFixed(2)}s, longest silence ${o.maxGapSec.toFixed(1)}s`,
    );
    console.log(`      ${o.shape}`);
    for (const p of o.problems) console.log(`      ${p}`);
    if (o.problems.length) failed += 1;
  }
  console.log(failed ? `\n${failed} scenario(s) failed` : "\nAll scenarios passed");
  process.exit(failed ? 1 : 0);
}

const index = process.argv[2];
(index === undefined ? parent() : child(Number(index))).catch((e) => {
  console.error(e);
  process.exit(1);
});
