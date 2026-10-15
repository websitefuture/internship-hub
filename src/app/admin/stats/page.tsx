import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";
import { loadInstagram, type IgStats } from "@/lib/instagram";
import CountMeToggle from "@/components/CountMeToggle";
import StatsChart, { type ChartPoint } from "@/components/StatsChart";

// Private traffic dashboard, laid out like Vercel's: pick a time range, pick Visitors or Page
// views for the chart, and see what drove traffic in that range. Reads the site's own tracker
// (sql/page_views.sql) plus the Vercel history imported before the move.
// Visible only to emails listed in ADMIN_EMAILS (comma separated); everyone else gets a 404.

export const metadata: Metadata = { title: "Site stats", robots: { index: false, follow: false } };

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// Days are counted in the owner's time zone, so "today" means today for them.
const TZ = "America/Chicago";
// The day the site's own tracker went live. Earlier days come from the Vercel import, which only
// has daily totals (no pages, sources or countries) and counts visitors once per day.
const FIRST_TRACKED_DAY = "2026-10-15";

const RANGES = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "month", label: "This month" },
  { key: "3m", label: "3 months" },
  { key: "all", label: "All time" },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];
type Metric = "visitors" | "views";

type View = { at: string; path: string; referrer_host: string | null; utm_source: string | null; country: string | null; device: string | null; visitor: string };
type HistoryDay = { day: string; views: number; visitors: number };

// ---------------------------------------------------------------- dates (YYYY-MM-DD strings)
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
const hourOf = (iso: string) => Number(new Date(iso).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }));
function addDays(day: string, n: number) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string) {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
}
const fmtDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const shortDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmt = (n: number) => n.toLocaleString("en-US");

/** [start, end] inclusive for a range, plus the equal-length period just before it. */
function period(range: RangeKey, today: string, firstDay: string) {
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

// ---------------------------------------------------------------- data
async function load() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const [views, history, nest] = await Promise.all([
    db.from("page_views").select("at, path, referrer_host, utm_source, country, device, visitor").order("at").limit(50000),
    db.from("vercel_history").select("day, views, visitors").order("day"),
    db.from("ig_handled").select("comment_id", { count: "exact", head: true }),
  ]);
  return {
    views: (views.data ?? []) as View[],
    history: ((history.data ?? []) as HistoryDay[]).filter((d) => d.day < FIRST_TRACKED_DAY),
    nest: nest.count ?? 0,
    error: views.error?.message ?? history.error?.message ?? null,
  };
}

type Totals = { views: number; visitors: number };

/** Views and distinct visitors between two days inclusive. Tracker visitors are distinct across
 * the whole period (one device = one visitor); imported Vercel days add their daily counts. */
