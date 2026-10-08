// npx tsx --test lib/services/prospects/search.test.mts
// Mock scenarios for the paid search step: out of credits, Apollo errors,
// Apollo timeouts, saving failures, re-runs. Fake Apollo + tiny in-memory DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProspectSearch, type SearchDeps, type ProspectSearchInput } from "./search.ts";

import { fakeDb } from "./fake-db.mts";

const org = (id: string, domain: string | null = `${id}.com`) => ({
  id, name: `Co ${id}`, primary_domain: domain, website_url: domain ? `https://${domain}` : null, linkedin_url: null, twitter_url: null, facebook_url: null, raw: {},
}) as never;
const INPUT: ProspectSearchInput = { keywords: ["blown film"], locations: ["Brazil"], page: 1, batch_name: "Brazil film test", color: "green" };
const deps = (over: Partial<SearchDeps> = {}): SearchDeps => ({
  mock: false,
  creditsLeft: async () => 3,
  search: async () => ({ organizations: [org("a"), org("b"), org("c", null)], pagination: { total_entries: 3 } }),
  ...over,
});

test("S1. normal search: 1 credit, companies saved, ledger row written", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "co", "u", INPUT, deps());
  assert.ok(out.ok); assert.equal(out.credits_spent, 1); assert.equal(out.new_companies, 3);
  assert.equal(tables.prospect_searches[0].status, "done");
  assert.equal(tables.enrichment_logs.length, 1);
});

test("S2. zero Apollo credits: refused before anything is saved or called", async () => {
  const { db, tables } = fakeDb(); let called = false;
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ creditsLeft: async () => 0, search: async () => { called = true; throw new Error("x"); } }));
  assert.ok(!out.ok); assert.equal(out.code, "APOLLO_OUT_OF_CREDITS");
  assert.equal(called, false); assert.equal(tables.prospect_searches.length, 0);
});

test("S3. Apollo answers with an error (e.g. 429/500): search marked failed, no credit recorded", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ search: async () => { throw Object.assign(new Error("Apollo org search 429: rate limited"), { status: 429 }); } }));
  assert.ok(!out.ok);
  assert.equal(tables.prospect_searches[0].status, "failed");
  assert.equal(tables.prospect_searches[0].credits_spent, undefined);
  assert.equal(tables.enrichment_logs.length, 0);
});

test("S4. Apollo times out (no answer): left as 'paying' = charge unknown, never silently dropped", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ search: async () => { throw new Error("The operation was aborted due to timeout"); } }));
  assert.ok(!out.ok);
  assert.equal(tables.prospect_searches[0].status, "paying");
  assert.match(String(tables.prospect_searches[0].error), /charge unknown/);
});

test("S5. paid but saving the companies fails: the search row says so", async () => {
  const { db, tables } = fakeDb({ fail: { prospect_companies: "upsert" } });
  const out = await runProspectSearch(db, "co", "u", INPUT, deps());
  assert.ok(!out.ok);
  assert.match(String(tables.prospect_searches[0].error), /Paid, but saving companies failed/);
  assert.equal(tables.prospect_companies.length, 0);
});

test("S6. companies already in the system are skipped (by Apollo id and by domain)", async () => {
  const { db, tables } = fakeDb();
  tables.organizations.push({ apollo_org_id: "a" }, { domain: "b.com" });
  const out = await runProspectSearch(db, "co", "u", INPUT, deps());
  assert.ok(out.ok); assert.equal(out.new_companies, 1);
  assert.deepEqual(tables.prospect_companies.map((r) => r.apollo_org_id), ["c"]);
});

test("S7. running the same search twice never duplicates a company", async () => {
  const { db, tables } = fakeDb();
  await runProspectSearch(db, "co", "u", INPUT, deps());
  const again = await runProspectSearch(db, "co", "u", INPUT, deps());
  assert.ok(again.ok); assert.equal(again.new_companies, 0);
  assert.equal(tables.prospect_companies.length, 3);
});

test("S8. empty result page: free, no ledger row", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ search: async () => ({ organizations: [], pagination: { total_entries: 0 } }) }));
  assert.ok(out.ok); assert.equal(out.credits_spent, 0); assert.equal(tables.enrichment_logs.length, 0);
});

test("S9. mock mode never checks or spends credits", async () => {
  const { db, tables } = fakeDb(); let checked = false;
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ mock: true, creditsLeft: async () => { checked = true; return 0; } }));
  assert.ok(out.ok); assert.equal(checked, false); assert.equal(out.credits_spent, 0); assert.equal(tables.enrichment_logs.length, 0);
});
