// Assistant spend, one llm_usage row per answered turn, tagged with the user.
//
// llm_usage gained a user_id column for this (migration
// 2026_10_19_assistant.sql) so a manager can see who used how much AI. Until
// that migration is run the insert is retried without user_id — a lost
// attribution is an accounting gap, a lost row is a hole in the bill.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LanguageModelUsage } from "ai";
import { costOf, type TokenUsage } from "@/lib/services/llm-pricing";

/** AI SDK usage → the token shape llm-pricing expects (input = uncached input only). */
export function toTokenUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const cacheRead = usage?.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
  const total = usage?.inputTokens ?? 0;
  const noCache = usage?.inputTokenDetails?.noCacheTokens ?? Math.max(0, total - cacheRead - cacheWrite);
  return {
    inputTokens: noCache,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

export async function recordAssistantUsage(
  db: SupabaseClient,
  row: {
    companyId: string;
    userId: string;
    provider: string;
    model: string;
    tier: number;
    usage: TokenUsage;
    durationMs: number;
    error: string | null;
  },
): Promise<number | null> {
  const costUsd = row.error ? null : costOf(row.model, row.usage, row.provider);
  const base = {
    company_id: row.companyId,
    provider: row.provider,
    model: row.model,
    tier: row.tier,
    purpose: "assistant",
    input_tokens: row.usage.inputTokens,
    output_tokens: row.usage.outputTokens,
    cache_write_tokens: row.usage.cacheWriteTokens ?? 0,
    cache_read_tokens: row.usage.cacheReadTokens ?? 0,
    cost_usd: costUsd,
    duration_ms: row.durationMs,
    error: row.error ? row.error.slice(0, 500) : null,
    created_at: new Date().toISOString(),
  };
  try {
    const { error } = await db.from("llm_usage").insert({ ...base, user_id: row.userId });
    if (error) await db.from("llm_usage").insert(base);
  } catch { /* accounting must never break the answer */ }
  return costUsd;
}
