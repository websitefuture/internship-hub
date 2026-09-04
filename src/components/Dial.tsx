"use client";

import { jitter } from "@/lib/geo";

export interface DialPoint {
  label: string;
  d: number | null;
  b: number;
  lim: number;
  top?: boolean;
}

interface DialProps {
  list: DialPoint[];
  size: number;
}

// The radial distance visualization from the prototype: rings at 5/15/30/60 miles,
// scaled by sqrt(distance) so nearby companies aren't crushed into the center dot.
export default function Dial({ list, size }: DialProps) {
  const R = size / 2 - 14;
  const cx = size / 2;
  const cy = size / 2;
  const bands = [5, 15, 30, 60];
  const rr = (d: number) => R * Math.sqrt(Math.min(d, 60) / 60);

  const points = list
    .filter((c) => c.d !== null && c.d !== undefined)
    .map((c, i) => {
      // Jitter is seeded from the label so the same company/listing lands in the same spot
      // across re-renders — but two different listings can share a title (e.g. two separate
      // "Lab Intern" postings), so the React key below needs the index to stay unique.
      const j = jitter(c.label, c.d! < 2 ? 26 : c.d! < 20 ? 20 : 14);
      const r = rr(c.d!);
      const th = ((c.b - 90) * Math.PI) / 180;
      const x = cx + r * Math.cos(th) + j[0];
      const y = cy + r * Math.sin(th) + j[1];
      const lim = c.lim || 15;
      const col = c.d! <= lim ? "#0E7C66" : c.d! <= lim * 2 ? "#B87503" : "#9E2B3E";
      return { key: `${c.label}-${i}`, label: c.label, x, y, col, top: c.top, d: c.d! };
    });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Companies plotted by distance and direction from your location"
    >
      {bands.map((b) => (
        <circle key={b} cx={cx} cy={cy} r={rr(b).toFixed(1)} fill="none" stroke="#DCE3DF" strokeWidth={1} />
      ))}
      {bands.map((b) => (
        <text
          key={"t" + b}
          x={cx + 2}
          y={cy - rr(b) + 11}
          fontSize={9.5}
          fill="#9AA8A3"
          fontFamily="Instrument Sans"
        >
          {b}mi
        </text>
      ))}
      <line x1={cx} y1={14} x2={cx} y2={size - 14} stroke="#EDF1EE" />
      <line x1={14} y1={cy} x2={size - 14} y2={cy} stroke="#EDF1EE" />
      {points.map((p) => (
        <circle
          key={p.key}
          cx={p.x.toFixed(1)}
          cy={p.y.toFixed(1)}
          r={p.top ? 4.6 : 3}
          fill={p.col}
          opacity={p.top ? 1 : 0.5}
        >
          <title>{`${p.label} — ${Math.round(p.d)} mi`}</title>
        </circle>
      ))}
      <circle cx={cx} cy={cy} r={4.5} fill="#101F1B" />
      <circle cx={cx} cy={cy} r={9} fill="none" stroke="#101F1B" strokeWidth={1} opacity={0.3} />
    </svg>
  );
}
