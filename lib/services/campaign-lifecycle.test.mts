/** npx tsx lib/services/campaign-lifecycle.test.mts */
import { strict as assert } from "assert";
import { holdWasForJob, HOLD_FOR_JOB_WINDOW_MS } from "./campaign-lifecycle.ts";

const t0 = Date.parse("2026-09-18T07:10:00Z");
const at = (ms: number) => new Date(t0 + ms).toISOString();
const A = "user-a", B = "user-b";

// "Hold and regenerate": same person, job started two minutes after the hold.
assert.equal(holdWasForJob({ sending_held_at: at(0), sending_held_by: A }, { requested_by: A, created_at: at(2 * 60_000) }), true);
// Right at the edge of the window still counts.
assert.equal(holdWasForJob({ sending_held_at: at(0), sending_held_by: A }, { requested_by: A, created_at: at(HOLD_FOR_JOB_WINDOW_MS) }), true);
// Somebody else's hold is their deliberate stop.
assert.equal(holdWasForJob({ sending_held_at: at(0), sending_held_by: A }, { requested_by: B, created_at: at(60_000) }), false);
// An old hold (Apollo AI 01, three days) is not this job's.
assert.equal(holdWasForJob({ sending_held_at: at(0), sending_held_by: A }, { requested_by: A, created_at: at(3 * 24 * 3_600_000) }), false);
// A hold taken AFTER the job started was not taken for it.
assert.equal(holdWasForJob({ sending_held_at: at(60_000), sending_held_by: A }, { requested_by: A, created_at: at(0) }), false);
// Not held at all, or a system-requested job: nothing to release.
assert.equal(holdWasForJob({ sending_held_at: null, sending_held_by: null }, { requested_by: A, created_at: at(0) }), false);
assert.equal(holdWasForJob(null, { requested_by: A, created_at: at(0) }), false);
assert.equal(holdWasForJob({ sending_held_at: at(0), sending_held_by: A }, { requested_by: null, created_at: at(60_000) }), false);

console.log("campaign-lifecycle: holdWasForJob checks passed");
