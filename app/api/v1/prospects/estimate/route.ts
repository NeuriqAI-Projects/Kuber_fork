import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { parseIndustryKeywordGroups, resolveApolloKeyword } from "@/lib/constants";
import { countPeopleAtCompanies, scanBuyerCompanies } from "@/lib/services/apollo";
import { estimateFromCount, estimateMarket, leadShare, normCompanyName, type SearchHistory } from "@/lib/services/prospects/estimate";
import { bookedBy, filterKey, leadsApolloFits, leadsFirecrawlFits } from "@/lib/services/prospects/digging";
import { apolloBooked } from "@/lib/services/prospects/search";
import { isApolloMockCompany } from "@/lib/services/apollo-mock";
import { checkApolloCredits, checkFirecrawlCredits } from "@/lib/services/provider-credits";

const Body = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(200),
  locations: z.array(z.string()).max(200).optional(),
  employee_ranges: z.array(z.string()).max(20).optional(),
  lookalike_org_ids: z.array(z.string()).max(5).optional(),
  exclude_websites: z.array(z.string()).max(1000).optional(),
  advanced: z.record(z.string(), z.unknown()).optional(),
});

export const maxDuration = 60;

/** Pages of buyers read per check: ~40 × 100 people ≈ 1,000+ companies, enough for any lead target. */
const SCAN_PAGES = 40;
const SCAN_MS = 20_000;
/** Lead statuses: a good fit with someone to email (review = not sure yet, counted). */
const AVAILABLE = new Set(["promoted", "review"]);
const SCORED = new Set(["promoted", "review", "no_contact", "hidden", "rejected"]);

