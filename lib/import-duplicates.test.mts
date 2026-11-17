import { test } from "node:test";
import assert from "node:assert/strict";
import { hideOwners } from "./import-duplicates.ts";

test("other members collapse to 'other', own and unassigned stay distinct", () => {
  const out = hideOwners([
    { assigned_to: "ankit", count: 30 },
    { assigned_to: "ruby", count: 6 },
    { assigned_to: null, count: 2 },
    { assigned_to: "me", count: 1 },
  ], "me");
  assert.deepEqual(out, [
    { assigned_to: "other", count: 36 },
    { assigned_to: null, count: 2 },
    { assigned_to: "self", count: 1 },
  ]);
});

test("no real owner id leaks", () => {
  const out = hideOwners([{ assigned_to: "ankit", count: 5 }], "me");
  assert.ok(out.every((o) => o.assigned_to === null || o.assigned_to === "self" || o.assigned_to === "other"));
});
