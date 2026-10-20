/** npx tsx --test lib/services/assistant/models.test.mts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ASSISTANT_MODEL_DEFAULTS, parseAssistantModelOverrides, resolveAssistantModel } from "./models.ts";
import { toTokenUsage } from "./usage.ts";
import { costOf } from "../llm-pricing.ts";
import { anthropicRejectsForcedToolChoice, anthropicRejectsTemperature } from "../providers/registry.ts";

test("every provider has a fast, deep and utility model", () => {
  for (const [p, m] of Object.entries(ASSISTANT_MODEL_DEFAULTS)) {
    assert.ok(m.fast && m.deep && m.utility, p);
  }
});

test("overrides win for fast/deep, never for utility", () => {
  const o = parseAssistantModelOverrides(JSON.stringify({ anthropic: { fast: "claude-sonnet-5-5" }, bogus: { fast: "x" } }));
  assert.equal(resolveAssistantModel("anthropic", "fast", o), "claude-sonnet-5-5");
  assert.equal(resolveAssistantModel("anthropic", "deep", o), ASSISTANT_MODEL_DEFAULTS.anthropic.deep);
  assert.equal(resolveAssistantModel("anthropic", "utility", o), ASSISTANT_MODEL_DEFAULTS.anthropic.utility);
  assert.equal("bogus" in o, false);
});

test("bad settings JSON falls back to defaults", () => {
  assert.deepEqual(parseAssistantModelOverrides("{not json"), {});
  assert.deepEqual(parseAssistantModelOverrides(null), {});
  assert.deepEqual(parseAssistantModelOverrides("[1,2]"), {});
});

test("AI SDK usage → uncached input, so cache reads are not double counted", () => {
  const u = toTokenUsage({
    inputTokens: 10_000, outputTokens: 200,
    inputTokenDetails: { noCacheTokens: 1_000, cacheReadTokens: 9_000, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
  } as never);
  assert.deepEqual(u, { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 9_000, cacheWriteTokens: 0 });
});

test("Claude 5.5 prices: explicit, and dotted OpenRouter ids price the same", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };
  assert.equal(costOf("claude-opus-5-5", usage), 4); // not Opus 5's $5
  assert.equal(costOf("claude-haiku-5-5", usage), 0.1);
  assert.equal(costOf("anthropic/claude-sonnet-5.5", usage), 2);
  assert.equal(costOf("some-unknown-model", usage), null);
});

test("Claude 5.5 request quirks", () => {
  assert.equal(anthropicRejectsForcedToolChoice("claude-sonnet-5-5"), true);
  assert.equal(anthropicRejectsForcedToolChoice("claude-opus-5-5"), true);
  assert.equal(anthropicRejectsForcedToolChoice("claude-sonnet-5"), false);
  assert.equal(anthropicRejectsForcedToolChoice("claude-haiku-5-5"), false);
  assert.equal(anthropicRejectsTemperature("claude-haiku-5-5"), true);
  assert.equal(anthropicRejectsTemperature("claude-haiku-4-5"), false);
});
