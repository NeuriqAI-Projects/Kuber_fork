// Step 1 of company-first prospecting: Apollo Organization Search pages
// (1 credit per page of up to 100, https://docs.apollo.io/reference/organization-search).
//
// Order matters for money:
//   1. Credit check first — out of credits = refused, nothing saved.
//   2. A prospect_searches row in status 'paying' is written BEFORE the call.
//   3. The call. On an error or a timeout the row becomes 'failed' and the page
//      is given back to page memory (nothing was delivered). If the function
//      itself dies mid-call, the row stays 'paying', which the UI shows as
//      "charge unknown", so a possible charge is never invisible.
//   4. Companies saved (one row per Apollo company per client; a company we
//      already have is skipped, never re-scored), then the row becomes 'done'.
//
// With a lead target (19 Oct 2026) the search keeps going: the background job
// calls continueRun() to read the next page until the target, the credit limit
// or the keywords run out (rules in digging.ts). Page memory (claim_prospect_page)
// remembers the last page per filter set, so a repeat search starts on the next page.
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchOrganizations, type ApolloOrganization } from "@/lib/services/apollo";
import { isApolloMockCompany, mockApolloDelay, mockSearchOrganizations } from "@/lib/services/apollo-mock";
import { checkApolloCredits, checkFirecrawlCredits } from "@/lib/services/provider-credits";
import { DEV_COMPANY_ID, parseIndustryKeywordGroups, resolveApolloKeyword } from "@/lib/constants";
import type { ApolloOrgAdvancedFilters } from "@/lib/services/apollo";
import { normalizeDomain } from "@/lib/utils/domain";
import { companyName } from "./text";
import { isWorking } from "./groups";
import { FIRECRAWL_PER_PAGE, filterKey, nextStep, outageNote, revealCap, suggestedMaxCredits, type RunState } from "./digging";

export interface ProspectSearchInput {
  keywords: string[];
  locations?: string[];
  employee_ranges?: string[];
  lookalike_org_ids?: string[];
  exclude_websites?: string[];
  page: number;
  batch_name: string;
  color: string;
  advanced?: ApolloOrgAdvancedFilters;
  assigned_to?: string | null;
  assignment_strategy?: "manual" | "round_robin" | "territory";
  max_auto_reveals?: number;
  /** How many leads the client wants. Set = keep reading pages (with page memory). */
  target_leads?: number;
  /** Most Apollo credits this search may use (pages + contacts). */
  max_credits?: number;
}

export type SearchOutcome =
  | { ok: true; search_id: string; returned: number; new_companies: number; total_entries: number; credits_spent: number; mock: boolean; page: number }
  | { ok: false; status: number; code: string; message: string; search_id?: string };

const safeDomain = (raw: string | null) => {
  if (!raw) return null;
  try { return normalizeDomain(raw); } catch { return raw.trim().toLowerCase(); }
};

type OrgPage = { organizations: ApolloOrganization[]; pagination: { total_entries: number; total_pages?: number } };

/** Swappable for tests; defaults are the real Apollo calls (or fixtures in mock mode). */
export interface SearchDeps {
  mock: boolean;
  creditsLeft(): Promise<number | null>;
  /** Firecrawl credits left; a page of 100 companies can use up to 100. */
  firecrawlLeft?(): Promise<number | null>;
  search(input: ProspectSearchInput): Promise<OrgPage>;
}

/** Dev-workspace test scenarios, switched on by a word in the batch name:
 *  [apollo-0] no credits · [apollo-down] Apollo answers 500 · [apollo-timeout] no answer · [apollo-empty] 0 results
 *  · [no-socials] companies come without LinkedIn/Twitter/Facebook · [pages-N] N pages of companies (multi-page searches)
 *  · [firecrawl-low] Firecrawl has only 50 credits left. */
const has = (input: ProspectSearchInput, f: string) => input.batch_name.toLowerCase().includes(`[${f}]`);

