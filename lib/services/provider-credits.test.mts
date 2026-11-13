// npx tsx --test lib/services/provider-credits.test.mts
// Apollo at 0 is re-asked at most hourly; a saved balance above 0 is never re-asked by apolloOutOfCredits.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apolloOutOfCredits, checkApolloCredits } from "./provider-credits.ts";

/** system_state with one saved Apollo balance `ageMin` minutes old; no Apollo key, so a re-check saves "no key". */
function stubDb(remaining: number | null, ageMin: number) {
  const state = { value: JSON.stringify({ ok: remaining != null && remaining >= 5, remaining, limit: 4000 }), updated_at: new Date(Date.now() - ageMin * 60_000).toISOString() };
  let rechecks = 0;
  const q = (table: string) => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b, eq: () => b, or: () => b, order: () => b,
      maybeSingle: async () => ({ data: table === "system_state" ? state : null }),
      upsert: async () => { rechecks++; return { error: null }; },
      then: (res: (v: unknown) => void) => res({ data: [] }), // provider_keys: none
    });
    return b;
  };
  return { db: { from: q, rpc: async () => ({ data: null }) } as never, rechecks: () => rechecks };
}

for (const k of Object.keys(process.env)) if (/APOLLO/i.test(k)) delete process.env[k];

test("Apollo at 0, saved 30 min ago: out of credits, Apollo not asked", async () => {
  const s = stubDb(0, 30);
  assert.equal(await apolloOutOfCredits(s.db), true);
  assert.equal((await checkApolloCredits(s.db, "any")).remaining, 0, "plain cached check keeps the 0 for an hour too");
  assert.equal(s.rechecks(), 0);
});

test("Apollo at 0, saved 61 min ago: re-checked once", async () => {
  const s = stubDb(0, 61);
  assert.equal(await apolloOutOfCredits(s.db), false, "no key in the stub → unknown balance → not blocked");
  assert.equal(s.rechecks(), 1);
});

test("Apollo above 0, saved 3 days ago: trusted, never re-asked", async () => {
  const s = stubDb(120, 3 * 24 * 60);
  assert.equal(await apolloOutOfCredits(s.db), false);
  assert.equal(s.rechecks(), 0);
});

test("Apollo above 0, saved 6 min ago: the normal 5-minute check still re-reads it", async () => {
  const s = stubDb(120, 6);
  await checkApolloCredits(s.db, "any");
  assert.equal(s.rechecks(), 1);
});

test("Apollo at 1-4 credits counts as out (same line as enrich's < 5), re-asked at most hourly", async () => {
  const s = stubDb(3, 30);
  assert.equal(await apolloOutOfCredits(s.db), true);
  assert.equal(s.rechecks(), 0);
  const old = stubDb(4, 61);
  assert.equal(await apolloOutOfCredits(old.db), false, "re-checked: no key in the stub -> unknown -> not blocked");
  assert.equal(old.rechecks(), 1);
  const five = stubDb(5, 3 * 24 * 60);
  assert.equal(await apolloOutOfCredits(five.db), false);
  assert.equal(five.rechecks(), 0);
});