type Db = ReturnType<typeof dbForUser>;
/** Every row of a select, 1,000 at a time (Supabase caps one read at 1,000). */
async function allRows<T>(q: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> }): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await q().range(i, i + 999);
    // A failed read must not count every company as new: throw, so the check falls back.
    if (error) throw new Error(`reading known companies: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/** Company names this workspace already has, and how earlier searches turned out per keyword set. */
async function known(db: Db) {
  const [orgs, pcs, searches] = await Promise.all([
    allRows<{ name: string | null }>(() => db.from("organizations").select("name").order("id")),
    allRows<{ search_id: string; status: string; name: string | null }>(() => db.from("prospect_companies").select("search_id, status, name").order("id")),
    allRows<{ id: string; filters: { keywords?: string[] } | null }>(() => db.from("prospect_searches").select("id, filters").eq("mock", false).order("id")),
  ]);
  const names = new Set([...orgs, ...pcs].map((r) => normCompanyName(r.name)).filter(Boolean));
  const per = new Map<string, { available: number; scored: number }>();
  for (const p of pcs) {
    if (!SCORED.has(p.status)) continue;
    const c = per.get(p.search_id) ?? { available: 0, scored: 0 };
    c.scored++; if (AVAILABLE.has(p.status)) c.available++;
    per.set(p.search_id, c);
  }
  const history: SearchHistory[] = searches.flatMap((s) => { const c = per.get(s.id); return c && s.filters?.keywords?.length ? [{ keywords: s.filters.keywords, ...c }] : []; });
  return { names, history };
}

// ponytail: per-instance memory, lost on a cold start; move to a table if checks stay slow in production.
const scans = new Map<string, { at: number; scan: Awaited<ReturnType<typeof scanBuyerCompanies>> }>();
const SCAN_TTL = 7 * 24 * 3600_000;
const knowns = new Map<string, { at: number; k: Awaited<ReturnType<typeof known>> }>();
const KNOWN_TTL = 2 * 60_000;
/** Apollo's answer for one filter set rarely changes, so a full scan is kept a week; one cut by the deadline or an error is not kept. */
async function cachedScan(key: string, run: () => ReturnType<typeof scanBuyerCompanies>) {
  const hit = scans.get(key);
  if (hit && Date.now() - hit.at < SCAN_TTL) return hit.scan;
  const scan = await run();
  if (scan.full) { scans.set(key, { at: Date.now(), scan }); if (scans.size > 500) scans.delete(scans.keys().next().value!); }
  return scan;
}
async function cachedKnown(companyId: string, db: Db) {
  const hit = knowns.get(companyId);
  if (hit && Date.now() - hit.at < KNOWN_TTL) return hit.k;
  const k = await known(db);
  knowns.set(companyId, { at: Date.now(), k });
  return k;
}

const capped = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 5_000))]);

/** Free size check before a scored search: how many companies these filters
 *  have (counted by name from Apollo People Search, 0 credits) and about how
 *  many leads, minus companies this workspace already has. Falls back to the
 *  people-count maths when the scan fails. */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const db = dbForUser(user);
  // Same label → Apollo word mapping the search itself uses (search.ts).
  const { data: kw } = await db.from("settings").select("value").eq("key", "industry_keyword_groups").maybeSingle();
  const groups = parseIndustryKeywordGroups(kw?.value);
  const keywordTags = [...new Set(parsed.data.keywords.map((k) => resolveApolloKeyword(groups, k)))];
  // How many leads the Apollo and Firecrawl balances can pay for, plus the balances themselves
  // (the Credits page already shows managers these exact numbers).
  const balances = Promise.all([
    // A slow balance check gives "unknown" after 5 s rather than holding the whole answer.
    capped(checkApolloCredits(db, "any" /* one shared Apollo account */).then((c) => c.remaining).catch(() => null)),
    capped(checkFirecrawlCredits(db, user.companyId ?? "any").then((c) => c.remaining).catch(() => null)),
    // What this company's running searches can still spend: not free for a new one (search start refuses the same).
    user.companyId ? capped(apolloBooked(db, user.companyId, isApolloMockCompany(user.companyId)).catch(() => null)) : null,
  ]);
  const f = { keywordTags, locations: parsed.data.locations, employeeRanges: parsed.data.employee_ranges };
  const fk = filterKey({ ...parsed.data, keywords: keywordTags } as never);
  // The scan only uses keywords, countries and sizes, so lookalikes or advanced filters reuse its answer.
  const sk = filterKey({ keywords: keywordTags, locations: parsed.data.locations, employee_ranges: parsed.data.employee_ranges });
  // The search uses these too; People Search has no matching filters, so the count leaves them out and says so.
  const d = parsed.data;
  const partial = !!(d.lookalike_org_ids?.length || d.exclude_websites?.length || Object.values(d.advanced ?? {}).some((v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length)));
  try {
    // Page memory: pages earlier searches with exactly these filters already read.
    const { data: mem } = await db.from("prospect_page_memory").select("last_page, total_pages").eq("filter_key", fk).maybeSingle();
    const pagesUsed = (mem?.last_page as number | undefined) ?? 0;
    // Every page already read: the search would refuse to start (NO_MORE_PAGES), so counting is wasted calls.
    const allRead = mem?.total_pages != null && pagesUsed >= (mem.total_pages as number);
    let est: ReturnType<typeof estimateMarket> & { counted?: boolean; at_least?: boolean; from_history?: boolean; new_companies?: number };
    try {
      if (allRead) throw new Error("every page was read before");
      const [scan, k] = await Promise.all([
        cachedScan(`${user.companyId}|${sk}`, () => scanBuyerCompanies(f, { maxPages: SCAN_PAGES, deadlineMs: Date.now() + SCAN_MS, signal: req.signal })),
        cachedKnown(user.companyId ?? "none", db),
      ]);
      const found = new Set(scan.names.map(normCompanyName).filter(Boolean));
      const fresh = [...found].filter((n) => !k.names.has(n)).length;
      const share = leadShare(k.history, keywordTags);
      est = { ...estimateFromCount({ buyerCompanies: found.size, newBuyerCompanies: fresh, complete: scan.complete, share: share.share, people: scan.people }), from_history: share.fromHistory };
    } catch (e) {
      // The browser moved on (filters changed, step closed): nobody reads this answer.
      if (req.signal.aborted) return new Response(null, { status: 499 });
      if (!allRead) console.error("[prospects/estimate] counted check failed, using the people count:", (e as Error).message);
      est = estimateMarket(await countPeopleAtCompanies(f));
    }
    const totalPages = (mem?.total_pages as number | undefined) ?? Math.max(1, Math.ceil(est.companies.mid / 100));
    // The counted check already left out companies this workspace has; the people-count maths can only skip read pages.
    const leftShare = est.counted ? 1 : Math.max(0, 1 - pagesUsed / totalPages);
    const [apolloLeft, firecrawlLeft, booked] = await balances;
    return ok({
      free: true, ...est, partial_filters: partial,
      fits: {
        apollo_leads: leadsApolloFits(apolloLeft == null ? null : Math.max(0, apolloLeft - (booked?.credits ?? 0))), firecrawl_leads: leadsFirecrawlFits(firecrawlLeft),
        apollo_credits: apolloLeft, firecrawl_credits: firecrawlLeft,
        apollo_booked: booked?.credits ?? 0, apollo_booked_by: booked ? bookedBy(booked) : null,
      },
      pages_used: pagesUsed, total_pages: mem?.total_pages ?? null,
      leads_left: { low: Math.round(est.leads.low * leftShare), high: Math.round(est.leads.high * leftShare) },
    });
  } catch (e) {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    console.error("[prospects/estimate]", (e as Error).message);
    return fail(502, "UPSTREAM_APOLLO", "Couldn't check the size right now: Apollo is not answering. Nothing was charged. Try again in a few minutes.");
  }
}