export function defaultSearchDeps(db: SupabaseClient, companyId: string, input?: ProspectSearchInput): SearchDeps {
  const mock = isApolloMockCompany(companyId);
  return {
    mock,
    creditsLeft: async () => (mock ? (input && has(input, "apollo-0") ? 0 : null) : (await checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: true })).remaining),
    firecrawlLeft: async () => (mock ? (input && has(input, "firecrawl-low") ? 50 : null) : (await checkFirecrawlCredits(db, companyId, { fresh: true })).remaining),
    search: async (input) => {
      if (mock) {
        await mockApolloDelay();
        if (has(input, "apollo-down")) throw Object.assign(new Error("Apollo org search 500: internal error (mock)"), { status: 500 });
        if (has(input, "apollo-timeout")) throw new Error("The operation was aborted due to timeout (mock)");
        if (has(input, "apollo-empty")) return { organizations: [], pagination: { total_entries: 0, total_pages: 0 } };
        const pagesN = Number(input.batch_name.match(/\[pages-(\d+)\]/i)?.[1] ?? 0);
        const res = mockSearchOrganizations({ name: input.keywords.join(" "), locations: input.locations, page: pagesN ? 1 : input.page });
        if (pagesN) {
          // Fake extra pages: the same fixtures, renamed so every page has its own companies.
          res.organizations = input.page > pagesN ? [] : res.organizations.map((o) => ({ ...o, id: `${o.id}-p${input.page}`, name: `${o.name} P${input.page}`, primary_domain: o.primary_domain ? `p${input.page}.${o.primary_domain}` : o.primary_domain }));
          res.pagination = { ...res.pagination, total_entries: pagesN * res.pagination.total_entries, total_pages: pagesN };
        }
        // [no-socials]: no LinkedIn/Twitter/Facebook, so a down website ends in "Website down" (Retry).
        if (has(input, "no-socials")) res.organizations = res.organizations.map((o) => ({ ...o, linkedin_url: null, twitter_url: null, facebook_url: null }));
        return res;
      }
      return searchOrganizations({
        locations: input.locations,
        page: input.page,
        advanced: {
          ...input.advanced,
          keywordTags: input.keywords,
          employeeRanges: input.employee_ranges,
          lookalikeOrgIds: input.lookalike_org_ids,
          notWebsites: input.exclude_websites,
        },
      });
    },
  };
}

/** `db` must be company-scoped (it stamps and filters company_id). */
export async function runProspectSearch(db: SupabaseClient, companyId: string, userId: string, input: ProspectSearchInput, deps: SearchDeps = defaultSearchDeps(db, companyId, input)): Promise<SearchOutcome> {
  const mock = deps.mock;

  // Local/preview runs use mock data but share the LIVE database. Mock
  // companies and leads must never land in a real client's workspace.
  if (mock && companyId !== DEV_COMPANY_ID) {
    return { ok: false, status: 400, code: "MOCK_ONLY_IN_DEV", message: "This is a test (mock) run. Switch to the Dev workspace to try it, so test companies never land in a client's real data." };
  }

  {
    // Mock mode only reports a number in the [apollo-0] test scenario.
    const left = await deps.creditsLeft();
    if (left !== null && left < 1) {
      return { ok: false, status: 402, code: "APOLLO_OUT_OF_CREDITS", message: "Apollo has no credits left. Nothing was searched or charged." };
    }
    // Every company found is read by Firecrawl; don't pay Apollo for companies we can't read.
    const fc = (await deps.firecrawlLeft?.()) ?? null;
    if (fc !== null && fc < FIRECRAWL_PER_PAGE) {
      return { ok: false, status: 402, code: "FIRECRAWL_LOW", message: `Firecrawl (it reads company websites) has only ${fc} credits left, and 100 companies need up to 100. Top up Firecrawl first. Nothing was searched or charged.` };
    }
  }

  // Industry-segment labels (Settings > Industry Segments) → the words Apollo
  // is searched with, exactly as Apollo Search does. Free-typed words pass through.
  const { data: kwSetting } = await db.from("settings").select("value").eq("key", "industry_keyword_groups").maybeSingle();
  const groups = parseIndustryKeywordGroups(kwSetting?.value);
  // The labels the user picked are kept too, so the form can show them again.
  const keywordLabels = input.keywords;
  input = { ...input, keywords: [...new Set(input.keywords.map((k) => resolveApolloKeyword(groups, k)))] };

  // A lead target turns on page memory and digging.
  const target = input.target_leads ?? null;
  const key = target ? filterKey(input as never) : null;
  const maxCredits = target ? (input.max_credits ?? suggestedMaxCredits(target)) : null;
  if (target && maxCredits !== null) input = { ...input, max_auto_reveals: revealCap(target, maxCredits, 1) };
  if (key) {
    // Every page was read before: don't pay 1 credit for Apollo to say so.
    const { data: mem } = await db.from("prospect_page_memory").select("last_page, total_pages").eq("filter_key", key).maybeSingle();
    if (mem?.total_pages != null && (mem.last_page as number) >= (mem.total_pages as number)) {
      return { ok: false, status: 409, code: "NO_MORE_PAGES", message: "You already have every company these keywords can give. Add other keywords or countries in step 1." };
    }
  }

  const { data: search, error: sErr } = await db.from("prospect_searches")
    .insert({
      created_by: userId, filters: { ...input, keyword_labels: keywordLabels }, page: input.page, status: "paying", mock,
      // Locked while the first page is read: else the minute job sees 0 companies, reads page 2 and ends the run.
      ...(target ? { target_leads: target, max_credits: maxCredits, filter_key: key, run_status: "running", run_locked_until: new Date(Date.now() + 2 * 60_000).toISOString() } : {}),
    })
    .select("id").single();
  if (sErr || !search) {
    console.error("[prospects] could not save the search row:", sErr?.message);
    return { ok: false, status: 500, code: "INTERNAL", message: "Could not start the search because our database did not answer. Nothing was searched or charged. Try again in a minute." };
  }
  const searchId = search.id as string;

  const page = key ? await claimPage(db, companyId, key) : input.page;
  const res = await fetchPageInto(db, searchId, { ...input, page }, deps, key).finally(async () => {
    if (target) await db.from("prospect_searches").update({ run_locked_until: null }).eq("id", searchId);
  });
  if (!res.ok) return { ...res, search_id: searchId };
  if (target && res.returned === 0) {
    await db.from("prospect_searches").update({ run_status: "complete", run_note: `Apollo has no more companies for these filters${page > 1 ? " (all pages were read in earlier searches)" : ""}. Add more keywords or countries.` }).eq("id", searchId);
  }
  return { ok: true, search_id: searchId, returned: res.returned, new_companies: res.inserted, total_entries: res.totalEntries, credits_spent: res.creditsSpent, mock, page };
}

