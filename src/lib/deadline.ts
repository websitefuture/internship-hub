// One time budget for a whole search request, shared by every network call it makes.
//
// Netlify kills a synchronous function at 60s, and a killed function returns the platform's
// error page instead of the JSON the results screen knows how to word. Each provider call
// already has a timeout of its own, but those were chosen one call at a time and add up past
// 60s on a bad day: the high-school path could reach geocode 8s + Overpass 30s + 5s wait +
// Overpass retry 30s + drive times 15s = 88s.
//
// So the route starts a Deadline when the request arrives, and every call made on its behalf
// asks budgetFor() for its timeout. That is the call's own usual timeout whenever the budget
// can afford it, so a fast search behaves exactly as before; it only shrinks once the request
// as a whole is running late.

// Ten seconds under Netlify's limit, which covers a cold start and the work after the last call.
export const SEARCH_BUDGET_MS = 50_000;
// Every call must finish this long before the deadline, leaving time to score and respond.
export const SAFETY_MARGIN_MS = 2_000;
// Below this a request has no realistic chance of an answer, so it is not sent at all.
export const MIN_CALL_MS = 1_000;
// The 60s limit is not the only one. Netlify's edge drops a response that sends nothing for
// about 30s and serves its own "Inactivity Timeout" page instead. Measured live: an Austin
// high-school search hit it at ~31s. So the search route streams one space this often while it
// works, which keeps the connection alive well inside that limit.
export const KEEPALIVE_MS = 5_000;

export class Deadline {
  private readonly end: number;

  constructor(totalMs: number, start = Date.now()) {
    this.end = start + totalMs;
  }

  remaining(): number {
    return Math.max(0, this.end - Date.now());
  }
}

export class BudgetSpentError extends Error {
  constructor() {
    super("Search time budget spent");
    this.name = "BudgetSpentError";
  }
}

// The timeout one call may use: its own `ms`, or what is left of the budget minus the safety
// margin if that is less. Throws instead of returning a uselessly short timeout; every caller
// on the search path already treats a thrown call as "this source had nothing".
export function budgetFor(ms: number, deadline?: Deadline): number {
  if (!deadline) return ms;
  const left = deadline.remaining() - SAFETY_MARGIN_MS;
  if (left < MIN_CALL_MS) throw new BudgetSpentError();
  return Math.min(ms, left);
}
