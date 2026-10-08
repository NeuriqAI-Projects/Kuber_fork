// Real (and mock) outside services for the prospect pipeline.
//
// MOCK: isApolloMockCompany() is true for every non-production run and for the
// Dev workspace in production. Then nothing paid is ever called: Firecrawl,
// Jev, Tavily and Apollo are all fakes, and promoted leads get their email
// written up front so the reveal job never claims them (same trick as
// company-import).
import type { SupabaseClient } from "@supabase/supabase-js";
import { scrapePage } from "@/lib/services/firecrawl";
import { searchPeople } from "@/lib/services/apollo";
import { isApolloMockCompany, mockRevealedEmail, mockSearchPeople } from "@/lib/services/apollo-mock";
import { checkApolloCredits } from "@/lib/services/provider-credits";
import { getServiceSecret } from "@/lib/services/service-keys";
import { createScopedClient } from "@/lib/supabase/scoped";
import { normalizeDomain } from "@/lib/utils/domain";
import { jevScore, type JevScore } from "./jev";
import { tavilyExtract, tavilySearch } from "./tavily";
import type { FitScoring } from "./fit-rules";
import type { Deps, HomeRead, Person, ProspectRow } from "./pipeline";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36" };

async function freeGet(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(10_000) });
    return r.ok ? (await r.text()).slice(0, 500_000) : null;
  } catch { return null; }
}

/** Firecrawl failures that are about OUR account (retry), not the target site. */
const PROVIDER_FAULT = /No usable Firecrawl key|HTTP (401|402|403|429)\b/;

async function readHomeFirecrawl(url: string, companyId: string): Promise<HomeRead> {
  const r = await scrapePage(url, companyId);
  if (!r.success) {
    if (PROVIDER_FAULT.test(r.error ?? "")) throw new Error(`Firecrawl: ${r.error}`);
    return { kind: "site_down", detail: `Website could not be read (${r.error ?? "unknown"})` };
  }
  const code = r.data?.metadata?.statusCode ?? 200;
  if (code >= 400) return { kind: "site_down", detail: `Website answered HTTP ${code}` };
  return { kind: "ok", markdown: r.data?.markdown ?? "" };
}

async function need(provider: "jev" | "tavily", companyId: string): Promise<string> {
  const s = await getServiceSecret(provider, companyId);
  if (!s) throw new Error(`${provider === "jev" ? "Jev" : "Tavily"} API key not configured — add one in Settings > Keys`);
  return s;
}

/** Credits free for NEW reveals: balance minus reveals already queued (Apollo is one shared account). */
async function apolloCreditsFree(admin: SupabaseClient): Promise<number | null> {
  const c = await checkApolloCredits(admin, "any");
  if (c.remaining == null) return null;
  const { count } = await admin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("has_email", true).is("email", null).eq("is_deleted", false);
  return c.remaining - (count ?? 0);
}

/** `db` must be company-scoped (stamps + filters company_id). Exported for tests. */
export async function promote(db: SupabaseClient, row: ProspectRow, person: Person, mock: boolean, importId: string | null): Promise<string> {
  let domain: string | null = null;
  try { domain = row.domain ? normalizeDomain(row.domain) : null; } catch { domain = row.domain; }

  // Idempotent: a re-run after a crash finds what the first run created.
  let orgId: string | null = null;
  const byApollo = await db.from("organizations").select("id").eq("apollo_org_id", row.apollo_org_id).maybeSingle();
  orgId = (byApollo.data?.id as string | undefined) ?? null;
  if (!orgId && domain) {
    const byDomain = await db.from("organizations").select("id").eq("domain", domain).maybeSingle();
    orgId = (byDomain.data?.id as string | undefined) ?? null;
  }
  if (!orgId) {
    const fresh = !!row.page_markdown;
    const ins = await db.from("organizations").insert({
      apollo_org_id: row.apollo_org_id,
      name: row.name,
      domain,
      domain_source: domain ? "apollo" : null,
      website: row.website_url,
      enrichment_stage: mock ? "done" : "queued",
      enrichment_status: mock ? "ENRICHMENT_COMPLETE" : "SCRAPE_QUEUED",
      enrichment_attempts: 0,
      // The page we already paid Firecrawl for: scrape-orgs reuses a scrape
      // younger than 7 days, so the profile step costs no second credit.
      scraped_markdown: fresh ? row.page_markdown : null,
      scraped_at: fresh ? new Date().toISOString() : null,
    }).select("id").single();
    if (ins.error) {
      const again = await db.from("organizations").select("id").eq("apollo_org_id", row.apollo_org_id).maybeSingle();
      if (!again.data) throw new Error(`Could not create organization: ${ins.error.message}`);
      orgId = again.data.id as string;
    } else orgId = ins.data.id as string;
  }

  // One lead per company: if the org already holds a contact other than this
  // person (it reached the system another way since the search), add nobody.
  // The same person from an earlier, interrupted run is fine — the upsert
  // below ignores the duplicate.
  const { count: others } = await db.from("leads").select("id", { count: "exact", head: true })
    .eq("organization_id", orgId).eq("is_deleted", false).neq("apollo_id", person.id);
  if ((others ?? 0) > 0) return orgId;

  // One lead. has_email=true + email=null is what the reveal job buys; a mock
  // lead gets its email now so it is never bought.
  const lead = await db.from("leads").upsert({
    apollo_id: person.id,
    first_name: person.first_name ?? null,
    title: person.title,
    has_email: true,
    email: mock ? mockRevealedEmail(person.first_name ?? null, domain) : null,
    email_status: mock ? "verified" : null,
    city: person.city ?? null,
    state: person.state ?? null,
    country: person.country ?? null,
    organization_id: orgId,
    lead_source: "apollo",
    import_id: importId,
  }, { onConflict: "apollo_id", ignoreDuplicates: true });
  if (lead.error) throw new Error(`Could not create lead: ${lead.error.message}`);
  return orgId;
}

