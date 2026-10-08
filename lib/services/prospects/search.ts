// Step 1 of company-first prospecting: one Apollo Organization Search page
// (1 credit per page of up to 100, https://docs.apollo.io/reference/organization-search).
//
// Order matters for money:
//   1. Credit check first — out of credits = refused, nothing saved.
//   2. A prospect_searches row in status 'paying' is written BEFORE the call.
//   3. The call. On a clean failure the row becomes 'failed'. If the function
//      dies or times out mid-call, the row stays 'paying', which the UI shows
//      as "charge unknown", so a possible charge is never invisible.
//   4. Companies saved (one row per Apollo company per client; a company we
//      already have is skipped, never re-scored), then the row becomes 'done'.
import type { SupabaseClient } from "@supabase/supabase-js";
import { searchOrganizations, type ApolloOrganization } from "@/lib/services/apollo";
import { isApolloMockCompany, mockApolloDelay, mockSearchOrganizations } from "@/lib/services/apollo-mock";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { normalizeDomain } from "@/lib/utils/domain";

export interface ProspectSearchInput {
  keywords: string[];
  locations?: string[];
  employee_ranges?: string[];
  lookalike_org_ids?: string[];
  exclude_websites?: string[];
  page: number;
  batch_name: string;
  color: string;
}

export type SearchOutcome =
  | { ok: true; search_id: string; returned: number; new_companies: number; total_entries: number; credits_spent: number; mock: boolean }
  | { ok: false; status: number; code: string; message: string; search_id?: string };

const safeDomain = (raw: string | null) => {
  if (!raw) return null;
  try { return normalizeDomain(raw); } catch { return raw.trim().toLowerCase(); }
};

type OrgPage = { organizations: ApolloOrganization[]; pagination: { total_entries: number } };

/** Swappable for tests; defaults are the real Apollo calls (or fixtures in mock mode). */
export interface SearchDeps {
  mock: boolean;
  creditsLeft(): Promise<number | null>;
  search(input: ProspectSearchInput): Promise<OrgPage>;
}

export function defaultSearchDeps(db: SupabaseClient, companyId: string): SearchDeps {
  const mock = isApolloMockCompany(companyId);
  return {
    mock,
    creditsLeft: async () => (mock ? null : (await checkApolloCredits(db, "any" /* one shared Apollo account */, { fresh: true })).remaining),
    search: async (input) => {
      if (mock) {
        await mockApolloDelay();
        return mockSearchOrganizations({ name: input.keywords.join(" "), locations: input.locations, page: input.page });
      }
      return searchOrganizations({
        locations: input.locations,
        page: input.page,
        advanced: {
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
export async function runProspectSearch(db: SupabaseClient, companyId: string, userId: string, input: ProspectSearchInput, deps: SearchDeps = defaultSearchDeps(db, companyId)): Promise<SearchOutcome> {
  const mock = deps.mock;

  if (!mock) {
    const left = await deps.creditsLeft();
    if (left !== null && left < 1) {
      return { ok: false, status: 402, code: "APOLLO_OUT_OF_CREDITS", message: "Apollo has no credits left. Nothing was searched or charged." };
    }
  }

  const { data: search, error: sErr } = await db.from("prospect_searches")
    .insert({ created_by: userId, filters: input, page: input.page, status: "paying", mock })
    .select("id").single();
  if (sErr || !search) return { ok: false, status: 500, code: "INTERNAL", message: `Could not start search: ${sErr?.message}` };
  const searchId = search.id as string;

  let orgs: ApolloOrganization[];
  let total: number;
  try {
    const res = await deps.search(input);
    orgs = res.organizations;
    total = res.pagination.total_entries;
  } catch (err) {
    const status = (err as { status?: number }).status;
    const msg = (err as Error).message.slice(0, 500);
    // An HTTP error answer means Apollo refused (no charge). No answer at all
    // (timeout, network) means we can't know — leave it 'paying'.
    if (status) await db.from("prospect_searches").update({ status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", searchId);
    else await db.from("prospect_searches").update({ error: `No answer from Apollo — charge unknown: ${msg}`, updated_at: new Date().toISOString() }).eq("id", searchId);
    return { ok: false, status: 502, code: "UPSTREAM_APOLLO", message: msg, search_id: searchId };
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
        name: o.name ?? "Unknown company",
        domain: safeDomain(o.primary_domain),
        website_url: o.website_url,
        linkedin_url: o.linkedin_url,
        twitter_url: o.twitter_url,
        facebook_url: o.facebook_url,
        apollo_raw: o.raw,
      })),
      { onConflict: "apollo_org_id", ignoreDuplicates: true }, // same company from an earlier search: keep the first
    ).select("id");
    if (error) {
      await db.from("prospect_searches").update({ error: `Paid, but saving companies failed: ${error.message}`, updated_at: new Date().toISOString() }).eq("id", searchId);
      return { ok: false, status: 500, code: "INTERNAL", message: error.message, search_id: searchId };
    }
    inserted = data?.length ?? 0;
  }

  // Apollo bills nothing for an empty page (measured 18 Aug 2026, see company-search).
  const creditsSpent = !mock && orgs.length > 0 ? 1 : 0;
  await db.from("prospect_searches").update({
    status: "done", credits_spent: creditsSpent, returned: orgs.length, new_companies: inserted, total_entries: total, updated_at: new Date().toISOString(),
  }).eq("id", searchId);

  // Same ledger row company-search writes, so Settings > Keys > Usage counts it.
  if (creditsSpent) {
    await db.from("enrichment_logs").insert({
      source: "apollo", event: "CREDITS_CONSUMED",
      payload: { stage: "prospect_search", search_id: searchId, keywords: input.keywords, page: input.page, returned: orgs.length, credits_consumed: 1 },
    });
  }

  return { ok: true, search_id: searchId, returned: orgs.length, new_companies: inserted, total_entries: total, credits_spent: creditsSpent, mock };
}
