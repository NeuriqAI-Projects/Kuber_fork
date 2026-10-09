// Shared types for the multi-provider key/model system (Settings > Keys).
// New providers slot into ProviderId without touching the DB — `provider` is
// an unconstrained text column, validated against the code registry instead.
//
// Two categories, because the UI treats them differently:
//   • "llm"     — interchangeable, tried in order, each carries a model choice.
//   • "service" — a fixed integration (Apollo, Instantly, Firecrawl). Exactly
//     one is not substitutable for another, so there is no try-order and no
//     model; the app either has a working key for it or that feature is down.
export type ProviderCategory = "llm" | "service";

export type ProviderId =
  | "openrouter"
  | "openai"
  | "anthropic"
  | "gemini"
  | "mistral"
  | "groq"
  | "firecrawl"
  | "apollo"
  | "instantly";

export interface CompletionOpts {
  system: string;
  user: string;
  // Cap the response size. Without this, some providers default to the
  // model's full context and, on low balance, reject the request even
  // though the actual output is tiny.
  maxTokens?: number;
  // Sampling randomness. Omit to get the drafting default (see
  // DEFAULT_TEMPERATURE in registry.ts) — callers only set this when a task
  // genuinely wants more variety than rule-following.
  temperature?: number;
  /**
   * Run THIS model instead of the company's configured one, on THIS provider
   * instead of the normal tier order. Model Lab only: it writes the same email
   * with seven models side by side, and the alternative — rewriting
   * provider_settings.selected_model before each one — would change what
   * production writes for as long as the comparison ran.
   *
   * Everything else stays normal: the company's own keys, key rotation, usage
   * logging and cost. Leave unset and nothing about this call changes.
   */
  model?: string;
  provider?: ProviderId;
}

/**
 * Provider-specific request config that is a property of the KEY, not of the
 * call. Resolved once per attempt in tryProvider() and handed to the call fn.
 */
export interface ProviderCallConfig {
  /**
   * Anthropic only. An identity-linked (multi-workspace) API key is rejected
   * with a 400 unless every request names the workspace it acts in:
   *
   *   "anthropic-workspace-id is required when authenticating with an
   *    identity-linked API key"
   *
   * A plain single-workspace key does not need this and ignores it, so the
   * header is only sent when a value is configured.
   */
  workspaceId?: string | null;
}

export type CreditCheck = {
  ok: boolean;
  remaining: number | null;
  message: string;
  /** Plan entitlement / pool size when the provider reports one (Apollo, Firecrawl). */
  limit?: number | null;
  /** Current billing-period bounds when the provider reports them (Firecrawl). */
  billingPeriodStart?: string | null;
  billingPeriodEnd?: string | null;
};
