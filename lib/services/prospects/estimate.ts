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
export function noLeadsLeft(e: { companies: { mid: number }; leads_left?: { high: number }; pages_used?: number; total_pages?: number | null; at_least?: boolean } | null): boolean {
  if (!e || !(e.pages_used ?? 0)) return false;
  // Page memory knows the last page: every one of them was read (even when the size guess says ~0 companies).
  if (e.total_pages != null && e.pages_used! >= e.total_pages) return true;
  // A count that stopped early has seen only part of the market; more may come after.
  if (e.at_least) return false;
  return e.companies.mid > 0 && e.leads_left?.high === 0;
}

// ── Counted size check (3 Nov 2026) ─────────────────────────────────────────
// The people count above is turned into companies with a fixed ratio, which was
// 2-4x off by region. People Search also returns each person's company NAME, so
// the route now reads the buyers (APOLLO_TITLES) and counts distinct names
// instead. Measured on 11 past searches that read every Apollo page:
// buyer companies = 84% of all companies (62-93% over 16 searches), so all ≈ counted / 0.84;
// names matched the stored companies 99% of the time (1,881 of 1,898).
// Leads = new companies × the share of new companies that became leads in the
// client's earlier searches with the same keywords (17-65% by keyword), or
// DEFAULT_LEAD_SHARE when the keywords were never searched. Still a guess, so
// the screen shows ±25%.

export const BUYER_SHARE = 0.84;
export const DEFAULT_LEAD_SHARE = 0.4;
/** How much history a keyword needs before its own share outweighs the default (in companies). */
const SHARE_PRIOR = 50;

// Legal forms with their dots and gaps removed, so "S.p.A." = "SpA", "S. de R.L. de C.V." = "sderldecv".
const LEGAL = new Set(("sa sab sac saa sas sadecv sabdecv sderl sderldecv sapi sapidecv decv cv spzoo zoo sro doo srl sl spa " +
  "as ad sc spj spk ltd ltda llc llp inc corp corporation co cia company gmbh kg ag se ek kft zrt ooo oao pao tov " +
  "limited pvt private pte pty sdn bhd plc kk group grupo eood ood jsc pjsc uab sia oy ab aps bv nv").split(" "));

/** One key per company: lowercase, no accents or punctuation, no legal endings ("Sp. z o.o.", "S.A. de C.V.", "Ltd"). */
export function normCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  // The size check re-normalises every known name (~13K for the client) on each
  // cache miss; the answer for a given name never changes, so keep it.
  // ponytail: per-instance memo; a stored normalised column + SQL check if reads become the cost.
  const hit = NORM_MEMO.get(name);
  if (hit !== undefined) return hit;
  if (NORM_MEMO.size >= 50_000) NORM_MEMO.clear();
  const norm = normUncached(name);
  NORM_MEMO.set(name, norm);
  return norm;
}
const NORM_MEMO = new Map<string, string>();

function normUncached(name: string): string {
  const words = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/["'“”„«»]/g, "")
    .replace(/[().,&/\-–]/g, " ").split(/\s+/).filter(Boolean);
  // Drop legal forms from the END only, repeatedly ("GmbH & Co. KG", "Pvt. Ltd."): "A S Plastics" and
  // "Co Pack" keep their words, and at least one word always stays.
  // Longest ending first, so "s a de c v" goes whole rather than leaving "s a de".
  let n = words.length, cut = true;
  while (cut) {
    cut = false;
    for (let k = Math.min(7, n - 1); k >= 1; k--) {
      if (LEGAL.has(words.slice(n - k, n).join(""))) { n -= k; cut = true; break; }
    }
  }
  return words.slice(0, n).join(" ");
}

export interface SearchHistory { keywords: string[]; available: number; scored: number }

/** Share of new companies that became leads in earlier searches with these keywords. A past
 *  search counts only for the part of its keywords that match: the client's 83-keyword search
 *  once set the share for every keyword on its own (3 Nov 2026 backtest: 47% → 20% error).
 *  `fromHistory` = past searches outweigh the default (at least SHARE_PRIOR companies' worth). */
export function leadShare(history: SearchHistory[], keywords: string[]): { share: number; searches: number; fromHistory: boolean } {
  const want = new Set(keywords.map((k) => k.trim().toLowerCase()));
  let available = 0, scored = 0, searches = 0;
  for (const h of history) {
    const kws = new Set(h.keywords.map((k) => k.trim().toLowerCase()));
    const hit = [...kws].filter((k) => want.has(k)).length;
    if (!hit) continue;
    const w = hit / kws.size;
    available += w * h.available; scored += w * h.scored; searches++;
  }
  return { share: (available + SHARE_PRIOR * DEFAULT_LEAD_SHARE) / (scored + SHARE_PRIOR), searches, fromHistory: scored >= SHARE_PRIOR };
}

/** Counted companies → the same ranges estimateMarket gives, plus `at_least` when the scan stopped early. */
export function estimateFromCount(c: { buyerCompanies: number; newBuyerCompanies: number; complete: boolean; share: number; people: number }): MarketEstimate & { at_least: boolean; counted: true; new_companies: number } {
  const mid = Math.round(c.buyerCompanies / BUYER_SHARE);
  const fresh = c.newBuyerCompanies / BUYER_SHARE;
  const leads = fresh * c.share;
  return {
    // new_companies: the screen shows "you already have mid − new_companies" so a big count with few leads makes sense.
    people: c.people, counted: true, at_least: !c.complete, new_companies: Math.min(mid, Math.round(fresh)),
    companies: { low: c.buyerCompanies, mid, high: Math.round(c.buyerCompanies / 0.62) },
    leads: { low: round(leads * 0.75), high: round(leads * 1.25) },
  };
}
