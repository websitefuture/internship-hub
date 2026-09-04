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

export type RoleKey = "marketing" | "ops" | "eng" | "design" | "data" | "trades" | "healthcare" | "hospitality" | "retail";
export type PriorityKey = "commute" | "fit" | "pay";

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

export interface DriveTime {
  minutes: number | null;
  miles: number | null;
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

// A place returned by the free-text city search (geocoded via OpenStreetMap/Nominatim).
export interface GeoResult {
  label: string; // concise, e.g. "San Francisco, California"
  fullLabel: string; // full geocoder display name, shown once picked
  lat: number;
  lng: number;
  countryCode: string; // ISO 3166-1 alpha-2, lowercase
}

// A single job/internship posting as returned by the live search API, before scoring.
export interface RawListing {
  id: string;
  title: string;
  company: string;
  locationLabel: string;
  lat: number | null;
  lng: number | null;
  description: string;
  category: string;
  url: string;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryIsPredicted: boolean;
  created: string | null;
  remoteGuess: "remote" | "hybrid" | "onsite";
  unpaidMentioned: boolean;
  contactEmail: string | null; // pulled from the listing text itself, when a listing includes one
}

export type LiveScoreParts = Record<"Commute" | "Role fit" | "Pay" | "Mode", number>;

export interface ScoredListing extends RawListing {
  d: number | null; // distance in miles from the searched location
  s: number; // total score 0-100
  parts: LiveScoreParts;
  best: [string, number];
  worst: [string, number];
}
