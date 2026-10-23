// npx tsx --test lib/services/prospects/search.test.mts
// Mock scenarios for the paid search step: out of credits, Apollo errors,
// Apollo timeouts, saving failures, re-runs. Fake Apollo + tiny in-memory DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { continueRun, runProspectSearch, type SearchDeps, type ProspectSearchInput } from "./search.ts";

import { fakeDb } from "./fake-db.mts";
import { statusLine } from "./groups.ts";

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
  // Plain words for the user: no HTTP code or raw Apollo text (M3).
  for (const t of [out.message, tables.prospect_searches[0].error, tables.prospect_searches[0].run_note]) {
    assert.match(String(t), /Apollo is busy.*Nothing was charged\. Try again in a few minutes/);
    assert.doesNotMatch(String(t), /429|rate limited|org search/);
  }
});

test("S4. Apollo times out (no answer): search failed with a plain 'safe to try again' note, never left 'paying'", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "co", "u", INPUT, deps({ search: async () => { throw new Error("The operation was aborted due to timeout"); } }));
  assert.ok(!out.ok);
  assert.equal(tables.prospect_searches[0].status, "failed");
  assert.match(out.message, /safely try again/);
  assert.doesNotMatch(String(tables.prospect_searches[0].error), /aborted/);
});

test("S4b. timeout on page 1 of a lead-target search: the page is given back, the re-run reads page 1", async () => {
  const { db, tables } = fakeDb();
  const asked: number[] = [];
  const timeout = deps({ search: async (i) => { asked.push(i.page); throw new Error("The operation was aborted due to timeout"); } });
  await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, timeout);
  assert.equal(tables.prospect_page_memory[0].last_page, 0, "page 1 not marked as read");
  assert.equal(tables.prospect_searches[0].run_status, "complete");
  assert.match(String(tables.prospect_searches[0].run_note), /safely try again/);
  const again = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, deps({ search: async (i) => { asked.push(i.page); return { organizations: [org("a")], pagination: { total_entries: 1 } }; } }));
  assert.ok(again.ok); assert.equal(again.page, 1);
  assert.deepEqual(asked, [1, 1]);
});

test("S4c. a delivered page stays read even when saving fails: the re-run never pays for it again", async () => {
  const { db, tables } = fakeDb({ fail: { prospect_companies: "upsert" } });
  await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, deps());
  assert.equal(tables.prospect_page_memory[0].last_page, 1);
});

test("S5. paid but saving the companies fails: the search row says so", async () => {
  const { db, tables } = fakeDb({ fail: { prospect_companies: "upsert" } });
  const out = await runProspectSearch(db, "co", "u", INPUT, deps());
  assert.ok(!out.ok);
  assert.match(String(tables.prospect_searches[0].error), /saving them failed, so none were added/);
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

test("S9. mock mode never spends credits", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "00000000-0000-0000-0000-00000000000a", "u", INPUT, deps({ mock: true, creditsLeft: async () => null }));
  assert.ok(out.ok); assert.equal(out.credits_spent, 0); assert.equal(tables.enrichment_logs.length, 0);
});

test("S10. a mock run in a real client workspace is refused (local runs share the live DB)", async () => {
  const { db, tables } = fakeDb();
  const out = await runProspectSearch(db, "00000000-0000-0000-0000-00000000000b", "u", INPUT, deps({ mock: true }));
  assert.ok(!out.ok); assert.equal(out.code, "MOCK_ONLY_IN_DEV");
  assert.equal(tables.prospect_searches.length, 0);
});

test("S11. a lead-target search stays locked while its first page is read, so the minute job can't jump to page 2", async () => {
  const { db, tables } = fakeDb();
  let lockedDuringFetch: unknown = null;
  const out = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, deps({
    search: async () => { lockedDuringFetch = tables.prospect_searches[0].run_locked_until; return { organizations: [org("a")], pagination: { total_entries: 1 } }; },
  }));
  assert.ok(out.ok);
  assert.ok(lockedDuringFetch && Date.parse(String(lockedDuringFetch)) > Date.now(), "locked while reading");
  assert.equal(tables.prospect_searches[0].run_locked_until, null, "unlocked after");
  assert.equal(tables.prospect_searches[0].run_status, "running");
});

test("S12. empty first page on fresh filters: no talk of earlier searches", async () => {
  const { db, tables } = fakeDb();
  await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, deps({ search: async () => ({ organizations: [], pagination: { total_entries: 0 } }) }));
  assert.equal(tables.prospect_searches[0].run_status, "complete");
  assert.doesNotMatch(String(tables.prospect_searches[0].run_note), /earlier searches/);
  assert.match(String(tables.prospect_searches[0].run_note), /^Apollo found no companies for these filters/);
});

// A running search whose page 1 is done: `status` for each of its 10 companies.
const runAfterPage1 = (statuses: [string, string | null][]) => {
  const { db, tables } = fakeDb();
  tables.prospect_searches.push({ id: "s1", run_status: "running", filters: INPUT, target_leads: 50, max_credits: 60, filter_key: "k", pages: [1], credits_spent: 1, mock: false });
  tables.prospect_page_memory.push({ filter_key: "k", last_page: 1, total_pages: 9 });
  statuses.forEach(([status, last_error], i) => tables.prospect_companies.push({ id: `c${i}`, search_id: "s1", page: 1, status, last_error }));
  let pagesBought = 0;
  const depsFor = () => deps({ search: async () => { pagesBought++; return { organizations: [org("x")], pagination: { total_entries: 900 } }; } });
  return { db, tables, depsFor, bought: () => pagesBought };
};

