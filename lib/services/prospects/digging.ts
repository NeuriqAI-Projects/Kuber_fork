// "How many leads do you want?" — when a search reads the next Apollo page,
// and when it stops. Pure, so the rules are tested on their own.
//
// One Apollo page = up to 100 companies = 1 credit. Live tests (17 Oct 2026):
// about 25–40 leads per page with good keywords, fewer on deeper pages.

/** Never read more than this many pages in one search, whatever the target. */
export const MAX_PAGES_PER_SEARCH = 20;
/** Two pages in a row with fewer leads than this = the keywords have dried up. */
export const DRY_PAGE_LEADS = 3;
/** Leads per page used to suggest a credit limit (17 Oct 2026 live tests). */
export const LEADS_PER_PAGE = 33;
/** Firecrawl credits a page of 100 companies can use (1 per website read). */
export const FIRECRAWL_PER_PAGE = 100;
/** Most leads one search can be asked for: what 20 pages give at 33 a page. */
export const MAX_LEADS_PER_SEARCH = MAX_PAGES_PER_SEARCH * LEADS_PER_PAGE;

export interface RunState {
  target: number;
  maxCredits: number;
  /** Apollo credits used so far: pages read + contacts revealed (incl. approvals). */
  creditsUsed: number;
  leads: number;
  /** Companies still being read, scored or getting their contact. */
  working: number;
  pagesRead: number;
  /** Leads that came from each page read, in order. */
  leadsPerPage: number[];
  /** Apollo's page count for these filters (null = unknown yet). */
  totalPages: number | null;
  nextPage: number;
  /** The last page read came back with no companies at all. */
  lastPageEmpty: boolean;
  /** Firecrawl credits left (null = unknown or test batch). */
  firecrawlLeft?: number | null;
}

export type DigStep = { action: "fetch" } | { action: "wait" } | { action: "stop"; note: string };

export function nextStep(s: RunState): DigStep {
  if (s.leads >= s.target) return { action: "stop", note: `Done: ${s.leads} leads, as asked.` };
  if (s.working > 0) return { action: "wait" };
  if (s.lastPageEmpty || (s.totalPages !== null && s.nextPage > s.totalPages)) {
    return { action: "stop", note: `Stopped at ${s.leads} of ${s.target} leads: Apollo has no more companies for these filters. Add more keywords or countries.` };
  }
  // A page costs 1 credit and is only worth it if at least 1 lead can still be paid for.
  if (s.creditsUsed + 2 > s.maxCredits) return { action: "stop", note: `Stopped at ${s.leads} of ${s.target} leads: your credit limit of ${s.maxCredits} is reached.` };
  if (s.firecrawlLeft != null && s.firecrawlLeft < FIRECRAWL_PER_PAGE) {
    return { action: "stop", note: `Stopped at ${s.leads} of ${s.target} leads: Firecrawl (it reads company websites) has only ${s.firecrawlLeft} credits left, not enough for the next 100 companies. Top up Firecrawl to get more.` };
  }
  const last2 = s.leadsPerPage.slice(-2);
  if (last2.length === 2 && last2.every((n) => n < DRY_PAGE_LEADS)) {
    return { action: "stop", note: `Stopped at ${s.leads} of ${s.target} leads: the last 2 pages gave almost no leads, so these keywords are used up. Try other keywords.` };
  }
  if (s.pagesRead >= MAX_PAGES_PER_SEARCH) return { action: "stop", note: `Stopped at ${s.leads} of ${s.target} leads: ${MAX_PAGES_PER_SEARCH} pages is the most one search reads.` };
  return { action: "fetch" };
}

/** Fewest credits that can buy a lead target: 1 per lead + 1 per page of 100 companies. */
export function minCredits(target: number): number {
  return target + Math.ceil(target / LEADS_PER_PAGE);
}

/** Credit limit to suggest for a lead target: the minimum plus 10% room. */
export function suggestedMaxCredits(target: number): number {
  return Math.ceil(minCredits(target) * 1.1);
}

/** Most leads the credits left can pay for (null = unknown). */
export function leadsApolloFits(apolloLeft: number | null): number | null {
  if (apolloLeft == null) return null;
  let n = Math.max(0, Math.floor((apolloLeft * LEADS_PER_PAGE) / (LEADS_PER_PAGE + 1)));
  while (n > 0 && minCredits(n) > apolloLeft) n--;
  return n;
}
export function leadsFirecrawlFits(firecrawlLeft: number | null): number | null {
  return firecrawlLeft == null ? null : Math.floor(firecrawlLeft / FIRECRAWL_PER_PAGE) * LEADS_PER_PAGE;
}

/** Cap on automatic reveals: never past the target, never past what the credit limit leaves after pages. */
export function revealCap(target: number, maxCredits: number, pagesRead: number): number {
  return Math.max(0, Math.min(target, maxCredits - pagesRead));
}

/** Stable key for "the same search": page memory is kept per key. */
export function filterKey(f: { keywords: string[]; locations?: string[]; employee_ranges?: string[]; lookalike_org_ids?: string[]; exclude_websites?: string[]; advanced?: Record<string, unknown> }): string {
  const norm = (a?: string[]) => [...new Set((a ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();
  const adv = Object.entries(f.advanced ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify({ k: norm(f.keywords), l: norm(f.locations), e: norm(f.employee_ranges), a: norm(f.lookalike_org_ids), x: norm(f.exclude_websites), adv });
}
