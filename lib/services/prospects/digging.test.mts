// npx tsx --test lib/services/prospects/digging.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep, minCredits, leadsApolloFits, leadsFirecrawlFits, MAX_LEADS_PER_SEARCH, suggestedMaxCredits, revealCap, filterKey, type RunState } from "./digging.ts";

const base: RunState = { target: 200, maxCredits: 230, creditsUsed: 0, leads: 0, working: 0, pagesRead: 0, leadsPerPage: [], totalPages: null, nextPage: 1, lastPageEmpty: false };
const step = (o: Partial<RunState>) => nextStep({ ...base, ...o });
const note = (o: Partial<RunState>) => (step(o) as { note: string }).note;

test("keeps reading pages until the target is reached", () => {
  assert.equal(step({ pagesRead: 1, leads: 35, creditsUsed: 36, leadsPerPage: [35], nextPage: 2, totalPages: 9 }).action, "fetch");
  assert.equal(step({ pagesRead: 1, leads: 35, working: 12 }).action, "wait", "waits while companies are still being checked");
  assert.deepEqual(step({ leads: 200, pagesRead: 6 }), { action: "stop", note: "Done: 200 leads, as asked." });
});

test("stops when Apollo runs out, the credit limit is reached, or pages dry up", () => {
  assert.match(note({ pagesRead: 3, nextPage: 4, totalPages: 3, leads: 90 }), /no more companies/);
  assert.match(note({ pagesRead: 1, lastPageEmpty: true }), /no more companies/);
  assert.match(note({ creditsUsed: 229, pagesRead: 5, leads: 150, nextPage: 6 }), /credit limit of 230/);
  assert.match(note({ pagesRead: 4, leadsPerPage: [30, 20, 2, 1], leads: 53, creditsUsed: 57, nextPage: 5 }), /almost no leads/);
  assert.match(note({ pagesRead: 2, leads: 60, creditsUsed: 62, nextPage: 3, firecrawlLeft: 40 }), /Firecrawl .* only 40 credits left/);
  assert.equal(step({ pagesRead: 2, leads: 60, creditsUsed: 62, nextPage: 3, firecrawlLeft: 100 }).action, "fetch");
  assert.match(note({ pagesRead: 20, leadsPerPage: Array(20).fill(5), leads: 100, creditsUsed: 120, nextPage: 21 }), /20 pages/);
});

test("credit maths", () => {
  assert.equal(minCredits(100), 104);
  assert.equal(suggestedMaxCredits(100), 115); // 100 leads + 4 pages = 104, +10%
  assert.equal(suggestedMaxCredits(200), 228); // 200 + 7 pages = 207, +10%
  assert.equal(revealCap(200, 230, 3), 200);
  assert.equal(MAX_LEADS_PER_SEARCH, 660);
  assert.equal(leadsFirecrawlFits(300), 99, "300 Firecrawl = 3 pages = about 99 leads");
  assert.equal(leadsFirecrawlFits(99), 0);
  assert.equal(leadsApolloFits(104), 100, "104 Apollo credits buy 100 leads + 4 pages");
  assert.ok(minCredits(leadsApolloFits(3900)!) <= 3900 && minCredits(leadsApolloFits(3900)! + 1) > 3900);
  assert.equal(leadsApolloFits(null), null);
  assert.equal(revealCap(200, 120, 3), 117, "the limit leaves room for the pages already paid");
  assert.equal(revealCap(50, 2, 3), 0);
});

test("page memory key ignores order, case and empty filters", () => {
  assert.equal(filterKey({ keywords: ["PVC pipes", "upvc pipes"], locations: ["India"] }), filterKey({ keywords: [" upvc pipes", "pvc PIPES"], locations: ["india"], advanced: { revenueMin: "" } }));
  assert.notEqual(filterKey({ keywords: ["pvc pipes"] }), filterKey({ keywords: ["pvc pipes"], locations: ["India"] }));
});