async function claimPage(db: SupabaseClient, companyId: string, key: string): Promise<number> {
  const { data, error } = await db.rpc("claim_prospect_page", { p_company: companyId, p_key: key });
  if (error) throw new Error(`claim_prospect_page: ${error.message}`);
  return Number(data);
}

/** Apollo delivered nothing for the page: give it back so the next search reads it. */
async function releasePage(db: SupabaseClient, key: string, page: number) {
  await db.from("prospect_page_memory").update({ last_page: page - 1 }).eq("filter_key", key).eq("last_page", page);
}

/** Apollo answered with an error code: what it means for the user, in plain words. Nothing is charged. */
export function apolloRefusedNote(status: number): string {
  if (status === 402 || status === 422) return "Apollo has no credits left. Nothing was charged. Top up Apollo, then try again.";
  if (status === 401 || status === 403) return "Apollo did not accept our key. Nothing was charged. Check the Apollo key in Settings > Keys, then try again.";
  if (status === 429) return "Apollo is busy (too many searches at once). Nothing was charged. Try again in a few minutes.";
  return "Apollo is not answering right now. Nothing was charged. Try again in a few minutes.";
}

type PageResult = { ok: true; returned: number; inserted: number; totalEntries: number; creditsSpent: number } | { ok: false; status: number; code: string; message: string };