export function realDeps(admin: SupabaseClient, companyId: string, cfg: FitScoring, importIdFor: (searchId: string) => Promise<string | null>): Deps {
  return {
    now: () => Date.now(),
    readHome: (url) => readHomeFirecrawl(url, companyId),
    freeGet,
    tavilyExtract: async (url) => tavilyExtract(await need("tavily", companyId), url),
    tavilySearch: async (q) => tavilySearch(await need("tavily", companyId), q),
    score: async (name, text) => jevScore(await need("jev", companyId), cfg, name, text),
    apolloCreditsFree: () => apolloCreditsFree(admin),
    findPeople: async (orgId) => (await searchPeople({ organizationIds: [orgId], page: 1 })).people,
    promote: async (row, person) => promote(createScopedClient(companyId), row, person, false, await importIdFor(row.search_id)),
  };
}

// ── Mock ────────────────────────────────────────────────────────────────────
// Deterministic fakes driven by the company name, so a mock search shows all
// three buckets: names with plastic words score high, trade/distribution
// names land in Review, everything else is hidden.
const PLASTIC = /plast|poly|pack|film|mould|mold|pipe|extru|pet\b|bottle/i;
const UNSURE = /trad|distrib|group|holding|industr/i;

function mockText(name: string): string {
  if (PLASTIC.test(name)) return `${name} runs blown film and injection moulding lines making coloured packaging for food brands. Three plants, 400 staff.`.repeat(3);
  if (UNSURE.test(name)) return `${name} supplies industrial materials to manufacturers across the region.`.repeat(4);
  return `${name} provides consulting and software services to banks and retailers.`.repeat(4);
}

function mockScore(name: string, text: string): JevScore {
  const score = /blown film|injection/i.test(text) ? 9 : PLASTIC.test(name) ? 8 : UNSURE.test(name) ? 5 : 2;
  return { score, confidence: 0.8, reason: score >= 7 ? "converter · film_extrusion · food_packaging · size medium" : score >= 4 ? "unclear · not_stated · industrial · size not_stated" : "non_manufacturer · not_stated · other · size not_stated", model: "mock", input_tokens: Math.ceil(text.length / 4), answers: {} };
}

export function mockDeps(companyId: string, importIdFor: (searchId: string) => Promise<string | null>): Deps {
  const pause = () => new Promise((r) => setTimeout(r, 150));
  return {
    now: () => Date.now(),
    readHome: async (url) => { await pause(); return /down|offline/i.test(url) ? { kind: "site_down", detail: "Website answered HTTP 503 (mock)" } : { kind: "ok", markdown: mockText(new URL(url).hostname) }; },
    freeGet: async () => null,
    tavilyExtract: async (url) => { await pause(); return mockText(url.split("/").filter(Boolean).pop() ?? "company"); },
    tavilySearch: async () => "",
    score: async (name, text) => { await pause(); return mockScore(name, text); },
    apolloCreditsFree: async () => 100,
    findPeople: async (orgId) => mockSearchPeople({ organizationIds: [orgId] }).people,
    promote: async (row, person) => promote(createScopedClient(companyId), row, person, true, await importIdFor(row.search_id)),
  };
}

export const isMockProspecting = isApolloMockCompany;
