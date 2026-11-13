// npx tsx --test lib/services/route-timing.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoOpRun } from "./route-timing.ts";

test("runs that did nothing are not logged; runs with work, errors or no counts are", () => {
  // Live payloads, 13 Nov 2026.
  assert.equal(isNoOpRun({ status: 200, processed: 0, succeeded: 0, failed: 0 }), true);
  assert.equal(isNoOpRun({ status: 200, matched: 0, archived: 0, verified: 0, remaining: 4, requested: 0,
    unverified: 0, credits_consumed: 0, credits_exhausted: true }), true);
  assert.equal(isNoOpRun({ status: 200, companies: 0 }), true);
  assert.equal(isNoOpRun({ status: 200, advanced: 0 }), true);

  assert.equal(isNoOpRun({ status: 200, processed: 15, succeeded: 14, failed: 1 }), false);
  assert.equal(isNoOpRun({ status: 200, companies: 1 }), false);
  assert.equal(isNoOpRun({ status: 200, triggered: true }), false); // no counts: can't tell
  assert.equal(isNoOpRun({ status: 200, page: 1, returned: 0, credits_spent: 0 }), false);
  assert.equal(isNoOpRun({ status: 500, processed: 0 }), false);
  assert.equal(isNoOpRun({ status: 200, processed: 0, error_code: "X" }), false);
  assert.equal(isNoOpRun({ threw: true }), false);
  assert.equal(isNoOpRun({}), false);
});
