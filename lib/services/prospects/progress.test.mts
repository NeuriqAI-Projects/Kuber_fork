// npx tsx --test lib/services/prospects/progress.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { finishedHeadline, goodFitsLine, STALL_MS, timeLeft, type ProgressNumbers } from "./progress.ts";

const n = (o: Partial<ProgressNumbers["stages"]> & { total?: number; leads?: number; good?: number } = {}): ProgressNumbers => ({
  total: o.total ?? 48, leads: o.leads ?? 0, groups: { good: o.good ?? 0 },
  stages: { read: 0, read_failed: 0, scored: 0, score_failed: 0, waiting_credits: 0, ...o },
});

test("websites down (0 of 48 read): never 'All companies checked'", () => {
  const h = finishedHeadline(n({ read_failed: 48, score_failed: 48 }));
  assert.equal(h.complete, false);
  assert.equal(h.title, "Finished: 0 of 48 checked");
  assert.equal(h.text, "48 websites could not be read. They wait in Needs review.");
});

test("AI down after reading: says the AI could not check them", () => {
  const h = finishedHeadline(n({ read: 48, score_failed: 48 }));
  assert.equal(h.title, "Finished: 0 of 48 checked");
  assert.equal(h.text, "48 companies could not be checked by the AI. They wait in Needs review.");
  const mix = finishedHeadline(n({ read: 40, read_failed: 8, scored: 39, score_failed: 9 }));
  assert.equal(mix.text, "8 websites could not be read and 1 company could not be checked by the AI. They wait in Needs review.");
});

test("everything checked: the plain done line counts the revealed contacts", () => {
  const h = finishedHeadline(n({ read: 48, scored: 48, leads: 1 }));
  assert.deepEqual(h, { title: "All companies checked", complete: true, text: "1 contact revealed at good fits; the rest wait in Organizations." });
});

test("Apollo credits ran out: 22 good fits waiting, revealed contacts counted apart", () => {
  const s = n({ read: 48, scored: 48, waiting_credits: 22, leads: 3, good: 25 });
  assert.equal(finishedHeadline(s).text, "22 good fits are waiting for Apollo credits (they get their contact after a top-up); 3 contacts revealed so far.");
  assert.deepEqual(goodFitsLine(s), { text: "22 good fits are waiting for Apollo credits; the contact is revealed after a top-up", side: "25 so far · 3 contacts revealed" });
  assert.equal(goodFitsLine(n({ good: 2, leads: 2 })).text, "One contact revealed automatically, then it appears in Leads");
});

test("time left: a countdown while it moves, 'Retrying' with the cause once it stalls", () => {
  assert.deepEqual(timeLeft(n(), false, 0, 20), { value: "~3 min", note: "about 20 companies a minute" });
  assert.equal(timeLeft(n({ read: 48 }), false, STALL_MS, 20).note, "The AI is not answering; Kuber keeps retrying on its own.");
  assert.equal(timeLeft(n(), false, STALL_MS, 20).note, "The websites are not answering; Kuber keeps retrying on its own.");
  assert.equal(timeLeft(n(), false, STALL_MS, 20).value, "Retrying");
  assert.equal(timeLeft(n(), true, STALL_MS, 20).value, "Done");
});
