// Shared by the stats page (server) and its dashboard (browser): the time ranges, and the sums
// behind the totals, the graph, the breakdowns and the visitor list. Pure functions only, so the
// browser can recompute everything instantly when the range, metric or data changes.
import type { ChartPoint } from "@/components/StatsChart";
import type { VisitorRow } from "@/components/OwnVisits";

// Days are counted in the owner's time zone, so "today" means today for them.
export const TZ = "America/Chicago";
// The day the site's own tracker went live. Earlier days come from the Vercel import, which only
// has daily totals (no pages, sources or countries) and counts visitors once per day.
export const FIRST_TRACKED_DAY = "2026-10-15";

export const RANGES = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "3m", label: "3 months" },
  { key: "all", label: "All time" },
] as const;
export type RangeKey = (typeof RANGES)[number]["key"];
export type Metric = "visitors" | "views";

export type View = { at: string; path: string; referrer_host: string | null; utm_source: string | null; country: string | null; device: string | null; visitor: string; site?: string | null; browser?: string | null };
export type HistoryDay = { day: string; views: number; visitors: number };

// ---------------------------------------------------------------- dates (YYYY-MM-DD strings)
export const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
export const hourOf = (iso: string) => Number(new Date(iso).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }));
export function addDays(day: string, n: number) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
export const fmtDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const shortDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const fmt = (n: number) => n.toLocaleString("en-US");

/** [start, end] inclusive for a range, plus the equal-length period just before it. */
export function period(range: RangeKey, today: string, firstDay: string) {
  let start: string;
  if (range === "today") start = today;
  else if (range === "7d") start = addDays(today, -6);
  else if (range === "30d") start = addDays(today, -29);
  else if (range === "month") start = today.slice(0, 8) + "01";
  else if (range === "3m") start = addDays(today, -89);
  else start = firstDay;
  const len = daysBetween(start, today) + 1;
  return { start, end: today, prevStart: addDays(start, -len), prevEnd: addDays(start, -1), comparable: range !== "all" };
}

export type Totals = { views: number; visitors: number };

/** Views and distinct visitors between two days inclusive. Tracker visitors are distinct across
 * the whole period (one device = one visitor); imported Vercel days add their daily counts. */
export function totals(views: View[], history: HistoryDay[], start: string, end: string): Totals {
  let v = 0, h = 0;
  const seen = new Set<string>();
  for (const r of views) {
    const d = dayOf(r.at);
    if (d < start || d > end) continue;
    v++;
    seen.add(r.visitor);
  }
  for (const d of history) if (d.day >= start && d.day <= end) { v += d.views; h += d.visitors; }
  return { views: v, visitors: seen.size + h };
}

export type Point = ChartPoint;
export const longDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function series(range: RangeKey, views: View[], history: HistoryDay[], start: string, end: string): Point[] {
  if (range === "today") {
    const pts: Point[] = Array.from({ length: 24 }, (_, h) => ({
      label: h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`,
      full: "",
      views: 0,
      visitors: 0,
    }));
    const sets = pts.map(() => new Set<string>());
    for (const r of views) {
      if (dayOf(r.at) !== start) continue;
      const h = hourOf(r.at);
      pts[h].views++;
      sets[h].add(r.visitor);
    }
    pts.forEach((p, i) => { p.visitors = sets[i].size; p.full = `${p.label}, ${longDay(start)}`; });
    return pts;
  }
  const byDay = new Map<string, { views: number; set: Set<string>; hist: number }>();
  for (let d = start; d <= end; d = addDays(d, 1)) byDay.set(d, { views: 0, set: new Set(), hist: 0 });
  for (const r of views) {
    const b = byDay.get(dayOf(r.at));
    if (b) { b.views++; b.set.add(r.visitor); }
  }
  for (const h of history) {
    const b = byDay.get(h.day);
    if (b) { b.views += h.views; b.hist += h.visitors; }
  }
  return [...byDay.entries()].map(([d, b]) => {
    const visitors = b.set.size + b.hist;
    return { label: shortDay(d), full: longDay(d) + (d < FIRST_TRACKED_DAY ? " (from Vercel)" : ""), views: b.views, visitors };
  });
}

export type Row = { label: string; visitors: number; views: number };

export function breakdown(views: View[], start: string, end: string, key: (r: View) => string): Row[] {
  const m = new Map<string, { views: number; set: Set<string> }>();
  for (const r of views) {
    const d = dayOf(r.at);
    if (d < start || d > end) continue;
    const k = key(r);
    const e = m.get(k) ?? { views: 0, set: new Set<string>() };
    e.views++;
    e.set.add(r.visitor);
    m.set(k, e);
  }
  return [...m.entries()]
    .map(([label, e]) => ({ label, views: e.views, visitors: e.set.size }))
    .sort((a, b) => b.visitors - a.visitors || b.views - a.views)
    .slice(0, 10);
}

export const timeOf = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });

/** One row per visitor in the period, most page views first, for "Your own visits". */
export function visitorRows(views: View[], start: string, end: string): VisitorRow[] {
  const m = new Map<string, { rows: View[] }>();
  for (const r of views) {
    const d = dayOf(r.at);
    if (d < start || d > end) continue;
    const e = m.get(r.visitor) ?? { rows: [] };
    e.rows.push(r);
    m.set(r.visitor, e);
  }
  return [...m.entries()]
    .sort(([, a], [, b]) => b.rows.length - a.rows.length || b.rows[b.rows.length - 1].at.localeCompare(a.rows[a.rows.length - 1].at))
    .map(([id, { rows }]) => {
      const first = rows[0], last = rows[rows.length - 1];
      const src = rows.find((r) => r.utm_source || r.referrer_host);
      return {
        id,
        views: rows.length,
        device: first.device === "mobile" ? "Phone" : "Computer",
        browser: last.browser ?? null,
        oldSite: last.site ? last.site.endsWith("vercel.app") : null,
        country: first.country ? regionName(first.country) : "Unknown country",
        source: src ? (src.utm_source ?? src.referrer_host)! : "Direct",
        when: rows.length === 1 ? timeOf(first.at) : `${timeOf(first.at)} to ${timeOf(last.at)}`,
        pages: [...new Set(rows.map((r) => r.path))].slice(0, 5),
      };
    });
}

export const regionName = (() => {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return (code: string) => (code.length === 2 ? dn.of(code) ?? code : code);
  } catch {
    return (code: string) => code;
  }
})();
