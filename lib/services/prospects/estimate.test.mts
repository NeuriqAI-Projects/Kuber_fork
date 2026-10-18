// npx tsx --test lib/services/prospects/estimate.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateMarket } from "./estimate.ts";

test("people count → company and lead ranges (17 Oct 2026 calibration)", () => {
  // "pvc pipes": 42,663 people; Apollo's exact company count was 1,220.
  const e = estimateMarket(42663);
  assert.ok(e.companies.low <= 1220 && 1220 <= e.companies.high, JSON.stringify(e.companies));
  assert.equal(e.companies.mid, 1500);
  assert.deepEqual(e.leads, { low: 360, high: 580 });
  // A keyword with nothing behind it.
  assert.deepEqual(estimateMarket(0).companies, { low: 0, mid: 0, high: 0 });
});
