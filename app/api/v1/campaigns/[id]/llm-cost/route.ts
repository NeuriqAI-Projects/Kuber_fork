import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { assertCampaignAccess } from "@/lib/auth/scope";
import { dbForUser } from "@/lib/supabase/scoped";

// llm_usage started recording on 30 Aug 2026 — see 2026_08_30_llm_usage.sql.
// A campaign created before that date will show a partial or zero total, not
// because nothing was spent, but because nothing was recorded yet. The UI
// surfaces this date so that isn't read as "this campaign cost nothing".
// Not exported: a route file may only export HTTP handlers and Next's own
// config keys, and anything else fails `next build` with an unhelpful
// "does not satisfy the constraint" type error.
const LLM_COST_TRACKING_STARTED_AT = "2026-08-30T00:00:00Z";

const PURPOSE_LABELS: Record<string, string> = {
  draft: "Opening drafts",
  followup: "Follow-ups",
  reply: "Reply handling",
  enrichment: "Enrichment",
  classify: "Classification",
  other: "Other",
};

/**
 * What this campaign has spent on LLM calls — drafts, follow-ups, and any
 * reply/classify work tied to it via campaign_id. Apollo credit spend and
 * Firecrawl scrape cost are NOT included here: neither is attributed to a
 * campaign anywhere in the data model yet (both happen at the organization
 * level, before a lead is ever attached to a campaign) — see the Sequences
 * tab work this follows for the same gap on the Apollo/Firecrawl side.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);
  try { await assertCampaignAccess(db, user, id); } catch (r) { return r as Response; }

  const { data: rows, error } = await db
    .from("llm_usage")
    .select("purpose, model, cost_usd, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, error, created_at")
    .eq("campaign_id", id);

  if (error) return fail(500, "INTERNAL", error.message);

  let totalCostUsd = 0;
  let hasKnownCost = false;
  let unknownCostCalls = 0;
  let failedCalls = 0;
  const totalCalls = rows?.length ?? 0;
  let totalTokens = 0;

  const byPurpose = new Map<string, { calls: number; costUsd: number; hasUnknownCost: boolean; tokens: number }>();

  for (const row of rows ?? []) {
    const purpose = row.purpose ?? "other";
    const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0) + (row.cache_write_tokens ?? 0) + (row.cache_read_tokens ?? 0);
    totalTokens += tokens;
    if (row.error) failedCalls++;

    const bucket = byPurpose.get(purpose) ?? { calls: 0, costUsd: 0, hasUnknownCost: false, tokens: 0 };
    bucket.calls++;
    bucket.tokens += tokens;

    if (row.cost_usd == null) {
      unknownCostCalls++;
      bucket.hasUnknownCost = true;
    } else {
      totalCostUsd += Number(row.cost_usd);
      hasKnownCost = true;
      bucket.costUsd += Number(row.cost_usd);
    }
    byPurpose.set(purpose, bucket);
  }

  const purposes = [...byPurpose.entries()]
    .map(([purpose, v]) => ({
      purpose,
      label: PURPOSE_LABELS[purpose] ?? purpose,
      calls: v.calls,
      costUsd: v.costUsd,
      hasUnknownCost: v.hasUnknownCost,
      tokens: v.tokens,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return ok({
    totalCostUsd,
    hasKnownCost,
    totalCalls,
    failedCalls,
    unknownCostCalls,
    totalTokens,
    purposes,
    trackingStartedAt: LLM_COST_TRACKING_STARTED_AT,
  });
}
