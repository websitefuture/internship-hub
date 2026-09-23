// Shared facts for the legal pages. Kept in one place so the privacy policy, the terms and
// the in-app notices can never drift apart from each other.
//
// CONTACT_EMAIL is published publicly on /privacy and /terms — a privacy policy without a
// reachable contact is not much of a policy. Swap it here for a dedicated address if you
// would rather not expose a personal inbox.
export const CONTACT_EMAIL = "obattisha@gmail.com";

export const SITE_NAME = "Internship Nest";

// Last substantive revision of the policies, shown so users can tell when terms moved.
export const POLICY_UPDATED = "22 September 2026";

// The countries where the live jobs API actually returns listings, mirroring
// ADZUNA_COUNTRIES in src/lib/jobs.ts. The landing copy used to claim "worldwide", which
// that list flatly contradicts, so both the copy and this file now say the same thing.
export const COVERAGE_COUNTRIES = [
  "Australia",
  "Austria",
  "Brazil",
  "Canada",
  "France",
  "Germany",
  "India",
  "Italy",
  "Mexico",
  "Netherlands",
  "New Zealand",
  "Poland",
  "Singapore",
  "South Africa",
  "Spain",
  "Switzerland",
  "United Kingdom",
  "United States",
];
