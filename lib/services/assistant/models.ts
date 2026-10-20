// Which model the assistant uses, per provider and per job.
//
// The assistant is multi-model on purpose. A chat question ("how many hot
// leads?") needs a fast, cheap model that calls the right tool and answers in
// two lines; a "why is campaign X weak?" question earns a stronger, slower one.
// So every provider gets three roles:
//
//   fast     — Fast mode answers (the default). Small, quick, cheap.
//   deep     — Deep mode answers. The provider's strongest reasoning model.
//   utility  — tiny side jobs (naming a chat). The cheapest model that works.
//
// Defaults live here; an admin can override fast/deep per provider in
// Credits > AI (stored in `settings` under ASSISTANT_MODELS_SETTING_KEY), so a
// new model never needs a code change.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LlmProviderId } from "@/lib/services/providers/registry";

export type AssistantMode = "fast" | "deep";
export type AssistantModelRole = AssistantMode | "utility";

export type AssistantModelChoice = { fast: string; deep: string; utility: string };

/**
 * Picked from each provider's catalog in Oct 2026, and for Claude by eval
 * (docs/assistant-evals): Fast = Haiku 5.5 ($0.10/$0.50 per Mtok) matched
 * Sonnet 5.5's pass rate at ~1.4x the speed. Deep = Sonnet 5.5, which beat
 * Opus 5.5 over two rounds of the deep set (7/12 vs 5/12 passed, judge 3.58 vs
 * 3.42) at ~23 s vs ~37 s and less than half the cost. OpenRouter spells Claude
 * versions with dots. Groq/Mistral use their stable aliases.
 */
export const ASSISTANT_MODEL_DEFAULTS: Record<LlmProviderId, AssistantModelChoice> = {
  anthropic: { fast: "claude-haiku-5-5", deep: "claude-sonnet-5-5", utility: "claude-haiku-5-5" },
  openrouter: { fast: "anthropic/claude-haiku-5.5", deep: "anthropic/claude-sonnet-5.5", utility: "anthropic/claude-haiku-5.5" },
  openai: { fast: "gpt-6-luna", deep: "gpt-6.1-sol", utility: "gpt-6-luna" },
  gemini: { fast: "gemini-3.8-flash", deep: "gemini-4-argon", utility: "gemini-3.5-flash-lite" },
  mistral: { fast: "mistral-small-latest", deep: "mistral-large-latest", utility: "mistral-small-latest" },
  groq: { fast: "llama-3.3-70b-versatile", deep: "llama-3.3-70b-versatile", utility: "llama-3.3-70b-versatile" },
};

export const ASSISTANT_MODELS_SETTING_KEY = "assistant_models";

export type AssistantModelOverrides = Partial<Record<LlmProviderId, Partial<Pick<AssistantModelChoice, "fast" | "deep">>>>;

export function parseAssistantModelOverrides(raw: string | null | undefined): AssistantModelOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: AssistantModelOverrides = {};
    for (const [provider, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(provider in ASSISTANT_MODEL_DEFAULTS) || !value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const entry: Partial<Pick<AssistantModelChoice, "fast" | "deep">> = {};
      if (typeof v.fast === "string" && v.fast.trim()) entry.fast = v.fast.trim();
      if (typeof v.deep === "string" && v.deep.trim()) entry.deep = v.deep.trim();
      out[provider as LlmProviderId] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

/** Overrides win over defaults; utility is never overridden (it is a cost floor, not a quality choice). */
export function resolveAssistantModel(
  provider: LlmProviderId,
  role: AssistantModelRole,
  overrides: AssistantModelOverrides,
): string {
  const defaults = ASSISTANT_MODEL_DEFAULTS[provider];
  if (role === "utility") return defaults.utility;
  return overrides[provider]?.[role] ?? defaults[role];
}

export async function getAssistantModelOverrides(db: SupabaseClient): Promise<AssistantModelOverrides> {
  const { data } = await db
    .from("settings")
    .select("value")
    .eq("key", ASSISTANT_MODELS_SETTING_KEY)
    .maybeSingle();
  return parseAssistantModelOverrides(data?.value as string | null | undefined);
}

export async function saveAssistantModelOverrides(db: SupabaseClient, overrides: AssistantModelOverrides): Promise<void> {
  const value = JSON.stringify(overrides);
  const now = new Date().toISOString();
  const { data: existing } = await db.from("settings").select("id").eq("key", ASSISTANT_MODELS_SETTING_KEY).maybeSingle();
  if (existing?.id) {
    const { error } = await db.from("settings").update({ value, updated_at: now }).eq("id", existing.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db.from("settings").insert({ key: ASSISTANT_MODELS_SETTING_KEY, value, updated_at: now });
    if (error) throw new Error(error.message);
  }
}
