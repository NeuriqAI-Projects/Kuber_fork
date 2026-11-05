import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReopenCompleted, nextPublishTryAt, PUBLISH_MAX_FAILURES } from "./sequence-publish.ts";
import { issuesFromLogs } from "./service-health.ts";

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

test("a publish that keeps failing backs off 1/5/15/60 min, then stops until the next save", () => {
  const t = Date.parse("2026-11-05T10:00:00Z");
  assert.equal(nextPublishTryAt(0, 0), 0, "never failed: try now");
  assert.equal(nextPublishTryAt(1, t), t + 60_000);
  assert.equal(nextPublishTryAt(2, t), t + 5 * 60_000);
  assert.equal(nextPublishTryAt(3, t), t + 15 * 60_000);
  assert.equal(nextPublishTryAt(4, t), t + 60 * 60_000);
  assert.equal(nextPublishTryAt(PUBLISH_MAX_FAILURES, t), null, "gave up");
});

test("a failed publish shows the follow-up schedule banner; a later success takes it down", () => {
  const failed = { source: "instantly", event: "SEQUENCE_PUBLISH_FAILED", error: "\"X\": the new follow-up schedule could not be sent" };
  const ok = { source: "instantly", event: "SEQUENCE_PUBLISHED", error: null };
  assert.deepEqual(issuesFromLogs([failed]).map((i) => `${i.service}:${i.severity}`), ["Follow-up schedule:warning"]);
  assert.deepEqual(issuesFromLogs([ok, failed]), [], "newest row wins");
});
