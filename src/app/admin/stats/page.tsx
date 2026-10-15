import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";
import { loadInstagram } from "@/lib/instagram";
import StatsDashboard from "@/components/StatsDashboard";
import { FIRST_TRACKED_DAY, RANGES, TZ, dayOf, fmt, type HistoryDay, type Metric, type RangeKey, type View } from "@/lib/statsCalc";

// Private traffic dashboard, laid out like Vercel's: pick a time range, pick Visitors or Page
// views for the chart, and see what drove traffic in that range. Reads the site's own tracker
// (sql/page_views.sql) plus the Vercel history imported before the move.
// Visible only to emails listed in ADMIN_EMAILS (comma separated); everyone else gets a 404.

export const metadata: Metadata = { title: "Site stats", robots: { index: false, follow: false } };

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function load() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const cols = "at, path, referrer_host, utm_source, country, device, visitor";
  // site and browser exist once sql/page_views.sql has been re-run; read without them until then.
  const readViews = async () => {
    const full = await db.from("page_views").select(`${cols}, site, browser`).order("at").limit(50000);
    return full.error ? db.from("page_views").select(cols).order("at").limit(50000) : full;
  };
  const [views, history, nest] = await Promise.all([
    readViews(),
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

const num = (n: number | null) => (n === null ? "–" : fmt(n));
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });

// Loaded on its own and streamed in after the rest of the page, so the stats and graph never wait
// on Instagram's API.
async function Instagram() {
  const ig = await loadInstagram();
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
  const data = await load();

  return (
    <main className="st-wrap">
      <style>{CSS}</style>
      <StatsDashboard
        views={data.views}
        history={data.history}
        nest={data.nest}
        today={dayOf(new Date().toISOString())}
        range={range}
        metric={metric}
        error={data.error}
      />

      <Suspense
        fallback={
          <section className="st-card">
            <h2>Instagram</h2>
            <p className="st-note">Loading posts...</p>
          </section>
        }
      >
        <Instagram />
      </Suspense>
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
.st-ranges button { font:inherit; padding:7px 12px; font-size:13px; color:var(--ink2); background:none; border:0; border-right:1px solid var(--line); cursor:pointer; }
.st-ranges button:last-child { border-right:0; }
.st-ranges button:hover { color:var(--ink); background:var(--grid); }
.st-ranges button.st-on { background:var(--ink); color:var(--card); }
.st-card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
.st-card h2 { font-size:15px; margin:0; }
.st-main { padding:0; overflow:hidden; }
.st-main .st-chart, .st-main .st-note { margin:12px 16px; }
.st-metrics { display:grid; grid-template-columns:1fr 1fr; border-bottom:1px solid var(--line); }
.st-metric { display:flex; flex-direction:column; gap:2px; padding:14px 16px; text-decoration:none; color:inherit; font:inherit; text-align:left; background:none; border:0; border-bottom:2px solid transparent; cursor:pointer; }
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
  .st-ranges button { text-align:center; border-bottom:1px solid var(--line); }
  .st-ranges button:nth-child(3n) { border-right:0; }
  .st-ranges button:nth-last-child(-n+3) { border-bottom:0; }
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
.st-btn { font:inherit; font-size:13px; font-weight:600; padding:8px 12px; border-radius:6px; border:1px solid var(--accent); background:var(--accent); color:#fff; cursor:pointer; white-space:nowrap; }
.st-btn:disabled { opacity:.6; cursor:default; }
.st-btn-quiet { background:transparent; color:var(--accent); padding:5px 10px; font-weight:500; }
.st-btn-quiet:hover:not(:disabled) { background:var(--accent-soft); }
.st-visitors { list-style:none; margin:0; padding:0; }
.st-visitors li { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:8px 0; border-top:1px solid var(--grid); }
.st-vinfo { min-width:0; }
.st-vline { font-size:14px; }
.st-vinfo .st-note { overflow-wrap:anywhere; }
.st-site { display:inline-block; margin-left:8px; font-size:11px; color:var(--ink3); border:1px solid var(--line); border-radius:4px; padding:0 5px; }
.st-own-intro { margin:4px 0 10px; }
.st-more { font-size:13px; margin-top:8px; }
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
