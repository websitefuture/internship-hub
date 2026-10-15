import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@supabase/supabase-js";
import { auth } from "@/auth";

// Private all-time traffic dashboard. Reads the site's own tracker (sql/page_views.sql) and the
// Vercel history imported before the move, so the record is continuous across hosts.
// Visible only to emails listed in ADMIN_EMAILS (comma separated); everyone else gets a 404.

export const metadata: Metadata = { title: "Site stats", robots: { index: false, follow: false } };

const ADMINS = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

type Day = { day: string; views: number; visitors: number; from: "tracker" | "vercel" };
type Row = { label: string; views: number };

async function load() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!);
  const [daily, history, sources, paths, countries, nest] = await Promise.all([
    db.from("pv_daily").select("day, views, visitors"),
    db.from("vercel_history").select("day, views, visitors"),
    db.from("pv_sources").select("source, views").order("views", { ascending: false }).limit(12),
    db.from("pv_paths").select("path, views").order("views", { ascending: false }).limit(12),
    db.from("pv_countries").select("country, views").order("views", { ascending: false }).limit(12),
    db.from("ig_handled").select("comment_id", { count: "exact", head: true }),
  ]);

  // One continuous record: imported Vercel days, then tracker days. Where both exist, the
  // tracker wins, since it is the source going forward.
  const byDay = new Map<string, Day>();
  for (const r of history.data ?? []) byDay.set(r.day, { ...r, from: "vercel" });
  for (const r of daily.data ?? []) byDay.set(r.day, { ...r, from: "tracker" });
  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));

  return {
    days,
    sources: (sources.data ?? []).map((r) => ({ label: r.source, views: r.views })),
    paths: (paths.data ?? []).map((r) => ({ label: r.path, views: r.views })),
    countries: (countries.data ?? []).map((r) => ({ label: r.country, views: r.views })),
    nest: nest.count ?? 0,
    error: daily.error?.message ?? history.error?.message ?? null,
  };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const fmtDay = (d: string) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function sumLast(days: Day[], n: number, key: "views" | "visitors") {
  const cutoff = new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10);
  return days.filter((d) => d.day >= cutoff).reduce((a, d) => a + d[key], 0);
}

// The SVG scales to its container, text included, so one chart can't have readable labels on
// both a laptop and a phone. Phones get a narrower drawing of fewer days instead.
function Chart({ days, W, span, className }: { days: Day[]; W: number; span: number; className: string }) {
  if (!days.length) return <p className="st-empty">No views recorded yet.</p>;
  const shown = days.slice(-span);
  const H = Math.round(W * 0.27), padL = 40, padB = 24, padT = 8;
  const max = Math.max(1, ...shown.map((d) => d.views));
  const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, (raw / p <= 1 ? 1 : raw / p <= 2 ? 2 : raw / p <= 5 ? 5 : 10) * p);
  const top = Math.ceil(max / step) * step;
  const iw = W - padL, ih = H - padB - padT, bw = iw / shown.length, gap = Math.min(2, bw * 0.25);
  const y = (v: number) => padT + ih - (v / top) * ih;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const every = Math.max(1, Math.ceil(shown.length / 8));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`st-chart ${className}`} role="img" aria-label="Page views per day">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={padL} x2={W} y1={y(v)} y2={y(v)} className="st-grid" />
          <text x={padL - 6} y={y(v) + 4} textAnchor="end" className="st-axis">{fmt(v)}</text>
        </g>
      ))}
      {shown.map((d, i) => {
        const x = padL + i * bw, w = Math.max(1, bw - gap), h = (d.views / top) * ih;
        return (
          <g key={d.day}>
            <title>{`${fmtDay(d.day)}: ${fmt(d.views)} views, ${fmt(d.visitors)} visitors${d.from === "vercel" ? " (Vercel history)" : ""}`}</title>
            <rect x={x} y={padT} width={bw} height={ih} fill="transparent" />
            {d.views > 0 && <rect x={x} y={y(d.views)} width={w} height={h} rx={Math.min(3, w / 2)} className={d.from === "vercel" ? "st-bar st-old" : "st-bar"} />}
            {i % every === 0 && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="st-axis">
                {new Date(d.day + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
              </text>
            )}
          </g>
        );
      })}
      <line x1={padL} x2={W} y1={padT + ih} y2={padT + ih} className="st-base" />
    </svg>
  );
}

