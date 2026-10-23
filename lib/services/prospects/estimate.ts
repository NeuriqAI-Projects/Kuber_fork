// "How big is this market?" before any credit is spent.
//
// Apollo's free People Search tells us how many people work at companies
// matching the filters. Measured on 17 Oct 2026 against 52 keywords whose
// exact company count we had paid for (Firecrawl-Test/real-test): companies ≈
// people × 0.034 (median); half of the keywords fall between × 0.024 and
// × 0.045; the 0.02–0.05 range covers about 3 in 4 keywords, so the screen
// shows a range, never one exact number.
// Leads: the live tests gave about 33 leads per 100 new companies with good
// keywords (17 Oct 2026); about 25–40 is the honest range.

export const COMPANIES_PER_PERSON = { low: 0.02, mid: 0.034, high: 0.05 };
export const LEADS_PER_COMPANY = { low: 0.25, high: 0.4 };

export interface MarketEstimate {
  people: number;
  companies: { low: number; mid: number; high: number };
  leads: { low: number; high: number };
}

const round = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n));

export function estimateMarket(people: number): MarketEstimate {
  const c = (k: number) => round(people * k);
  const mid = people * COMPANIES_PER_PERSON.mid;
  return {
    people,
    companies: { low: c(COMPANIES_PER_PERSON.low), mid: c(COMPANIES_PER_PERSON.mid), high: c(COMPANIES_PER_PERSON.high) },
    leads: { low: round(mid * LEADS_PER_COMPANY.low), high: round(mid * LEADS_PER_COMPANY.high) },
  };
}

/** The size check says every page of these filters was read before: a search would find nothing new. */
export function noLeadsLeft(e: { companies: { mid: number }; leads_left?: { high: number }; pages_used?: number } | null): boolean {
  return !!e && e.companies.mid > 0 && (e.pages_used ?? 0) > 0 && e.leads_left?.high === 0;
}
