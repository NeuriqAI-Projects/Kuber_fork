import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { parseIndustryKeywordGroups, resolveApolloKeyword } from "@/lib/constants";
import { countPeopleAtCompanies } from "@/lib/services/apollo";
import { estimateMarket } from "@/lib/services/prospects/estimate";
import { filterKey, leadsApolloFits, leadsFirecrawlFits } from "@/lib/services/prospects/digging";
import { checkApolloCredits, checkFirecrawlCredits } from "@/lib/services/provider-credits";

const Body = z.object({
  keywords: z.array(z.string().trim().min(1)).min(1).max(50),
  locations: z.array(z.string()).max(200).optional(),
  employee_ranges: z.array(z.string()).max(20).optional(),
  lookalike_org_ids: z.array(z.string()).max(5).optional(),
  exclude_websites: z.array(z.string()).max(1000).optional(),
  advanced: z.record(z.string(), z.unknown()).optional(),
});

/** Free size check before a scored search: about how many companies and leads
 *  these filters can give, minus the pages earlier searches already read.
 *  Uses Apollo People Search (0 credits). */
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
    checkApolloCredits(db, "any" /* one shared Apollo account */).then((c) => c.remaining).catch(() => null),
    checkFirecrawlCredits(db, user.companyId ?? "any").then((c) => c.remaining).catch(() => null),
  ]);
  try {
    const people = await countPeopleAtCompanies({ keywordTags, locations: parsed.data.locations, employeeRanges: parsed.data.employee_ranges });
    const est = estimateMarket(people);
    // Page memory: pages earlier searches with exactly these filters already read.
    const { data: mem } = await db.from("prospect_page_memory").select("last_page, total_pages")
      .eq("filter_key", filterKey({ ...parsed.data, keywords: keywordTags } as never)).maybeSingle();
    const pagesUsed = (mem?.last_page as number | undefined) ?? 0;
    const totalPages = (mem?.total_pages as number | undefined) ?? Math.max(1, Math.ceil(est.companies.mid / 100));
    const leftShare = Math.max(0, 1 - pagesUsed / totalPages);
    const [apolloLeft, firecrawlLeft] = await balances;
    return ok({
      free: true, ...est,
      fits: {
        apollo_leads: leadsApolloFits(apolloLeft), firecrawl_leads: leadsFirecrawlFits(firecrawlLeft),
        apollo_credits: apolloLeft, firecrawl_credits: firecrawlLeft,
      },
      pages_used: pagesUsed, total_pages: mem?.total_pages ?? null,
      leads_left: { low: Math.round(est.leads.low * leftShare), high: Math.round(est.leads.high * leftShare) },
    });
  } catch (e) {
    console.error("[prospects/estimate]", (e as Error).message);
    return fail(502, "UPSTREAM_APOLLO", "Couldn't check the size right now: Apollo is not answering. Nothing was charged. Try again in a few minutes.");
  }
}
