/**
 * What a call cost, in USD.
 *
 * Prices are per MILLION tokens, taken from each provider's public pricing.
 * They are a cache, not a source of truth — a provider can change them without
 * telling us — so the rule below matters more than the numbers:
 *
 *   an unknown model returns NULL, never 0.
 *
 * A zero would silently understate every total and nobody would notice. A null
 * is visible: the row is there, the tokens are there, and the cost column says
 * "we do not know", which is a question someone can answer.
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic bills cache writes ~1.25x input and reads ~0.1x. Recorded
   *  separately so the cost maths can become exact later without a schema change. */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  /** Some providers (OpenRouter) return the cost themselves. When they do it is
   *  authoritative — it accounts for their own margin and per-model routing,
   *  which no local table can track. */
  costUsd?: number | null;
}

/** [input $/1M, output $/1M] */
type Price = readonly [number, number];

/**
 * Keyed by the model id as we send it. Anthropic ids are matched by PREFIX so a
 * dated snapshot (claude-sonnet-5-20260101) resolves to the same price as its
 * base id — the alternative is a null cost every time a provider pins a date.
 */
const PRICES: Record<string, Price> = {
  // ── Anthropic (direct) ────────────────────────────────────────────────────
  "claude-fable-5":    [10, 50],
  "claude-mythos-5":   [10, 50],
  "claude-opus-5":     [5, 25],
  "claude-opus-4-8":   [5, 25],
  "claude-opus-4-7":   [5, 25],
  "claude-opus-4-6":   [5, 25],
  "claude-sonnet-5":   [2, 10],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5":  [1, 5],

  // ── OpenAI ────────────────────────────────────────────────────────────────
  "gpt-4o":      [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};

function lookup(model: string): Price | null {
  const m = model.trim().toLowerCase();
  if (PRICES[m]) return PRICES[m];
  // Prefix match, longest first, so claude-opus-4-8 wins over claude-opus-4.
  const hit = Object.keys(PRICES)
    .filter((k) => m.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? PRICES[hit] : null;
}

/**
 * Cost of one call, or null when the model's price is unknown.
 *
 * `usage.costUsd` wins when the provider supplied one — OpenRouter does, and its
 * figure includes routing and margin that a local table cannot know.
 *
 * `provider` selects the cache-token multiplier. Anthropic publishes exact
 * rates for this — cache writes bill at 1.25x the input rate, cache reads at
 * 0.1x (https://docs.claude.com/en/docs/build-with-claude/prompt-caching) — so
 * applying them isn't a guess, it's using a known number instead of a wrong
 * one. Charging cache reads at the full input rate (the old behavior) visibly
 * overstated cost: a campaign that reuses the same system prompt/product list
 * across hundreds of calls does almost all of its input through the cache, and
 * 1x instead of 0.1x on that volume alone can be most of the inflation. Any
 * other provider still gets the conservative full-rate fold-in, since we don't
 * have a published multiplier for it — an unknown discount is not applied.
 */
export function costOf(model: string, usage: TokenUsage, provider?: string): number | null {
  if (typeof usage.costUsd === "number") return usage.costUsd;

  // An OpenRouter model id is "vendor/model"; price the model part.
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  const price = lookup(bare);
  if (!price) return null;

  const [inPer, outPer] = price;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;

  const cacheWriteMultiplier = provider === "anthropic" ? 1.25 : 1;
  const cacheReadMultiplier = provider === "anthropic" ? 0.1 : 1;

  const input = usage.inputTokens
    + cacheWrite * cacheWriteMultiplier
    + cacheRead * cacheReadMultiplier;
  return (input / 1e6) * inPer + (usage.outputTokens / 1e6) * outPer;
}

/** True when we can price this model at all — used to decide whether a null
 *  cost is expected (new model) or a bug (known model, missing usage). */
export function isPriceKnown(model: string): boolean {
  const bare = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
  return lookup(bare) !== null;
}