function totals(views: View[], history: HistoryDay[], start: string, end: string): Totals {
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

type Point = ChartPoint;
const longDay = (d: string) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function series(range: RangeKey, views: View[], history: HistoryDay[], start: string, end: string): Point[] {
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

type Row = { label: string; visitors: number; views: number };

function breakdown(views: View[], start: string, end: string, key: (r: View) => string): Row[] {
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

const regionName = (() => {
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    return (code: string) => (code.length === 2 ? dn.of(code) ?? code : code);
  } catch {
    return (code: string) => code;
  }
})();

// ---------------------------------------------------------------- pieces
function Delta({ now, prev, show }: { now: number; prev: number; show: boolean }) {
  if (!show) return <span className="st-delta">&nbsp;</span>;
  if (prev === 0) return <span className="st-delta">{now > 0 ? "new this period" : "no change"}</span>;
  const pct = Math.round(((now - prev) / prev) * 100);
  const cls = pct > 0 ? "st-up" : pct < 0 ? "st-down" : "";
  return (
    <span className={`st-delta ${cls}`}>
      {pct > 0 ? "▲" : pct < 0 ? "▼" : ""} {Math.abs(pct)}% vs previous period
    </span>
  );
}

function Panel({ title, rows, note }: { title: string; rows: Row[]; note?: string }) {
  const max = rows[0]?.visitors || 1;
  return (
    <section className="st-card">
      <div className="st-panel-head"><h2>{title}</h2><span>Visitors</span></div>
      {rows.length === 0 ? (
        <p className="st-empty">{note ?? "Nothing in this period."}</p>
      ) : (
        <ul className="st-list">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="st-meter" style={{ width: `${Math.max(3, (r.visitors / max) * 100)}%` }} />
              <span className="st-val" title={`${r.label}: ${fmt(r.visitors)} visitors, ${fmt(r.views)} page views`}>{r.label}</span>
              <span className="st-num">{fmt(r.visitors)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const num = (n: number | null) => (n === null ? "–" : fmt(n));
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });

function Instagram({ ig }: { ig: IgStats | null }) {
  if (!ig) {
    return (
      <section className="st-card">
        <h2>Instagram</h2>
        <p className="st-empty">Not connected yet. Add the Instagram access token to the site&apos;s settings to see posts here.</p>
      </section>
    );
  }
  if (ig.error) {
    return (
      <section className="st-card">
        <h2>Instagram</h2>
        <p className="st-err">Couldn&apos;t read Instagram: {ig.error}</p>
      </section>
    );
  }
  return (
    <section className="st-card">
      <h2>Instagram: @{ig.username}</h2>
      <p className="st-note">{fmt(ig.followers)} followers. Latest {ig.posts.length} posts.</p>
      {ig.insightsMissing && (
        <p className="st-note">Views, reach, saves and shares need the insights permission on the Instagram token.</p>
      )}
      <div className="st-scroll">
        <table>
          <thead>
            <tr>
              <th>Post</th>
              <th className="st-num">Views</th>
              <th className="st-num">Reach</th>
              <th className="st-num">Likes</th>
              <th className="st-num">Comments</th>
              <th className="st-num">Saves</th>
              <th className="st-num">Shares</th>
            </tr>
          </thead>
          <tbody>
            {ig.posts.map((p) => (
              <tr key={p.id}>
                <td>
                  <a className="st-val" href={p.permalink} target="_blank" rel="noreferrer" title={p.caption}>
                    {p.caption || "(no caption)"}
                  </a>
                  <span className="st-note">{shortDate(p.timestamp)}{p.type === "REELS" ? ", reel" : ""}</span>
                </td>
                <td className="st-num">{num(p.views)}</td>
                <td className="st-num">{num(p.reach)}</td>
                <td className="st-num">{fmt(p.likes)}</td>
                <td className="st-num">{fmt(p.comments)}</td>
                <td className="st-num">{num(p.saves)}</td>
                <td className="st-num">{num(p.shares)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="st-h2b">Latest comments</h2>
      {ig.latestComments.length === 0 ? (
        <p className="st-empty">No comments yet.</p>
      ) : (
        <ul className="st-comments">
          {ig.latestComments.map((c, i) => (
            <li key={i}>
              <strong>@{c.username}</strong> {c.text}{" "}
              <a className="st-note" href={c.permalink} target="_blank" rel="noreferrer">{shortDate(c.timestamp)}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- page
export default async function StatsPage(props: PageProps<"/admin/stats">) {
  const session = await auth();
  const email = session?.user?.email?.toLowerCase();
  if (!email) {
    return (
      <main className="st-wrap">
        <style>{CSS}</style>
        <h1>Site stats</h1>
        <p><Link href="/api/auth/signin?callbackUrl=/admin/stats">Sign in with Google</Link> to continue.</p>
      </main>
    );
  }
  if (!ADMINS.includes(email)) notFound();

  const sp = await props.searchParams;
  const range: RangeKey = RANGES.some((r) => r.key === sp.range) ? (sp.range as RangeKey) : "30d";
  const metric: Metric = sp.metric === "views" ? "views" : "visitors";

  const [data, ig] = await Promise.all([load(), loadInstagram()]);
  const today = dayOf(new Date().toISOString());
  const firstDay = data.history[0]?.day ?? (data.views[0] ? dayOf(data.views[0].at) : today);
  const w = period(range, today, firstDay);

  const now = totals(data.views, data.history, w.start, w.end);
  const prev = totals(data.views, data.history, w.prevStart, w.prevEnd);
  const pts = series(range, data.views, data.history, w.start, w.end);

  const pages = breakdown(data.views, w.start, w.end, (r) => r.path);
  const sources = breakdown(data.views, w.start, w.end, (r) => r.utm_source ?? r.referrer_host ?? "Direct / unknown");
  const countries = breakdown(data.views, w.start, w.end, (r) => (r.country ? regionName(r.country) : "Unknown"));
  const devices = breakdown(data.views, w.start, w.end, (r) => (r.device === "mobile" ? "Phone" : "Computer"));
  const onlyHistory = w.end < FIRST_TRACKED_DAY;
  const partly = w.start < FIRST_TRACKED_DAY;
  const panelNote = onlyHistory ? "Breakdowns start on Oct 15, when the site began counting visits itself." : undefined;

  const href = (r: RangeKey, m: Metric) => `/admin/stats?range=${r}&metric=${m}`;
  const label = RANGES.find((r) => r.key === range)!.label;

  return (
    <main className="st-wrap">
      <style>{CSS}</style>
      <div className="st-top">
        <div>
          <h1>Site stats</h1>
          <p className="st-sub">internshipnest.com · {range === "today" ? fmtDay(today) : `${fmtDay(w.start)} to ${fmtDay(w.end)}`} · Central Time</p>
        </div>
        <nav className="st-ranges" aria-label="Time range">
          {RANGES.map((r) => (
            <Link key={r.key} href={href(r.key, metric)} scroll={false} className={r.key === range ? "st-on" : ""} aria-current={r.key === range ? "true" : undefined}>
              {r.label}
            </Link>
          ))}
        </nav>
      </div>
      {data.error && <p className="st-err">Couldn&apos;t read some data: {data.error}</p>}

      <section className="st-card st-main">
        <div className="st-metrics">
          {(["visitors", "views"] as const).map((m) => (
            <Link key={m} href={href(range, m)} scroll={false} className={`st-metric ${m === metric ? "st-on" : ""}`}>
              <span className="st-label">{m === "visitors" ? "Visitors" : "Page views"}</span>
              <span className="st-value">{fmt(now[m])}</span>
              <Delta now={now[m]} prev={prev[m]} show={w.comparable} />
              <span className="st-hint">{m === "visitors" ? "different devices" : "every page load, reloads included"}</span>
            </Link>
          ))}
        </div>
        <StatsChart pts={pts} metric={metric} />
        <p className="st-note">
          Showing {metric === "visitors" ? "visitors" : "page views"} for {label.toLowerCase()}. Move your cursor over the chart (or drag a finger on a phone) to see each day&apos;s numbers.
          {partly && " Days before Oct 15 come from Vercel and count visitors once per day."}
        </p>
      </section>

      <div className="st-grid2">
        <Panel title="Pages" rows={pages} note={panelNote} />
        <Panel title="Where visitors came from" rows={sources} note={panelNote} />
        <Panel title="Countries" rows={countries} note={panelNote} />
        <Panel title="Devices" rows={devices} note={panelNote} />
      </div>

      <section className="st-card st-row">
        <div><span className="st-label">NEST comments answered</span><span className="st-value st-small">{fmt(data.nest)}</span></div>
        <CountMeToggle />
      </section>

      <Instagram ig={ig} />
    </main>
  );
}

const CSS = `
.st-wrap { --bg:#f4f3ef; --card:#fcfcfb; --line:#e3e1da; --grid:#ecebe6; --ink:#0b0b0b; --ink2:#52514e; --ink3:#7c7a74; --accent:#eb6834; --accent-soft:rgba(235,104,52,.14); --up:#1a7f37; --down:#c0392b;
  max-width:1080px; margin:0 auto; padding:28px 16px 64px; color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
@media (prefers-color-scheme: dark) { .st-wrap { --bg:#111110; --card:#1a1a19; --line:#2c2b29; --grid:#262624; --ink:#fff; --ink2:#c3c2b7; --ink3:#8f8e86; --accent:#e8703f; --accent-soft:rgba(232,112,63,.18); --up:#3fb950; --down:#f07167; } }
.st-wrap h1 { font-size:24px; margin:0; }
.st-sub { color:var(--ink3); margin:2px 0 0; font-size:13px; }
.st-err { color:var(--down); }
.st-top { display:flex; justify-content:space-between; align-items:flex-end; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
.st-ranges { display:flex; flex-wrap:wrap; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--card); }
.st-ranges a { padding:7px 12px; font-size:13px; color:var(--ink2); text-decoration:none; border-right:1px solid var(--line); }
.st-ranges a:last-child { border-right:0; }
.st-ranges a:hover { color:var(--ink); background:var(--grid); }
.st-ranges a.st-on { background:var(--ink); color:var(--card); }
.st-card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.st-card h2 { font-size:15px; margin:0; }
.st-main { padding:0; overflow:hidden; }
.st-main .st-chart, .st-main .st-note { margin:12px 16px; }
.st-metrics { display:grid; grid-template-columns:1fr 1fr; border-bottom:1px solid var(--line); }
.st-metric { display:flex; flex-direction:column; gap:2px; padding:14px 16px; text-decoration:none; color:inherit; border-bottom:2px solid transparent; }
.st-metric + .st-metric { border-left:1px solid var(--line); }
.st-metric:hover { background:var(--grid); }
.st-metric.st-on { border-bottom-color:var(--accent); background:var(--accent-soft); }
.st-label { color:var(--ink2); font-size:13px; font-weight:600; }
.st-value { font-size:32px; font-weight:700; font-variant-numeric:tabular-nums; line-height:1.15; }
.st-small { font-size:22px; display:block; }
.st-hint { color:var(--ink3); font-size:12px; }
.st-delta { font-size:12px; color:var(--ink3); }
.st-up { color:var(--up); } .st-down { color:var(--down); }
.st-chart { width:calc(100% - 32px); height:auto; display:block; }
.st-mob { display:none; }
@media (max-width: 600px) {
  .st-desk { display:none; } .st-mob { display:block; } .st-value { font-size:26px; }
  .st-ranges { display:grid; grid-template-columns:repeat(3,1fr); width:100%; }
  .st-ranges a { text-align:center; border-bottom:1px solid var(--line); }
  .st-ranges a:nth-child(3n) { border-right:0; }
  .st-ranges a:nth-last-child(-n+3) { border-bottom:0; }
}
.st-gridline { stroke:var(--grid); }
.st-axis { font-size:11px; fill:var(--ink3); }
.st-area { fill:var(--accent-soft); }
.st-line { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; }
.st-dot { fill:var(--accent); }
.st-ichart { position:relative; margin:12px 16px; touch-action:pan-y; cursor:crosshair; user-select:none; }
.st-ichart svg { display:block; }
.st-guide { stroke:var(--ink3); stroke-width:1; stroke-dasharray:3 3; }
.st-hdot { fill:var(--accent); stroke:var(--card); stroke-width:2; }
.st-tip { position:absolute; top:0; pointer-events:none; background:var(--card); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; box-shadow:0 6px 18px rgba(0,0,0,.25); z-index:2; }
.st-tip div { display:flex; justify-content:space-between; gap:12px; color:var(--ink2); }
.st-tip b { color:var(--ink); font-variant-numeric:tabular-nums; }
.st-tip .st-tip-date { color:var(--ink3); font-size:12px; margin-bottom:4px; }
.st-tip .st-tip-on { color:var(--accent); }
.st-msg { color:var(--ink2); margin-top:4px; }
.st-countme p { margin:0; }
.st-note { color:var(--ink3); font-size:12px; }
.st-grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
.st-grid2 .st-card { margin-bottom:0; }
.st-panel-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px; }
.st-panel-head span { color:var(--ink3); font-size:12px; }
.st-list { list-style:none; margin:0; padding:0; }
.st-list li { position:relative; display:flex; justify-content:space-between; gap:12px; padding:7px 8px; font-size:14px; }
.st-list .st-meter { position:absolute; left:0; top:2px; bottom:2px; background:var(--accent-soft); border-radius:4px; }
.st-list .st-val { position:relative; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.st-list .st-num { position:relative; font-variant-numeric:tabular-nums; }
.st-empty { color:var(--ink3); font-size:14px; }
.st-row { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-top:16px; }
.st-link { background:none; border:0; padding:0; font:inherit; color:var(--accent); cursor:pointer; text-decoration:underline; }
.st-wrap table { width:100%; border-collapse:collapse; font-size:14px; }
.st-wrap th { text-align:left; color:var(--ink3); font-size:12px; font-weight:600; padding-bottom:6px; }
.st-wrap td { padding:6px 0; border-top:1px solid var(--grid); }
.st-num { text-align:right; font-variant-numeric:tabular-nums; }
.st-scroll { overflow-x:auto; margin-top:8px; }
.st-scroll table { min-width:560px; }
.st-scroll td .st-val { color:var(--ink); text-decoration:none; display:block; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.st-scroll td .st-note { display:block; }
.st-h2b { margin-top:18px !important; }
.st-comments { list-style:none; padding:0; margin:8px 0 0; font-size:14px; }
.st-comments li { padding:6px 0; border-top:1px solid var(--grid); overflow-wrap:anywhere; }
.st-comments a { text-decoration:none; }
`;
