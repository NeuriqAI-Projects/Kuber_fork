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

test("noLeadsLeft: blocks only when the size check says every page was read", async () => {
  const { noLeadsLeft } = await import("./estimate.ts");
  const c = { low: 100, mid: 200, high: 300 };
  assert.equal(noLeadsLeft({ companies: c, pages_used: 3, leads_left: { high: 0 } }), true);
  assert.equal(noLeadsLeft({ companies: c, pages_used: 3, leads_left: { high: 40 } }), false);
  assert.equal(noLeadsLeft({ companies: c, pages_used: 0, leads_left: { high: 0 } }), false); // never searched: "almost no leads", not blocked
  assert.equal(noLeadsLeft({ companies: { mid: 0 }, pages_used: 3, leads_left: { high: 0 } }), false);
  assert.equal(noLeadsLeft(null), false); // check failed or still loading: don't block
  // Page memory knows the last page and all were read: nothing new, even when the size guess says ~0 companies.
  assert.equal(noLeadsLeft({ companies: { mid: 0 }, pages_used: 2, total_pages: 2, leads_left: { high: 0 } }), true);
  assert.equal(noLeadsLeft({ companies: { mid: 0 }, pages_used: 1, total_pages: 2, leads_left: { high: 0 } }), false);
});
