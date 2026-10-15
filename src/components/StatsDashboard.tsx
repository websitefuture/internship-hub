"use client";

import { useState } from "react";
import OwnVisits from "@/components/OwnVisits";
import StatsChart from "@/components/StatsChart";
import {
  FIRST_TRACKED_DAY,
  RANGES,
  breakdown,
  dayOf,
  fmt,
  fmtDay,
  period,
  regionName,
  series,
  totals,
  visitorRows,
  type HistoryDay,
  type Metric,
  type RangeKey,
  type Row,
  type View,
} from "@/lib/statsCalc";

// The interactive part of /admin/stats. The server sends every tracked view once; picking a
// range, switching between Visitors and Page views, and removing a visitor are all worked out
// here in the browser, so the graph and numbers change instantly with no trip to the server.
// The address bar follows along, so a reload opens the same view.

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

export default function StatsDashboard(props: {
  views: View[];
  history: HistoryDay[];
  nest: number;
  today: string;
  range: RangeKey;
  metric: Metric;
  error: string | null;
}) {
  const { history, nest, today } = props;
  const [views, setViews] = useState(props.views);
  const [range, setRange] = useState(props.range);
  const [metric, setMetric] = useState(props.metric);

  const show = (r: RangeKey, m: Metric) => {
    setRange(r);
    setMetric(m);
    window.history.replaceState(null, "", `/admin/stats?range=${r}&metric=${m}`);
  };
  const removed = (ids: string[]) => {
    const gone = new Set(ids);
    setViews((v) => v.filter((r) => !gone.has(r.visitor)));
  };

  const firstDay = history[0]?.day ?? (views[0] ? dayOf(views[0].at) : today);
  const w = period(range, today, firstDay);
  const now = totals(views, history, w.start, w.end);
  const prev = totals(views, history, w.prevStart, w.prevEnd);
  const pts = series(range, views, history, w.start, w.end);
  const pages = breakdown(views, w.start, w.end, (r) => r.path);
  const sources = breakdown(views, w.start, w.end, (r) => r.utm_source ?? r.referrer_host ?? "Direct / unknown");
  const countries = breakdown(views, w.start, w.end, (r) => (r.country ? regionName(r.country) : "Unknown"));
  const devices = breakdown(views, w.start, w.end, (r) => (r.device === "mobile" ? "Phone" : "Computer"));
  const visitorList = visitorRows(views, w.start, w.end);
  const onlyHistory = w.end < FIRST_TRACKED_DAY;
  const partly = w.start < FIRST_TRACKED_DAY;
  const panelNote = onlyHistory ? "Breakdowns start on Oct 15, when the site began counting visits itself." : undefined;
  const label = RANGES.find((r) => r.key === range)!.label;

  return (
    <>
      <div className="st-top">
        <div>
          <h1>Site stats</h1>
          <p className="st-sub">internshipnest.com · {range === "today" ? fmtDay(today) : `${fmtDay(w.start)} to ${fmtDay(w.end)}`} · Central Time</p>
        </div>
        <nav className="st-ranges" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => show(r.key, metric)} className={r.key === range ? "st-on" : ""} aria-pressed={r.key === range}>
              {r.label}
            </button>
          ))}
        </nav>
      </div>
      {props.error && <p className="st-err">Couldn&apos;t read some data: {props.error}</p>}

      <section className="st-card st-main">
        <div className="st-metrics">
          {(["visitors", "views"] as const).map((m) => (
            <button key={m} type="button" onClick={() => show(range, m)} className={`st-metric ${m === metric ? "st-on" : ""}`} aria-pressed={m === metric}>
              <span className="st-label">{m === "visitors" ? "Visitors" : "Page views"}</span>
              <span className="st-value">{fmt(now[m])}</span>
              <Delta now={now[m]} prev={prev[m]} show={w.comparable} />
              <span className="st-hint">{m === "visitors" ? "different devices" : "every page load, reloads included"}</span>
            </button>
          ))}
        </div>
        <StatsChart pts={pts} metric={metric} />
        <p className="st-note">
          Showing {metric === "visitors" ? "visitors" : "page views"} for {label.toLowerCase()}. Move your cursor over the chart (or drag a finger on a phone) to see each day&apos;s numbers.
          {partly && " Days before Oct 15 come from Vercel and count visitors once per day."}
        </p>
      </section>

      <OwnVisits rows={visitorList} rangeLabel={label} onRemoved={removed} />

      <div className="st-grid2">
        <Panel title="Pages" rows={pages} note={panelNote} />
        <Panel title="Where visitors came from" rows={sources} note={panelNote} />
        <Panel title="Countries" rows={countries} note={panelNote} />
        <Panel title="Devices" rows={devices} note={panelNote} />
      </div>

      <section className="st-card st-row">
        <div><span className="st-label">NEST comments answered</span><span className="st-value st-small">{fmt(nest)}</span></div>
      </section>
    </>
  );
}
