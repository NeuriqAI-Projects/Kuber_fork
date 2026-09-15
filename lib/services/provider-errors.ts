/**
 * What a provider error MEANS, separated from what to do about it.
 *
 * Two callers ask two different questions of the same error string, with very
 * different costs for getting it wrong, so they get two predicates:
 *
 *   isProviderOutage  — "is this the provider's fault, not the lead's?"
 *                       Decides whether a failed draft counts toward that
 *                       lead's 3-strike retry cap. False positive = one extra
 *                       retry. False negative = a lead permanently stranded.
 *                       So: broad.
 *
 *   isOutOfCredits    — "is the account empty?" Decides whether to take a key
 *                       out of service until a human intervenes. False
 *                       positive = a manager has to click Re-check. So:
 *                       billing-specific wording only.
 *
 * Deliberately dependency-free, which is what lets scripts/check-provider-errors.ts
 * run it under plain node with no build step.
 */

/** Marker written into email_drafts.rejection_reason when a draft failed
 *  because no LLM provider would serve the request — not because of anything
 *  about the lead. fetchDraftTargets and countPendingDrafts skip rows carrying
 *  it, so an outage cannot burn through a lead's three retries.
 *
 *  On 7 Aug 2026 both of the client's keys ran dry mid-campaign (OpenAI 429
 *  insufficient_quota, OpenRouter 402) and 61 consecutive attempts failed in
 *  ~2.3s each. Twenty leads hit the retry cap and were permanently skipped for
 *  a reason that had nothing to do with them. */
export const PROVIDER_UNAVAILABLE = "provider_unavailable";

/** Credit/auth signatures that mean "the provider refused everyone", not "this
 *  lead is unwriteable". Kept broad on purpose: a false positive costs one
 *  extra retry, a false negative permanently strands a lead. */
export function isProviderOutage(message: string): boolean {
  const m = message.toLowerCase();
  return (
    // What complete() actually throws when every LLM tier is skipped because
    // no key is currently usable — which is the shape a credit outage takes
    // most of the time, not the raw provider error. Once markKeyFailed has
    // parked the dry key, the very next call finds nothing to try and reports
    // "not configured". 58 of the 60 draft failures on 7 Aug 2026 said exactly
    // this, and without this line none of them was recognised as an outage.
    m.includes("no llm provider configured") ||
    // Anthropic's wording for an empty balance (400, not 402): "Your credit
    // balance is too low to access the Anthropic API". Seen 15 Sep 2026.
    m.includes("credit balance") ||
    m.includes("insufficient_quota") ||
    m.includes("credit_balance_exhausted") ||
    m.includes("no credits remaining") ||
    m.includes("out of credits") ||
    m.includes("requires more credits") ||
    m.includes("no usable llm provider") ||
    m.includes("quota") ||
    / 4(01|02|03|29)/.test(m) ||
    m.includes("rate limit")
  );
}

/** "The account is empty", as opposed to "we are going too fast".
 *
 *  The HTTP status cannot tell these apart — OpenAI returns 429 both for a
 *  genuine rate limit AND for "You have no credits remaining", and only the
 *  second is unfixable by waiting. So the message decides, and an ambiguous
 *  429 keeps the old cooling-off behaviour. */
export function isOutOfCredits(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("no credits remaining") ||
    m.includes("out of credits") ||
    m.includes("requires more credits") ||
    m.includes("insufficient credits") ||
    m.includes("insufficient_quota") ||
    m.includes("credit_balance_exhausted") ||
    m.includes("exceeded your current quota") ||
    m.includes("billing")
  );
}
