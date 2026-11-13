// npx tsx --test lib/services/provider-keys.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetKeyMemo, getActiveKey, getActiveKeyMemo, isUsableLlmKeyRow, isUsableScrapeKeyRow, kickLlmWork, kickScrapeWork, markKeyFailed, markKeySucceeded } from "./provider-keys.ts";

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

// ---- key resolution (13 Nov 2026: secret cache, "no key" memo, success-write skip)

type KeyRow = { id: string; company_id: string; provider: string; secret_vault_id: string; status: string; last_error: string | null; is_active: boolean };
/** provider_keys in memory: honours the eq() filters getActiveKey uses (company_id, provider). */
function fakeDb(rows: KeyRow[]) {
  const n = { selects: 0, decrypts: 0, updates: 0 };
  const from = () => {
    const eqs: Record<string, unknown> = {};
    let update = false;
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => { n.selects++; return b; },
      update: () => { update = true; n.updates++; return b; },
      eq: (col: string, v: unknown) => { eqs[col] = v; return b; },
      or: () => b, order: () => b,
      then: (res: (v: unknown) => void) => res(update ? { error: null } : {
        data: rows.filter((r) => r.is_active && Object.entries(eqs).every(([c, v]) => c === "is_active" || (r as Record<string, unknown>)[c] === v)),
      }),
    });
    return b;
  };
  const rpc = async (_: string, args: { p_vault_id: string }) => { n.decrypts++; return { data: `secret-of-${args.p_vault_id}` }; };
  return { db: { from, rpc } as never, n };
}
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
for (const k of ["FIRECRAWL_API_KEY", "GEMINI_API_KEY"]) delete process.env[k];

test("memo never hands one company's key to another; 'no key' is memoised", async () => {
  forgetKeyMemo();
  const { db, n } = fakeDb([
    { id: "ka", company_id: A, provider: "firecrawl", secret_vault_id: "va", status: "healthy", last_error: null, is_active: true },
    { id: "kb", company_id: B, provider: "firecrawl", secret_vault_id: "vb", status: "healthy", last_error: null, is_active: true },
  ]);
  const a1 = await getActiveKeyMemo(db, "firecrawl", A);
  const b1 = await getActiveKeyMemo(db, "firecrawl", B);
  const a2 = await getActiveKeyMemo(db, "firecrawl", A);
  assert.equal(a1?.keyId, "ka"); assert.equal(a2?.keyId, "ka"); assert.equal(b1?.keyId, "kb");
  assert.equal(b1?.secret, "secret-of-vb");
  assert.equal(n.selects, 2, "A read once, B read once");
  // A company with no key: read once, then memoised (was a read on every call).
  assert.equal(await getActiveKeyMemo(db, "gemini", A), null);
  assert.equal(await getActiveKeyMemo(db, "gemini", A), null);
  assert.equal(n.selects, 3);
  forgetKeyMemo();
  await getActiveKeyMemo(db, "firecrawl", A);
  assert.equal(n.selects, 4, "a key edit (forgetKeyMemo) makes the next resolve read again");
});

test("a Vault secret is decrypted once per instance; the row is still read every time", async () => {
  const { db, n } = fakeDb([{ id: "k1", company_id: A, provider: "firecrawl", secret_vault_id: "v1", status: "healthy", last_error: null, is_active: true }]);
  for (let i = 0; i < 3; i++) assert.equal((await getActiveKey(db, "firecrawl", A))?.secret, "secret-of-v1");
  assert.equal(n.selects, 3);
  assert.equal(n.decrypts, 1);
});

test("markKeySucceeded writes only when the key was not already healthy and clean", async () => {
  forgetKeyMemo();
  const { db, n } = fakeDb([
    { id: "clean", company_id: A, provider: "firecrawl", secret_vault_id: "v2", status: "healthy", last_error: null, is_active: true },
    { id: "erred", company_id: B, provider: "firecrawl", secret_vault_id: "v3", status: "healthy", last_error: "timeout", is_active: true },
  ]);
  await getActiveKey(db, "firecrawl", A);
  await markKeySucceeded(db, "clean");
  assert.equal(n.updates, 0, "healthy, no error: nothing to write");
  await getActiveKey(db, "firecrawl", B);
  await markKeySucceeded(db, "erred");
  assert.equal(n.updates, 1, "clears the old error");
  await markKeySucceeded(db, "erred");
  assert.equal(n.updates, 1, "written once, then known clean");
  await markKeyFailed(db, "erred", { status: 429, message: "rate limited" });
  const afterFail = n.updates;
  await markKeySucceeded(db, "erred");
  assert.equal(n.updates, afterFail + 1, "after a failure the next success writes healthy again");
  await markKeySucceeded(db, "never-seen");
  assert.equal(n.updates, afterFail + 2, "a key this instance never read is written as before");
});

test("scrape kick: only for a usable Firecrawl or AI key", async () => {
  assert.equal(isUsableScrapeKeyRow(row({ provider: "firecrawl" })), true);
  assert.equal(isUsableScrapeKeyRow(row({ provider: "firecrawl", is_active: false })), false);
  assert.equal(isUsableScrapeKeyRow(row({ provider: "firecrawl", status: "dead" })), false);
  assert.equal(isUsableScrapeKeyRow(row({ provider: "anthropic" })), true);
  for (const p of ["apollo", "instantly", "jev", "tavily"]) assert.equal(isUsableScrapeKeyRow(row({ provider: p })), false, p);

  const calls: { url: string; secret: string | null }[] = [];
  const realFetch = globalThis.fetch;
  const realSecret = process.env.INTERNAL_SECRET;
  process.env.INTERNAL_SECRET = "test-secret";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, secret: new Headers(init.headers).get("x-internal-secret") });
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  try {
    await kickScrapeWork("http://app");
    assert.deepEqual(calls, [{ url: "http://app/api/enrich/scrape-orgs", secret: "test-secret" }]);
  } finally {
    globalThis.fetch = realFetch;
    if (realSecret === undefined) delete process.env.INTERNAL_SECRET; else process.env.INTERNAL_SECRET = realSecret;
  }
});
