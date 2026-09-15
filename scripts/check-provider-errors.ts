/**
 * Self-check for the two provider-error predicates.
 *
 *   node --experimental-strip-types scripts/check-provider-errors.ts
 *
 * Every string marked LIVE below is a verbatim error recorded in production on
 * 7 Aug 2026, when both LLM keys ran dry mid-campaign. Those are the cases that
 * actually matter: the previous version of isProviderOutage() missed the most
 * common one ("No LLM provider configured"), so 58 of 60 credit failures were
 * charged to the leads and 20 of them were permanently written off.
 *
 * No framework on purpose — provider-errors.ts has zero imports, so plain node
 * runs this with no build step.
 */
import assert from "node:assert/strict";
import { isProviderOutage, isOutOfCredits } from "../lib/services/provider-errors.ts";

// ── isProviderOutage: forgive the lead its retry ───────────────────────────
// LIVE — what complete() throws once markKeyFailed has parked every dry key.
// This is the regression that stranded 20 leads.
assert.equal(
  isProviderOutage("No LLM provider configured — add a key in Settings > Keys, or set an env var like OPENROUTER_API_KEY"),
  true,
);
// LIVE — the raw provider errors, seen when a key dies mid-batch.
assert.equal(isProviderOutage('OpenAI 429: {"error": {"message": "You have no credits remaining. Add credits to continue using the API"}}'), true);
assert.equal(isProviderOutage('OpenRouter 402: {"error":{"message":"This request requires more credits, or fewer max_tokens."}}'), true);

// LIVE 15 Sep 2026 — Anthropic reports an empty balance as a 400 with this text.
assert.equal(isProviderOutage("Claude (Anthropic direct): 400 Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."), true);

// A genuinely lead-specific failure must still count against the lead, or the
// 3-strike cap stops protecting anything.
assert.equal(isProviderOutage("Draft shape mismatch — subject: Required"), false);
assert.equal(isProviderOutage("Lead has no email"), false);

// ── isOutOfCredits: take the key out of service ────────────────────────────
// Narrower by design: this one costs a manager a manual Re-check when wrong.
assert.equal(isOutOfCredits('OpenAI 429: {"error": {"message": "You have no credits remaining."}}'), true);
assert.equal(isOutOfCredits("OpenRouter 402: This request requires more credits"), true);
assert.equal(isOutOfCredits("429 insufficient_quota: check your plan and billing details"), true);

// The distinction the whole function exists for: a real rate limit is fixed by
// waiting, so it must keep the cooling-off path and NOT kill the key.
assert.equal(isOutOfCredits("OpenAI 429: Rate limit reached for gpt-4o-mini, please retry after 20s"), false);
assert.equal(isOutOfCredits("OpenAI 500: The server had an error while processing your request"), false);

// Anything that kills a key must also forgive the lead — the reverse is fine,
// but a key dying while its leads keep taking strikes is the exact bug above.
for (const m of [
  'OpenAI 429: {"error": {"message": "You have no credits remaining."}}',
  "OpenRouter 402: This request requires more credits",
  "429 insufficient_quota: check your plan and billing details",
]) {
  assert.equal(isOutOfCredits(m) && !isProviderOutage(m), false, `strands leads: ${m}`);
}

console.log("provider-errors: all checks passed");
