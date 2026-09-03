export interface Company {
  n: string; // name
  c: string; // city
  lat: number | null; // null = fully remote
  lng: number | null;
  i: string; // industry
  e: string | null; // employee count estimate, unconfirmed for many
  m: number; // marketing/role-relevance score, 0-25
  g: number; // growth score, 0-15
  x: number; // contact reachability score, 0-15
  z: number; // unused in current scoring, kept for parity with source data
  hs: number; // explicitly welcomes high schoolers — truthy check, source data has some non-1 truthy values (e.g. 5)
  w: string | null; // website
  k: string; // one-line kicker / caveat
  desc: string; // description
}

export type RoleKey = "marketing" | "ops" | "eng" | "design" | "data";
export type PriorityKey = "commute" | "fit" | "size" | "growth" | "reach";

export interface LocationAnswer {
  lat: number;
  lng: number;
  label: string;
  exact: boolean;
}

export interface Answers {
  loc?: LocationAnswer;
  max?: string; // "5" | "15" | "30" | "50"
  how?: "drive" | "driven" | "transit" | "none";
  role?: RoleKey[];
  stage?: "hs" | "ug" | "grad" | "other";
  size?: "tiny" | "small" | "big" | "any";
  mode?: "onsite" | "hybrid" | "remote";
  when?: "sum27" | "school" | "asap" | "flex";
  pay?: "yes" | "prefer" | "no";
  pri?: PriorityKey[];
}

export interface UserProfile {
  name: string;
  email: string;
  lat?: number;
  lng?: number;
}

export type ScoreParts = Record<"Commute" | "Role fit" | "Team size" | "Growth" | "Reach", number>;

export interface ScoredCompany extends Company {
  d: number | null; // distance in miles, null if remote
  s: number; // total score 0-100
  parts: ScoreParts;
  best: [string, number];
  worst: [string, number];
}

export interface PlottedCompany extends ScoredCompany {
  b: number; // bearing in degrees
  lim: number;
  top?: boolean;
}

export type QuestionOption = [value: string, label: string, sub: string];

export interface Question {
  k: keyof Answers;
  t: string;
  s: string;
  type: "loc" | "one" | "many";
  o?: QuestionOption[];
  max?: number;
}
