// npx tsx --test lib/services/provider-keys.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsableLlmKeyRow, kickLlmWork } from "./provider-keys.ts";

const row = (o: Partial<Parameters<typeof isUsableLlmKeyRow>[0]> = {}) =>
  ({ provider: "anthropic", is_active: true, status: "healthy", cooling_off_until: null, ...o });

test("usable = active AI key, healthy or cooled off (same rule as getActiveKey)", () => {
  const now = Date.parse("2026-11-13T10:00:00Z");
  assert.equal(isUsableLlmKeyRow(row(), now), true);
  assert.equal(isUsableLlmKeyRow(row({ status: "dead" }), now), false);
  assert.equal(isUsableLlmKeyRow(row({ is_active: false }), now), false);
  assert.equal(isUsableLlmKeyRow(row({ status: "cooling_off", cooling_off_until: "2026-11-13T10:05:00Z" }), now), false);
  assert.equal(isUsableLlmKeyRow(row({ status: "cooling_off", cooling_off_until: "2026-11-13T09:55:00Z" }), now), true);
  assert.equal(isUsableLlmKeyRow(row({ status: "cooling_off", cooling_off_until: null }), now), false);
  // Service keys never restart AI work.
  assert.equal(isUsableLlmKeyRow(row({ provider: "firecrawl" }), now), false);
  assert.equal(isUsableLlmKeyRow(row({ provider: "apollo" }), now), false);
});

test("kickLlmWork: one call per AI worker, each with company_id; none without a company", async () => {
  const calls: { url: string; body: string; secret: string | null }[] = [];
  const realFetch = globalThis.fetch;
  const realSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = "test-secret";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), secret: new Headers(init.headers).get("x-internal-secret") });
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  try {
    await kickLlmWork("http://app", "00000000-0000-0000-0000-00000000000a");
    assert.deepEqual(calls.map((c) => c.url).sort(), [
      "http://app/api/enrich/generate-drafts",
      "http://app/api/enrich/regenerate-drafts",
      "http://app/api/internal/write-followups",
    ]);
    for (const c of calls) {
      assert.deepEqual(JSON.parse(c.body), { company_id: "00000000-0000-0000-0000-00000000000a" });
      assert.equal(c.secret, "test-secret");
    }
    calls.length = 0;
    await kickLlmWork("http://app", null);
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = realFetch;
    if (realSecret === undefined) delete process.env.INTERNAL_SECRET; else process.env.INTERNAL_SECRET = realSecret;
  }
});
