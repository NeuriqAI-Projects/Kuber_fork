import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReopenCompleted } from "./sequence-publish.ts";

const live = { status: "active", is_deleted: false, sending_held_at: null };

test("a campaign Instantly closed as Completed is reopened when it still exists and runs in Kuber", () => {
  assert.equal(shouldReopenCompleted(3, live), true); // PACKAGING GROUP 1, 29 Sep 2026
});

test("a person's stop is never undone by a sequence edit", () => {
  assert.equal(shouldReopenCompleted(3, { ...live, is_deleted: true }), false);
  assert.equal(shouldReopenCompleted(3, { ...live, status: "paused" }), false);
  assert.equal(shouldReopenCompleted(3, { ...live, sending_held_at: "2026-09-29T06:00:00Z" }), false);
});

test("only Instantly's Completed state is touched", () => {
  assert.equal(shouldReopenCompleted(1, live), false); // already active
  assert.equal(shouldReopenCompleted(2, live), false); // paused in Instantly
  assert.equal(shouldReopenCompleted(undefined, live), false); // status unreadable
  assert.equal(shouldReopenCompleted(3, null), false);
});
