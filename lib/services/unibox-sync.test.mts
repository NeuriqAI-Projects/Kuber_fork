/**
 * knownEmailPatch: what the inbox sync writes for mail we already store.
 * Run: npx tsx --test lib/services/unibox-sync.test.mts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { knownEmailPatch, type KnownEmailRow } from "./unibox";

const stored: KnownEmailRow = {
  id: "row", company_id: "c", campaign_id: "m", campaign_lead_id: "cl",
  thread_id: "t1", is_unread: true, is_auto_reply: false, is_focused: true, i_status: 1,
  ai_interest_value: null, has_body_text: false,
};
const incoming = {
  thread_id: "t1", is_unread: true, is_auto_reply: false, is_focused: true, i_status: 1,
  ai_interest_value: null, body_text: null, body_html: "<p>x</p>", content_preview: "x",
};

test("unchanged mail writes nothing (html-only body is not rewritten)", () => {
  assert.equal(knownEmailPatch(stored, incoming), null);
});

test("read in Instantly: only the flag that moved", () => {
  assert.deepEqual(knownEmailPatch(stored, { ...incoming, is_unread: false }), { is_unread: false });
});

test("late AI interest is written once, then stable", () => {
  assert.deepEqual(knownEmailPatch(stored, { ...incoming, ai_interest_value: 1 }), { ai_interest_value: 1 });
  assert.equal(knownEmailPatch({ ...stored, ai_interest_value: 1 }, { ...incoming, ai_interest_value: 1 }), null);
  // Instantly dropping the value never blanks ours.
  assert.equal(knownEmailPatch({ ...stored, ai_interest_value: 1 }, incoming), null);
  // 0 (out of office) is a real value, not "missing".
  assert.deepEqual(knownEmailPatch(stored, { ...incoming, ai_interest_value: 0 }), { ai_interest_value: 0 });
});

test("bodies only fill a missing text body", () => {
  assert.deepEqual(knownEmailPatch(stored, { ...incoming, body_text: "hi" }), { body_text: "hi", body_html: "<p>x</p>", content_preview: "x" });
  assert.equal(knownEmailPatch({ ...stored, has_body_text: true }, { ...incoming, body_text: "hi" }), null);
});