function Table({ title, rows, label }: { title: string; rows: Row[]; label: string }) {
  const max = rows[0]?.views || 1;
  return (
    <section className="st-card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="st-empty">Nothing yet.</p>
      ) : (
        <table>
          <thead><tr><th>{label}</th><th className="st-num">Views</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td><span className="st-val" title={r.label}>{r.label}</span><div className="st-meter" style={{ width: `${Math.max(2, (r.views / max) * 100)}%` }} /></td>
                <td className="st-num">{fmt(r.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export default async function StatsPage() {
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

  const s = await load();
  const total = s.days.reduce((a, d) => a + d.views, 0);
  const best = s.days.reduce<Day | null>((a, d) => (!a || d.views > a.views ? d : a), null);
  const tiles: [string, string, string][] = [
    ["All-time page views", fmt(total), s.days.length ? `since ${fmtDay(s.days[0].day)}` : "no data yet"],
    ["Last 7 days", fmt(sumLast(s.days, 7, "views")), `${fmt(sumLast(s.days, 7, "visitors"))} daily visitors`],
    ["Last 30 days", fmt(sumLast(s.days, 30, "views")), `${fmt(sumLast(s.days, 30, "visitors"))} daily visitors`],
    ["Best day", best ? fmt(best.views) : "0", best ? fmtDay(best.day) : "none yet"],
    ["NEST comments answered", fmt(s.nest), "Instagram auto-reply"],
  ];

  return (
    <main className="st-wrap">
      <style>{CSS}</style>
      <h1>Site stats</h1>
      <p className="st-sub">All-time traffic for Internship Nest. Hover a bar for that day.</p>
      {s.error && <p className="st-err">Couldn&apos;t read some data: {s.error}</p>}
      <div className="st-tiles">
        {tiles.map(([l, v, n]) => (
          <div key={l} className="st-tile"><div className="st-label">{l}</div><div className="st-value">{v}</div><div className="st-note">{n}</div></div>
        ))}
      </div>
      <section className="st-card">
        <h2>Page views per day</h2>
        <Chart days={s.days} W={900} span={90} className="st-desk" />
        <Chart days={s.days} W={380} span={30} className="st-mob" />
        <p className="st-note">Lighter bars are history imported from Vercel; solid bars are counted by the site itself.</p>
      </section>
      <div className="st-grid3">
        <Table title="Where visitors came from" rows={s.sources} label="Source" />
        <Table title="Top pages" rows={s.paths} label="Page" />
        <Table title="Countries" rows={s.countries} label="Country" />
      </div>
      <p className="st-note">Visitors are counted per day, so someone who comes back on three days counts three times. No cookies are used and no IP addresses are stored.</p>
    </main>
  );
}

const CSS = `
.st-wrap { --bg:#f4f3ef; --card:#fcfcfb; --line:#e3e1da; --grid:#ecebe6; --ink:#0b0b0b; --ink2:#52514e; --ink3:#7c7a74; --bar:#eb6834; --bar-old:#f3b393;
  max-width:1040px; margin:0 auto; padding:32px 16px 64px; color:var(--ink); font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
@media (prefers-color-scheme: dark) { .st-wrap { --bg:#111110; --card:#1a1a19; --line:#2c2b29; --grid:#262624; --ink:#fff; --ink2:#c3c2b7; --ink3:#8f8e86; --bar:#d95926; --bar-old:#7a3a20; } }
.st-wrap h1 { font-size:26px; margin:0 0 4px; }
.st-sub { color:var(--ink2); margin:0 0 20px; }
.st-err { color:#c0392b; }
.st-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:20px; }
.st-tile, .st-card { background:var(--card); border:1px solid var(--line); border-radius:10px; }
.st-tile { padding:14px 16px; }
.st-label { color:var(--ink2); font-size:13px; }
.st-value { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; }
.st-note { color:var(--ink3); font-size:12px; }
.st-card { padding:16px; margin-bottom:20px; }
.st-card h2 { font-size:16px; margin:0 0 10px; }
.st-chart { width:100%; height:auto; display:block; }
.st-mob { display:none; }
@media (max-width: 600px) { .st-desk { display:none; } .st-mob { display:block; } }
.st-grid { stroke:var(--grid); } .st-base { stroke:var(--line); }
.st-axis { font-size:11px; fill:var(--ink3); }
.st-bar { fill:var(--bar); } .st-old { fill:var(--bar-old); }
.st-grid3 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:20px; }
.st-wrap table { width:100%; border-collapse:collapse; font-size:14px; }
.st-wrap th { text-align:left; color:var(--ink3); font-size:12px; font-weight:600; padding-bottom:6px; }
.st-wrap td { padding:6px 0; border-top:1px solid var(--grid); }
.st-num { text-align:right; font-variant-numeric:tabular-nums; width:80px; }
.st-val { display:block; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.st-meter { height:4px; border-radius:2px; background:var(--bar); margin-top:4px; }
.st-empty { color:var(--ink2); }
`;
