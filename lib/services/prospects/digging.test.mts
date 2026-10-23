// npx tsx --test lib/services/prospects/digging.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextStep, liveRunNote, minCredits, leadsApolloFits, leadsFirecrawlFits, MAX_LEADS_PER_SEARCH, suggestedMaxCredits, revealCap, filterKey, type RunState } from "./digging.ts";

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

test("Apollo out of credits ends the run once nothing else is being checked", () => {
  assert.equal(step({ pagesRead: 1, leads: 3, working: 4, waitingCredits: 10 }).action, "wait", "other companies still being checked");
  assert.match(note({ pagesRead: 1, leads: 3, creditsUsed: 4, nextPage: 2, waitingCredits: 10 }), /Stopped at 3 of 200 leads: Apollo ran out of credits\. 10 good companies are waiting/);
  assert.match(note({ pagesRead: 1, waitingCredits: 1 }), /1 good company is waiting/);
  assert.match(note({ leads: 200, waitingCredits: 5 }), /Done/);
});

test("blames the real cause when services failed, not the keywords", () => {
  const end = { pagesRead: 2, leadsPerPage: [0, 0], creditsUsed: 2, nextPage: 3, totalPages: 2 };
  const jev = note({ ...end, checked: 60, failed: 60, failedError: "Stopped after 3 tries: JEV_HTTP_503" });
  assert.match(jev, /60 of 60 companies could not be checked because the AI that scores companies was not answering\. This is not a keyword problem/);
  assert.doesNotMatch(jev, /JEV|HTTP|503|\(/, "no raw error text for the user");
  assert.match(note({ ...end, checked: 10, failed: 10, failedError: "Stopped after 3 tries: The operation was aborted due to timeout (mock)" }), /did not answer in time\. This/);
  assert.match(jev, /try again later/);
  assert.doesNotMatch(jev, /keywords or countries|used up/);
  assert.match(note({ ...end, totalPages: 9, checked: 60, failed: 60, failedError: "JEV_HTTP_503" }), /AI that scores/, "dry pages too");
  assert.match(note({ ...end, checked: 60, siteDown: 60 }), /websites of 60 of 60 companies could not be read/);
  // Mostly real verdicts: the keywords really are the problem.
  assert.match(note({ ...end, checked: 60, failed: 5, siteDown: 5 }), /no more companies.*Add more keywords/);
  assert.match(note({ ...end, totalPages: 9, checked: 60, failed: 2 }), /keywords are used up/);
  assert.deepEqual(step({ leads: 200, checked: 300, failed: 200 }), { action: "stop", note: "Done: 200 leads, as asked." });
});

test("outage pages are not weak pages, and no page is bought after one", () => {
  const ok = { checked: 100, failed: 0, siteDown: 0 }, ai = { checked: 100, failed: 90, siteDown: 0 }, web = { checked: 100, failed: 0, siteDown: 80 };
  const run = { leads: 30, creditsUsed: 33, nextPage: 4, totalPages: 9, failedError: "Stopped after 3 tries: JEV_HTTP_503" };
  // Page 3 failed while pages 1–2 were fine: the totals look fine, the last page does not.
  const s3 = note({ ...run, pagesRead: 3, leadsPerPage: [30, 0, 0], pageChecks: [ok, ok, ai], checked: 300, failed: 90 });
  assert.match(s3, /Stopped at 30 of 200 leads: 90 of 100 companies could not be checked because the AI/);
  assert.match(note({ ...run, pagesRead: 1, leadsPerPage: [0], pageChecks: [web], checked: 100, siteDown: 80 }), /websites of 80 of 100/);
  // An outage page is skipped when counting weak pages; really scored weak pages still count.
  assert.equal(step({ ...run, pagesRead: 3, leadsPerPage: [30, 0, 1], pageChecks: [ok, ai, ok] }).action, "fetch");
  assert.match(note({ ...run, pagesRead: 4, leadsPerPage: [30, 0, 1, 2], pageChecks: [ok, ai, ok, ok], nextPage: 5 }), /last 2 pages gave almost no leads/);
  // Normal multi-page run still reads on.
  assert.equal(step({ ...run, pagesRead: 1, leadsPerPage: [30], pageChecks: [ok], nextPage: 2 }).action, "fetch");
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

test("the stop note follows leads that arrive after the stop", () => {
  const credits = "Stopped at 3 of 10 leads: Apollo ran out of credits. 22 good companies are waiting for credits and get their contact on their own after a top-up, within your credit limit.";
  assert.equal(liveRunNote({ note: credits, leads: 3, target: 10, waiting: 22 }), credits, "nothing changed");
  assert.match(liveRunNote({ note: credits, leads: 6, target: 10, waiting: 19 })!, /^Now 6 of 10 leads\. It had stopped at 3: Apollo ran out of credits\. 19 good companies are waiting/);
  assert.equal(liveRunNote({ note: credits, leads: 10, target: 10, waiting: 15 }), "Done: 10 leads. It had stopped at 3 (Apollo ran out of credits); the rest came in later.");
  assert.match(liveRunNote({ note: credits, leads: 3, target: 10, waiting: 0 })!, /No companies are waiting any more/);
  assert.equal(liveRunNote({ note: "Done: 5 leads, as asked.", leads: 5, target: 5 }), "Done: 5 leads, as asked.");
  assert.equal(liveRunNote({ note: "Done: 5 leads, as asked.", leads: 7, target: 5, approved: 2 }), "Done: 7 leads (5 automatic + 2 approved).");
  const limit = "Stopped at 4 of 10 leads: your credit limit of 12 is reached.";
  assert.equal(liveRunNote({ note: limit, leads: 6, target: 10, approved: 2 }), "Now 6 of 10 leads (4 automatic + 2 approved). It had stopped at 4: your credit limit of 12 is reached.");
  assert.equal(liveRunNote({ note: "Apollo found no companies for these filters.", leads: 0, target: 10 }), "Apollo found no companies for these filters.");
  assert.equal(liveRunNote({ note: null, leads: 2, target: 10 }), null);
});

test("job titles that nobody has: the note names them, not Apollo or the keywords", () => {
  const end = { pagesRead: 1, leadsPerPage: [0], creditsUsed: 1, nextPage: 2, totalPages: 1, target: 20, checked: 48 };
  const n = note({ ...end, titleBlocked: 35 });
  assert.equal(n, "Stopped at 0 of 20 leads: 35 good companies had nobody with your job titles; they wait in Needs review for free. Approve them or widen the titles.");
  assert.match(note({ ...end, titleBlocked: 1 }), /1 good company had nobody .*; it waits in Needs review/);
  assert.match(note({ ...end, totalPages: 9, pagesRead: 2, leadsPerPage: [0, 1], nextPage: 3, titleBlocked: 4 }), /4 good companies had nobody with your job titles/, "dry pages too");
  assert.match(note({ ...end, titleBlocked: 0 }), /no more companies/);
  // An outage is still the first cause.
  assert.match(note({ ...end, failed: 48, failedError: "JEV_HTTP_503", titleBlocked: 3 }), /AI that scores/);
});
