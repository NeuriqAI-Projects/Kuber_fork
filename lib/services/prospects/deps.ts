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
import { jevCheck, type JevVerdict, type SearchedFor } from "./jev";
import { tavilyExtract, tavilySearch } from "./tavily";
import { OutOfTime, type Deps, type HomeRead, type Person, type ProspectRow } from "./pipeline";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36" };

async function freeGet(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(6_000) });
    return r.ok ? (await r.text()).slice(0, 500_000) : null;
  } catch { return null; }
}

/** Firecrawl failures that are about OUR account (retry), not the target site. */
const PROVIDER_FAULT = /No usable Firecrawl key|HTTP (401|402|403|429)\b/;

/** At most `n` calls at once in this process; the rest wait their turn. */
export function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((go) => waiting.push(go));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

/** Firecrawl Hobby allows 5 pages at once (https://docs.firecrawl.dev/rate-limits).
 *  4 here leaves one for the normal enrichment job, which shares the account. */
const firecrawlSlot = limiter(4);

async function readHomeFirecrawl(url: string, companyId: string, startBy: number): Promise<HomeRead> {
  // Checked AFTER waiting for a slot: the wait itself can eat the run's time.
  const r = await firecrawlSlot(() => {
    if (Date.now() > startBy) throw new OutOfTime();
    return scrapePage(url, companyId);
  });
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
export async function promote(db: SupabaseClient, row: ProspectRow, person: Person, mock: boolean, batch: { importId: string | null; createdBy: string | null }): Promise<string> {
  if (!batch.createdBy) throw new Error("Search has no creator to record on the lead");
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
    import_id: batch.importId,
    created_by: batch.createdBy,
  }, { onConflict: "apollo_id", ignoreDuplicates: true });
  if (lead.error) throw new Error(`Could not create lead: ${lead.error.message}`);
  return orgId;
}

/** What each search was run for (its keyword labels + batch name), fetched once per search per run. */
function searchedForLookup(companyId: string) {
  const db = createScopedClient(companyId);
  const cache = new Map<string, Promise<SearchedFor>>();
  return (searchId: string) => {
    if (!cache.has(searchId)) {
      cache.set(searchId, (async () => {
        const { data } = await db.from("prospect_searches").select("filters").eq("id", searchId).maybeSingle();
        const f = (data?.filters ?? {}) as { batch_name?: string; keyword_labels?: string[]; keywords?: string[] };
        return { segment: f.batch_name ?? null, keywords: f.keyword_labels ?? f.keywords ?? [] };
      })());
    }
    return cache.get(searchId)!;
  };
}

type BatchFor = (searchId: string) => Promise<{ importId: string | null; createdBy: string | null }>;

export function realDeps(admin: SupabaseClient, companyId: string, batchFor: BatchFor): Deps {
  const searchedFor = searchedForLookup(companyId);
  return {
    now: () => Date.now(),
    readHome: (url, startBy) => readHomeFirecrawl(url, companyId, startBy),
    freeGet,
    tavilyExtract: async (url) => tavilyExtract(await need("tavily", companyId), url),
    tavilySearch: async (q) => tavilySearch(await need("tavily", companyId), q),
    score: async (row, text) => jevCheck(await need("jev", companyId), { name: row.name, website: row.domain }, await searchedFor(row.search_id), text),
    apolloCreditsFree: () => apolloCreditsFree(admin),
    findPeople: async (orgId) => (await searchPeople({ organizationIds: [orgId], page: 1 })).people,
    promote: async (row, person) => promote(createScopedClient(companyId), row, person, false, await batchFor(row.search_id)),
  };
}

// ── Mock ────────────────────────────────────────────────────────────────────
// Mock company names all contain the search keywords, so the fake answers are
// spread by a hash of the name: every list (good, your decision, hidden,
// website down → LinkedIn) gets examples. Delays match the live 100-company run
// (Firecrawl ~3.7 s average, Jev ~0.4 s), so the progress screen behaves like
// the real thing.
const hashOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const MOCK_PLASTIC = [0.92, 0.85, 0.8, 0.9, 0.5, 0.55, 0.12, 0.2, 0.05, 0.88];
const mockText = (name: string) => `${name} (mock page text, no real website was read). `.repeat(6);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockVerdict(row: ProspectRow, text: string): JevVerdict {
  const h = hashOf(row.name);
  return { plastic: MOCK_PLASTIC[h % MOCK_PLASTIC.length], on_target: h % 3 === 0 ? 0.2 : 0.85, model: "mock", input_tokens: Math.ceil(text.length / 4), answers: {} };
}

/**
 * Test scenarios for the Dev workspace, switched on by a word in the BATCH NAME
 * (so a tester can see every screen state without real failures):
 *   [no-credits]       Apollo has no credits: good fits wait for credits
 *   [credits-run-out]  credits for 3 reveals, then none (runs out midway)
 *   [sites-down]       every website is down (→ LinkedIn, or "Website down")
 *   [jev-down]         the AI service fails every time (→ 3 tries → your decision)
 *   [flaky]            ~30% of website reads and AI calls fail (→ retries)
 * Search-side words ([apollo-down], [apollo-timeout], [apollo-0], [apollo-empty]) are in search.ts.
 */
export const mockFlag = (batchName: string | null | undefined, flag: string) => (batchName ?? "").toLowerCase().includes(`[${flag}]`);
const mockRevealsUsed = new Map<string, number>();

export function mockDeps(companyId: string, batchFor: BatchFor): Deps {
  const searchedFor = searchedForLookup(companyId);
  const flag = async (row: ProspectRow, f: string) => mockFlag((await searchedFor(row.search_id)).segment, f);
  const flaky = async (row: ProspectRow) => { if ((await flag(row, "flaky")) && Math.random() < 0.3) throw new Error("Network error (mock)"); };
  return {
    now: () => Date.now(),
    // Every 7th site is "down", to show the website-down → LinkedIn path.
    readHome: (url, startBy, row) => firecrawlSlot(async () => {
      if (Date.now() > startBy) throw new OutOfTime();
      await wait(1500 + (hashOf(url) % 4000));
      await flaky(row);
      if (hashOf(url) % 7 === 0 || (await flag(row, "sites-down"))) return { kind: "site_down", detail: "Website answered HTTP 503 (mock)" };
      return { kind: "ok", markdown: mockText(new URL(url).hostname) };
    }),
    freeGet: async () => null,
    tavilyExtract: async (url) => { await wait(2000); return mockText(url.split("/").filter(Boolean).pop() ?? "company"); },
    tavilySearch: async () => "",
    score: async (row, text) => {
      await wait(400);
      if (await flag(row, "jev-down")) throw new Error("JEV_HTTP_503 (mock)");
      await flaky(row);
      return mockVerdict(row, text);
    },
    apolloCreditsFree: async (row) => {
      if (await flag(row, "no-credits")) return 0;
      if (await flag(row, "credits-run-out")) return Math.max(0, 3 - (mockRevealsUsed.get(row.search_id) ?? 0));
      return 100;
    },
    findPeople: async (orgId) => mockSearchPeople({ organizationIds: [orgId] }).people,
    promote: async (row, person) => {
      mockRevealsUsed.set(row.search_id, (mockRevealsUsed.get(row.search_id) ?? 0) + 1);
      return promote(createScopedClient(companyId), row, person, true, await batchFor(row.search_id));
    },
  };
}

export const isMockProspecting = isApolloMockCompany;
