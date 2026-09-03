import { miles } from "./geo";
import type { Answers, Company, RoleKey, ScoredCompany, ScoreParts, UserProfile } from "./types";

function roleFit(role: RoleKey, co: Company): number {
  const i = (co.i || "").toLowerCase();
  const m = co.m / 25;
  const has = (...words: string[]) => words.some((w) => i.includes(w));
  switch (role) {
    case "marketing":
      return m;
    case "ops":
      return 0.5 + 0.3 * m;
    case "eng":
      return has("devtools", "infra", "deeptech", "semiconductor", "robotics", "hardware", "ai/")
        ? 0.95
        : 0.6;
    case "design":
      return has("design", "consumer", "martech", "e-commerce")
        ? 0.85
        : has("deeptech", "semiconductor", "infra")
          ? 0.25
          : 0.5;
    case "data":
      return has("ai", "fintech", "business software", "infra", "analytics") ? 0.85 : 0.5;
  }
  return 0.5;
}

function sizeFit(pref: Answers["size"], e: string | null): number {
  if (e == null) return 0.6;
  const n = parseFloat(e);
  if (isNaN(n)) return 0.6;
  if (pref === "any") return 0.75;
  if (pref === "tiny") return n < 10 ? 1 : n < 25 ? 0.7 : n < 50 ? 0.45 : 0.2;
  if (pref === "small") return n >= 10 && n <= 50 ? 1 : n < 10 ? 0.7 : n < 100 ? 0.6 : 0.3;
  if (pref === "big") return n >= 50 ? 1 : n >= 25 ? 0.6 : 0.25;
  return 0.6;
}

const BASE: Record<"commute" | "fit" | "size" | "growth" | "reach" | "hs", number> = {
  commute: 30,
  fit: 25,
  size: 10,
  growth: 15,
  reach: 15,
  hs: 5,
};

export function score(answers: Answers, user: UserProfile, companies: Company[]): ScoredCompany[] {
  const a = answers;
  const w = { ...BASE };
  (a.pri || []).forEach((p) => {
    if (w[p] !== undefined) w[p] += 9;
  });
  const totalWeight = Object.values(w).reduce((x, y) => x + y, 0);
  (Object.keys(w) as (keyof typeof w)[]).forEach((k) => {
    w[k] = (w[k] / totalWeight) * 100;
  });

  const maxMiles = parseFloat(a.max || "30");
  const factor = { drive: 1, driven: 0.8, transit: 0.45, none: 0 }[a.how || "drive"];
  const effMax = Math.max(2, maxMiles * factor);
  const roles: RoleKey[] = a.role && a.role.length ? a.role : ["marketing"];

  const userLat = user.lat!;
  const userLng = user.lng!;

  const out: ScoredCompany[] = companies.map((co) => {
    const remote = co.lat === null;
    let d: number | null = null;
    let cs: number;
    if (remote) {
      cs = a.mode === "remote" ? 0.95 : a.mode === "hybrid" ? 0.6 : 0.2;
    } else if (a.how === "none" || a.mode === "remote") {
      cs = 0.15;
      d = miles(userLat, userLng, co.lat!, co.lng!);
    } else {
      d = miles(userLat, userLng, co.lat!, co.lng!);
      cs = d <= effMax ? 1 - 0.5 * (d / effMax) : Math.max(0, 0.5 - (d - effMax) / 55);
    }
    const fit = Math.max(...roles.map((r) => roleFit(r, co)));
    const sz = sizeFit(a.size || "any", co.e);
    const gr = co.g / 15;
    const re = co.x / 15;
    const hs = co.hs ? (a.stage === "hs" ? 1 : 0.4) : 0;
    let s = w.commute * cs + w.fit * fit + w.size * sz + w.growth * gr + w.reach * re + w.hs * hs;

    const wantsMkt = roles.includes("marketing") || roles.includes("design");
    const techOnly = roles.every((r) => r === "eng" || r === "data");
    if (co.m <= 8 && wantsMkt && !techOnly) s = Math.min(s, Math.round(s * 0.78));

    const parts: ScoreParts = { Commute: cs, "Role fit": fit, "Team size": sz, Growth: gr, Reach: re };
    const entries = Object.entries(parts) as [keyof ScoreParts, number][];
    const best = [...entries].sort((x, y) => y[1] - x[1])[0];
    const worst = [...entries].sort((x, y) => x[1] - y[1])[0];

    return { ...co, d, s: Math.round(s), parts, best, worst };
  });

  out.sort((x, y) => y.s - x.s);
  return out;
}
