import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";
import { jevUsd, tavilyCallsOf, type ProspectUsageRow } from "@/lib/services/prospects/usage";

/**
 * What THIS campaign has used, per service.
 *
 * Nothing but the AI calls is tagged with a campaign: email reveals, website reads and
 * company scoring all happen to a company before any lead joins a campaign. So the rest is
 * worked out from the campaign's own leads and their companies:
 *   Apollo     one credit per lead whose email came from Apollo (reveal)
 *   Firecrawl  one credit per distinct company whose website was read
 *   Jev        companies scored by Scored Companies (tokens and estimated $)
 *   Tavily     LinkedIn reads and web searches Scored Companies made for those companies
 *   AI         llm_usage rows tagged with this campaign (exact)
 *   Instantly  emails sent (Instantly has no credits, so this is volume)
 * `exact` says which numbers are counted and which are derived.
 */
const CHUNK = 200;
async function inChunks<T>(ids: string[], fn: (chunk: string[]) => PromiseLike<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  try {
    const cls: { lead_id: string; first_sent_at: string | null }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("campaign_leads").select("lead_id, first_sent_at").eq("campaign_id", id).range(from, from + 999);
      if (error) throw new Error(error.message);
      cls.push(...((data ?? []) as typeof cls));
      if ((data?.length ?? 0) < 1000) break;
    }
    const leadIds = cls.map((c) => c.lead_id);
    const emailsSent = cls.filter((c) => c.first_sent_at).length;

    const leads = await inChunks(leadIds, async (ids) =>
      ((await db.from("leads").select("id, organization_id, lead_source, email").in("id", ids)).data ?? []) as { id: string; organization_id: string | null; lead_source: string | null; email: string | null }[]);
    const apolloReveals = leads.filter((l) => l.lead_source === "apollo" && !!l.email).length;
    const orgIds = [...new Set(leads.map((l) => l.organization_id).filter((x): x is string => !!x))];

    const orgs = await inChunks(orgIds, async (ids) =>
      ((await db.from("organizations").select("id, scraped_at").in("id", ids)).data ?? []) as { id: string; scraped_at: string | null }[]);
    const websitesRead = orgs.filter((o) => !!o.scraped_at).length;

    const prospects = await inChunks(orgIds, async (ids) =>
      ((await db.from("prospect_companies").select("id, name, status, score, updated_at, jev_tokens, text_source, extra_sources").in("organization_id", ids)).data ?? []) as ProspectUsageRow[]);
    const jevRows = prospects.filter((p) => p.jev_tokens > 0);
    const jevTokens = jevRows.reduce((n, p) => n + p.jev_tokens, 0);
    let tavilyLinkedin = 0, tavilySearch = 0;
    for (const p of prospects) { const c = tavilyCallsOf(p); tavilyLinkedin += c.linkedin; tavilySearch += c.search; }

    const { data: llm, error: llmErr } = await db.from("llm_usage").select("cost_usd, input_tokens, output_tokens, error").eq("campaign_id", id);
    if (llmErr) throw new Error(llmErr.message);
    const aiCalls = llm?.length ?? 0;
    const aiCost = (llm ?? []).reduce((n, r) => n + Number(r.cost_usd ?? 0), 0);
    const aiTokens = (llm ?? []).reduce((n, r) => n + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);

    return ok({
      leads: leadIds.length, companies: orgIds.length,
      apollo: { credits: apolloReveals, exact: false },
      firecrawl: { credits: websitesRead, exact: false },
      jev: { companies: jevRows.length, tokens: jevTokens, usd: jevUsd(jevTokens), exact: false },
      tavily: { linkedinReads: tavilyLinkedin, webSearches: tavilySearch, calls: tavilyLinkedin + tavilySearch, exact: false },
      ai: { calls: aiCalls, usd: aiCost, tokens: aiTokens, failed: (llm ?? []).filter((r) => r.error).length, exact: true },
      instantly: { emailsSent, exact: true },
    });
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