/** Read one Apollo page into an existing search row (adds to its counts). */
async function fetchPageInto(db: SupabaseClient, searchId: string, input: ProspectSearchInput, deps: SearchDeps, key: string | null): Promise<PageResult> {
  const mock = deps.mock;
  await db.from("prospect_searches").update({ status: "paying", updated_at: new Date().toISOString() }).eq("id", searchId);
  let orgs: ApolloOrganization[];
  let total: number, totalPages: number;
  try {
    const res = await deps.search(input);
    orgs = res.organizations;
    total = res.pagination.total_entries;
    totalPages = res.pagination.total_pages ?? Math.ceil(total / 100);
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = (err as Error).message.slice(0, 500);
    // Either way Apollo delivered nothing, so the page goes back to page memory:
    // the next search reads it. Nothing was received, so nothing can be paid twice.
    if (key) await releasePage(db, key, input.page);
    // An HTTP error answer means Apollo refused (no charge). The raw answer goes to the log only.
    if (status) {
      console.error(`[prospects] Apollo refused page ${input.page}:`, msg);
      const note = apolloRefusedNote(status);
      await db.from("prospect_searches").update({ status: "failed", error: note, run_status: "complete", run_note: note, updated_at: new Date().toISOString() }).eq("id", searchId);
      return { ok: false, status: 502, code: "UPSTREAM_APOLLO", message: note };
    }
    // No answer at all (timeout, network): Apollo may have used 1 credit, but no companies came back.
    const note = `Apollo didn't answer in time (it may have used 1 credit). No companies were saved and page ${input.page} was not marked as read, so it is safe to try again.`;
    await db.from("prospect_searches").update({ status: "failed", error: note, run_status: "complete", run_note: note, updated_at: new Date().toISOString() }).eq("id", searchId);
    return { ok: false, status: 502, code: "UPSTREAM_APOLLO", message: note };
  }

  // Skip companies already in the system (organizations) — matched on Apollo id, then domain.
  const ids = orgs.map((o) => o.id);
  const domains = orgs.map((o) => safeDomain(o.primary_domain)).filter((d): d is string => !!d);
  const [byId, byDomain] = await Promise.all([
    ids.length ? db.from("organizations").select("apollo_org_id").in("apollo_org_id", ids) : { data: [] },
    domains.length ? db.from("organizations").select("domain").in("domain", domains) : { data: [] },
  ]);
  const knownIds = new Set((byId.data ?? []).map((r) => r.apollo_org_id as string));
  const knownDomains = new Set((byDomain.data ?? []).map((r) => String(r.domain).toLowerCase()));
  const fresh = orgs.filter((o) => !knownIds.has(o.id) && !(safeDomain(o.primary_domain) && knownDomains.has(safeDomain(o.primary_domain)!)));

  let inserted = 0;
  if (fresh.length) {
    const { data, error } = await db.from("prospect_companies").upsert(
      fresh.map((o) => ({
        search_id: searchId,
        apollo_org_id: o.id,
        name: companyName(o.name, safeDomain(o.primary_domain)),
        domain: safeDomain(o.primary_domain),
        website_url: o.website_url,
        linkedin_url: o.linkedin_url,
        twitter_url: o.twitter_url,
        facebook_url: o.facebook_url,
        apollo_raw: o.raw,
        ...(key ? { page: input.page } : {}),
      })),
      { onConflict: "apollo_org_id", ignoreDuplicates: true }, // same company from an earlier search: keep the first
    ).select("id");
    if (error) {
      console.error("[prospects] saving companies failed:", error.message);
      const note = "Apollo sent the companies (1 credit may be used), but saving them failed, so none were added. Try the search again in a minute.";
      await db.from("prospect_searches").update({ error: note, updated_at: new Date().toISOString() }).eq("id", searchId);
      return { ok: false, status: 500, code: "INTERNAL", message: note };
    }
    inserted = data?.length ?? 0;
  }

  // Apollo bills nothing for an empty page (measured 18 Aug 2026, see company-search).
  const creditsSpent = !mock && orgs.length > 0 ? 1 : 0;
  // "pages" only exists after the 19 Oct migration; plain one-page searches don't read it.
  const { data: cur } = await db.from("prospect_searches").select(key ? "credits_spent, returned, new_companies, pages" : "credits_spent, returned, new_companies").eq("id", searchId).maybeSingle() as { data: { credits_spent?: number; returned?: number; new_companies?: number; pages?: number[] } | null };
  await db.from("prospect_searches").update({
    status: "done", error: null,
    credits_spent: (cur?.credits_spent ?? 0) + creditsSpent,
    returned: (cur?.returned ?? 0) + orgs.length,
    new_companies: (cur?.new_companies ?? 0) + inserted,
    total_entries: total,
    ...(key ? { pages: [...((cur?.pages as number[] | null) ?? []), input.page] } : {}),
    updated_at: new Date().toISOString(),
  }).eq("id", searchId);
  if (key) await db.from("prospect_page_memory").update({ total_pages: totalPages }).eq("filter_key", key);

  // Same ledger row company-search writes, so Settings > Keys > Usage counts it.
  if (creditsSpent) {
    await db.from("enrichment_logs").insert({
      source: "apollo", event: "CREDITS_CONSUMED",
      payload: { stage: "prospect_search", search_id: searchId, keywords: input.keywords, page: input.page, returned: orgs.length, credits_consumed: 1 },
    });
  }
  return { ok: true, returned: orgs.length, inserted, totalEntries: total, creditsSpent };
}

/**
 * One step of a search with a lead target, called by the background job:
 * read the next page, wait for the companies in progress, or finish with a
 * plain note. Locked per search so the minute job and an open screen never
 * read two pages at once. Returns what it did.
 */
