// npx tsx --test lib/services/enrichment-status.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { llmFailureStatus, mayConcludeAbandonedQueue } from "./enrichment-status.ts";

test("our AI outage costs the company no strike", () => {
  assert.equal(llmFailureStatus("No LLM provider configured — add a key in Settings > Keys"), "SCRAPE_PROVIDER_UNAVAILABLE");
  assert.equal(llmFailureStatus("Claude (Anthropic direct): 400 Your credit balance is too low to access the Anthropic API"), "SCRAPE_PROVIDER_UNAVAILABLE");
  assert.equal(llmFailureStatus('OpenAI 429: {"error": {"message": "You have no credits remaining."}}'), "SCRAPE_PROVIDER_UNAVAILABLE");
  // A model that read the page and returned junk is still the company's attempt.
  assert.equal(llmFailureStatus("No parseable JSON in LLM response: I need to determine"), "LLM_EXTRACTION_FAILED");
});

test("the 24h write-off waits while the credit gate holds the queue", () => {
  const now = Date.parse("2026-09-16T12:00:00Z");
  assert.equal(mayConcludeAbandonedQueue(null, now), true, "never waited on credits: crashed-chain cleanup still runs");
  assert.equal(mayConcludeAbandonedQueue("2026-09-16T08:00:00Z", now), false, "held for credits 4h ago: not abandoned");
  assert.equal(mayConcludeAbandonedQueue("2026-09-14T13:10:00Z", now), true, "last wait 2 days ago: cleanup may run");
});