test("S13. AI down on page 1: no new page is bought, the note blames the AI", async () => {
  const r = runAfterPage1(Array(10).fill(["review", "Stopped after 3 tries: JEV_HTTP_503"]));
  assert.equal(await continueRun(r.db, "co", "s1", r.depsFor), "stopped");
  assert.equal(r.bought(), 0, "page 2 never read");
  assert.equal(r.tables.prospect_searches[0].run_status, "complete");
  assert.match(String(r.tables.prospect_searches[0].run_note), /10 of 10 companies could not be checked because the AI/);
});

test("S14. websites down on page 1: stops too", async () => {
  const r = runAfterPage1(Array(10).fill(["site_down", null]));
  assert.equal(await continueRun(r.db, "co", "s1", r.depsFor), "stopped");
  assert.equal(r.bought(), 0);
  assert.match(String(r.tables.prospect_searches[0].run_note), /websites of 10 of 10/);
});

test("S15. page 1 really scored but gave no leads: one weak page, page 2 is read", async () => {
  const r = runAfterPage1(Array(10).fill(["rejected", null]));
  assert.equal(await continueRun(r.db, "co", "s1", r.depsFor), "fetched");
  assert.equal(r.bought(), 1);
});

test("S16. Apollo answers 500 mid-run: plain 'Stopped at' note, no HTTP code or (mock) text", async () => {
  const r = runAfterPage1(Array(10).fill(["rejected", null]));
  const down = () => deps({ search: async () => { throw Object.assign(new Error("Apollo org search 500: internal error (mock)"), { status: 500 }); } });
  assert.equal(await continueRun(r.db, "co", "s1", down), "stopped");
  const s = r.tables.prospect_searches[0];
  assert.equal(s.run_status, "complete");
  assert.equal(s.run_note, "Stopped at 0 of 50 leads: Apollo is not answering right now. Nothing was charged. Try again in a few minutes.");
  assert.doesNotMatch(String(s.error), /500|mock|org search/);
});

test("S17. company status lines say what happened in plain words; raw text stays in last_error", () => {
  const retry = statusLine({ status: "read", attempts: 1, last_error: "The operation was aborted due to timeout (mock)" });
  assert.match(retry.text, /^Retrying \(try 2 of 3\): a service we use did not answer in time/);
  const gaveUp = statusLine({ status: "review", last_error: "Stopped after 3 tries: JEV_HTTP_503 (mock)" });
  assert.match(gaveUp.text, /AI that scores companies was not answering\. Approve or decline/);
  assert.doesNotMatch(statusLine({ status: "site_down", last_error: "Website answered HTTP 503 (mock)" }).text, /HTTP|503|mock/);
  assert.match(statusLine({ status: "review", last_error: "No buyer found: only CEO has an email" }).text, /No buyer found/);
});

test("S18. the same wizard request sent twice (reload, double click) starts one search, the second is refused with its id", async () => {
  const { db, tables } = fakeDb(); let calls = 0;
  const d = deps({ search: async () => { calls++; return { organizations: [org("a")], pagination: { total_entries: 1 } }; } });
  const first = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3, request_id: "r1" }, d);
  assert.ok(first.ok);
  const again = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3, request_id: "r1" }, d);
  assert.ok(!again.ok); assert.equal(again.status, 409); assert.equal(again.code, "ALREADY_STARTED");
  assert.equal(again.search_id, first.search_id);
  assert.match(again.message, /already started — open it in Organizations/);
  assert.equal(calls, 1, "Apollo read once"); assert.equal(tables.prospect_searches.length, 1);
  // A new wizard session (new id) is a new search.
  assert.ok((await runProspectSearch(db, "co", "u", { ...INPUT, request_id: "r2" }, d)).ok);
});

test("S19. a request whose search failed may be sent again", async () => {
  const { db } = fakeDb();
  await runProspectSearch(db, "co", "u", { ...INPUT, request_id: "r1" }, deps({ search: async () => { throw new Error("The operation was aborted due to timeout"); } }));
  assert.ok((await runProspectSearch(db, "co", "u", { ...INPUT, request_id: "r1" }, deps())).ok);
});

test("S20. every page taken by the same search still running: 'already running', not 'you have every company'", async () => {
  const { db, tables } = fakeDb();
  const one = deps({ search: async () => ({ organizations: [org("a")], pagination: { total_entries: 1, total_pages: 1 } }) });
  const first = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, one);
  assert.ok(first.ok); assert.equal(tables.prospect_searches[0].run_status, "running");
  const again = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, one);
  assert.ok(!again.ok); assert.equal(again.code, "ALREADY_RUNNING"); assert.match(again.message, /already running \("Brazil film test"\)/);
  tables.prospect_searches[0].run_status = "complete";
  const done = await runProspectSearch(db, "co", "u", { ...INPUT, target_leads: 3 }, one);
  assert.ok(!done.ok); assert.equal(done.code, "NO_MORE_PAGES");
});

test("S21. Apollo has no more pages and good fits only miss the job titles: the note names the titles", async () => {
  const r = runAfterPage1([...Array(7).fill(["review", "No one with your job titles has an email here (2 other people)"]), ...Array(3).fill(["hidden", null])]);
  r.tables.prospect_page_memory[0].total_pages = 1;
  assert.equal(await continueRun(r.db, "co", "s1", r.depsFor), "stopped");
  assert.equal(r.bought(), 0);
  assert.equal(r.tables.prospect_searches[0].run_note, "Stopped at 0 of 50 leads: 7 good companies had nobody with your job titles; they wait in Needs review for free. Approve them or widen the titles.");
});
