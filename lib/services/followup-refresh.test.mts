// npx tsx --test lib/services/followup-refresh.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { planRefresh, type RefreshDraft } from "./followup-refresh.ts";
import { pickFollowupTemplate, BUILT_IN_FOLLOWUP_FALLBACK } from "./followup-template.ts";

const d = (id: string, lead: string, source = "template", version = 1): RefreshDraft => ({ id, lead_id: lead, body: "old", source, version });

test("only unsent, untouched default-text follow-ups are rewritten", () => {
  const plan = planRefresh(
    [d("a", "L1"), d("b", "L2"), d("c", "L3", "ai"), d("e", "L4", "manual"), d("f", "L5"), d("g", "L6")],
    new Set(["L2"]),   // L2 already sent
    new Set(["f"]),    // f was edited by hand after it was written
  );
  assert.deepEqual(plan.toUpdate.map((x) => x.id).sort(), ["a", "g"]);
  assert.equal(plan.alreadySent, 1);
  assert.equal(plan.kept, 3);
});

test("a sent lead counts as sent even if its draft is AI-written", () => {
  const plan = planRefresh([d("c", "L1", "ai")], new Set(["L1"]), new Set());
  assert.deepEqual([plan.toUpdate.length, plan.alreadySent, plan.kept], [0, 1, 0]);
});

test("one draft per lead: the highest version decides", () => {
  const plan = planRefresh([d("v1", "L1", "template", 1), d("v2", "L1", "manual", 2)], new Set(), new Set());
  assert.deepEqual([plan.toUpdate.length, plan.kept], [0, 1]);
});

test("a step's text resolves like the sender does: own text, else Settings, else built-in", () => {
  assert.equal(pickFollowupTemplate("<p>Mine</p>", "<p>Settings</p>"), "<p>Mine</p>");
  assert.equal(pickFollowupTemplate("<p></p>", "<p>Settings</p>"), "<p>Settings</p>", "an emptied editor box is not text");
  assert.equal(pickFollowupTemplate(null, ""), BUILT_IN_FOLLOWUP_FALLBACK);
});