export async function continueRun(db: SupabaseClient, companyId: string, searchId: string, depsFor: (input: ProspectSearchInput) => SearchDeps = (i) => defaultSearchDeps(db, companyId, i)): Promise<"fetched" | "waiting" | "stopped" | "busy"> {
  const now = new Date();
  const { data: locked } = await db.from("prospect_searches")
    .update({ run_locked_until: new Date(now.getTime() + 2 * 60_000).toISOString() })
    .eq("id", searchId).eq("run_status", "running")
    .or(`run_locked_until.is.null,run_locked_until.lt.${now.toISOString()}`)
    .select("id, filters, target_leads, max_credits, filter_key, pages, credits_spent, mock");
  const s = locked?.[0];
  if (!s) return "busy";
  const unlock = (extra: Record<string, unknown> = {}) => db.from("prospect_searches").update({ run_locked_until: null, ...extra }).eq("id", searchId);
  try {
    const { data: rows } = await db.from("prospect_companies").select("status, page, last_error").eq("search_id", searchId);
    const rs = rows ?? [];
    const pages = (s.pages as number[] | null) ?? [];
    const promoted = rs.filter((r) => r.status === "promoted");
    const { data: mem } = await db.from("prospect_page_memory").select("last_page, total_pages").eq("filter_key", s.filter_key).maybeSingle();
    const target = s.target_leads as number, maxCredits = s.max_credits as number;
    const input = s.filters as ProspectSearchInput;
    // Companies waiting for Apollo credits are not "working": they can wait for days.
    const working = rs.filter(isWorking).length;
    const waitingCredits = rs.filter((r) => r.status === "waiting_credits").length;
    // Asked only when a new page might be read, so a waiting search makes no Firecrawl calls.
    const firecrawlLeft = working === 0 && !waitingCredits && promoted.length < target ? ((await depsFor(input).firecrawlLeft?.()) ?? null) : null;
    // Why companies did not become leads: service errors and dead websites are not the keywords' fault.
    const failedRows = rs.filter((r) => r.status === "review" && String(r.last_error ?? "").startsWith("Stopped after"));
    const checks = (list: typeof rs) => {
      const done = list.filter((r) => !isWorking(r) && r.status !== "waiting_credits");
      return { checked: done.length, failed: done.filter((r) => failedRows.includes(r)).length, siteDown: done.filter((r) => r.status === "site_down").length };
    };
    const state: RunState = {
      target, maxCredits,
      // Counted the same way in test batches, so the rules behave the same there.
      creditsUsed: pages.length + promoted.length,
      leads: promoted.length,
      working,
      waitingCredits,
      pagesRead: pages.length,
      leadsPerPage: pages.map((p) => promoted.filter((r) => r.page === p).length),
      totalPages: (mem?.total_pages as number | null) ?? null,
      nextPage: ((mem?.last_page as number | null) ?? 0) + 1,
      lastPageEmpty: false,
      firecrawlLeft,
      checked: rs.length - working - waitingCredits,
      failed: failedRows.length,
      failedError: (failedRows[0]?.last_error as string | null) ?? null,
      siteDown: rs.filter((r) => r.status === "site_down").length,
      pageChecks: pages.map((p) => checks(rs.filter((r) => r.page === p))),
    };
    const step = nextStep(state);
    if (step.action === "wait") { await unlock(); return "waiting"; }
    if (step.action === "stop") { await unlock({ run_status: "complete", run_note: step.note }); return "stopped"; }

    const page = await claimPage(db, companyId, s.filter_key as string);
    const res = await fetchPageInto(db, searchId, { ...input, page }, depsFor(input), s.filter_key as string);
    // Same "Stopped at …" start as the other stop notes; fetchPageInto already wrote the plain reason.
    if (!res.ok) { await unlock(res.code === "UPSTREAM_APOLLO" ? { run_note: `Stopped at ${promoted.length} of ${target} leads: ${res.message}` } : {}); return "stopped"; }
    // Each page paid for leaves 1 fewer credit for contacts.
    const cap = revealCap(target, maxCredits, pages.length + 1);
    await unlock({
      filters: { ...(s.filters as Record<string, unknown>), max_auto_reveals: cap },
      ...(res.returned === 0 ? { run_status: "complete", run_note: outageNote(state) ?? `Stopped at ${promoted.length} of ${target} leads: Apollo has no more companies for these filters. Add more keywords or countries.` } : {}),
    });
    return "fetched";
  } catch (e) {
    await unlock();
    throw e;
  }
}
