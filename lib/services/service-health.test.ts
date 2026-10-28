/**
 * Self-check for the service-health banner rules: an error shows, and a NEWER
 * "it works again" row clears it. Run with:
 *   npx tsx lib/services/service-health.test.ts
 */
import { strict as assert } from "assert";
import { issuesFromLogs, type HealthLogRow } from "./service-health";

const row = (source: string, event: string, error: string | null = null, payload?: unknown): HealthLogRow => ({ source, event, error, payload });
const names = (rows: HealthLogRow[]) => issuesFromLogs(rows).map((i) => `${i.service}:${i.severity}`).sort();

const draftsDown = row("llm", "DRAFT_LLM_UNAVAILABLE", "Every configured LLM key is out of credits or rejected — draft generation is paused.");
const fcDown = row("firecrawl", "SCRAPE_FAILED", "402 Payment Required: insufficient credits");
const apolloDown = row("apollo", "CREDITS_EXHAUSTED", "422 insufficient credits");
const profilesLow = row("system", "PRIMARY_LLM_LOW_CREDITS_FALLBACK_ACTIVE", "OpenRouter low — currently falling back to OpenAI for company profiles");
const skippedBoth = row("system", "SKIPPED_LOW_CREDITS", "Firecrawl is out of credits (0 left) · No usable LLM provider: OpenRouter: 0");
const skippedFc = row("system", "SKIPPED_LOW_CREDITS", "Firecrawl is out of credits (0 left)");

// Errors alone show (newest first).
assert.deepEqual(names([draftsDown]), ["LLM API key:critical"]);
assert.deepEqual(names([fcDown]), ["Firecrawl:critical"]);
assert.deepEqual(names([apolloDown]), ["Apollo:critical"]);
assert.deepEqual(names([skippedBoth]), ["Company profiles AI:critical", "Firecrawl:critical"]);
// A Firecrawl-only skip no longer claims the AI is down.
assert.deepEqual(names([skippedFc]), ["Firecrawl:critical"]);

// A newer success clears each one.
assert.deepEqual(names([row("llm", "DRAFT_LLM_RECOVERED"), draftsDown]), []);
assert.deepEqual(names([row("firecrawl", "SCRAPE_SUCCESS"), fcDown]), []);
assert.deepEqual(names([row("apollo", "CREDITS_CONSUMED"), apolloDown]), []);
assert.deepEqual(names([row("system", "SCRAPE_BATCH_STARTED", null, { primary_llm_ok: true }), skippedBoth]), []);
// A batch running on the fallback clears Firecrawl, but the newer fallback warning stays.
assert.deepEqual(names([row("system", "SCRAPE_BATCH_STARTED", null, { primary_llm_ok: false }), profilesLow, skippedBoth]), ["Company profiles AI:warning"]);
// Old batch rows (no flag) never hide a profiles problem.
assert.deepEqual(names([row("system", "SCRAPE_BATCH_STARTED", null, { batch_size: 3 }), skippedBoth]), ["Company profiles AI:critical"]);

// An OLDER success does not hide a newer error.
assert.deepEqual(names([draftsDown, row("llm", "DRAFT_LLM_RECOVERED")]), ["LLM API key:critical"]);
assert.deepEqual(names([apolloDown, row("apollo", "CREDITS_CONSUMED")]), ["Apollo:critical"]);

// Drafts and profiles are separate: a newer amber profiles warning no longer hides red drafts.
assert.deepEqual(names([profilesLow, draftsDown]), ["Company profiles AI:warning", "LLM API key:critical"]);

console.log("service-health: all checks pass");
