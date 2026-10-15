"use client";

import { useEffect, useRef, useState } from "react";

export type ChartPoint = { label: string; full: string; views: number; visitors: number };

const fmt = (n: number) => n.toLocaleString("en-US");

// Interactive line chart for /admin/stats. Measures its own width so text stays crisp at any
// size, and follows the cursor (or a finger on a phone) with a guide line and a tooltip showing
// that point's visitors and page views.
export default function StatsChart({ pts, metric }: { pts: ChartPoint[]; metric: "visitors" | "views" }) {
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    // Measure once right away too: ResizeObserver only reports when the page is being drawn, so
    // a tab that loads in the background would otherwise show no chart until it is resized.
    queueMicrotask(() => setW(Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);

  const n = pts.length;
  const H = Math.max(190, Math.min(300, Math.round(W * 0.32)));
  const padL = 36, padR = 10, padB = 24, padT = 12;
  const iw = Math.max(1, W - padL - padR), ih = H - padB - padT;
  const max = Math.max(1, ...pts.map((p) => p[metric]));
  const raw = max / 4, p10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = Math.max(1, (raw / p10 <= 1 ? 1 : raw / p10 <= 2 ? 2 : raw / p10 <= 5 ? 5 : 10) * p10);
  const top = Math.ceil(max / step) * step;
  const x = (i: number) => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - (v / top) * ih;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 70))));
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[metric]).toFixed(1)}`).join(" ");
  const area = n ? `${line} L${x(n - 1).toFixed(1)},${padT + ih} L${x(0).toFixed(1)},${padT + ih} Z` : "";

  const pick = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || !n) return;
    const px = clientX - rect.left;
    const i = n === 1 ? 0 : Math.round(((px - padL) / iw) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const h = hover === null ? null : pts[hover];
  const tipW = 170;
  const tipLeft = hover === null ? 0 : Math.max(0, Math.min(W - tipW, x(hover) - tipW / 2));

  return (
    <div
      ref={box}
      className="st-ichart"
      style={{ height: H }}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
    >
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={`${metric === "visitors" ? "Visitors" : "Page views"} over time`}>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className="st-gridline" />
              <text x={padL - 6} y={y(v) + 4} textAnchor="end" className="st-axis">{fmt(v)}</text>
            </g>
          ))}
          <path d={area} className="st-area" />
          <path d={line} className="st-line" />
          {n <= 45 && pts.map((p, i) => <circle key={i} cx={x(i)} cy={y(p[metric])} r={2.5} className="st-dot" />)}
          {pts.map((p, i) =>
            // The last point always gets a label, so skip a regular one that would sit right next to it.
            (i % every === 0 && n - 1 - i >= every) || i === n - 1 ? (
              <text key={`l${i}`} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="st-axis">
                {p.label}
              </text>
            ) : null,
          )}
          {h && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} className="st-guide" />
              <circle cx={x(hover)} cy={y(h[metric])} r={5} className="st-hdot" />
            </g>
          )}
        </svg>
      )}
      {h && (
        <div className="st-tip" style={{ left: tipLeft, width: tipW }}>
          <div className="st-tip-date">{h.full}</div>
          <div className={metric === "visitors" ? "st-tip-on" : ""}><span>Visitors</span><b>{fmt(h.visitors)}</b></div>
          <div className={metric === "views" ? "st-tip-on" : ""}><span>Page views</span><b>{fmt(h.views)}</b></div>
        </div>
      )}
    </div>
  );
}
