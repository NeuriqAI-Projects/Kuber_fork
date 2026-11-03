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
  // A count that stopped early with only known companies so far: more may come, don't block.
  assert.equal(noLeadsLeft({ companies: c, pages_used: 3, total_pages: null, leads_left: { high: 0 }, at_least: true }), false);
  assert.equal(noLeadsLeft({ companies: c, pages_used: 3, total_pages: 3, leads_left: { high: 0 }, at_least: true }), true);
  // Page memory knows the last page and all were read: nothing new, even when the size guess says ~0 companies.
  assert.equal(noLeadsLeft({ companies: { mid: 0 }, pages_used: 2, total_pages: 2, leads_left: { high: 0 } }), true);
  assert.equal(noLeadsLeft({ companies: { mid: 0 }, pages_used: 1, total_pages: 2, leads_left: { high: 0 } }), false);
});

test("normCompanyName: one key per company across legal endings, case, accents", async () => {
  const { normCompanyName } = await import("./estimate.ts");
  assert.equal(normCompanyName("GEKOPLAST S.A."), normCompanyName("Gekoplast"));
  assert.equal(normCompanyName("Plastimex S.A. de C.V."), "plastimex");
  assert.equal(normCompanyName("Pakmar Sp. z o.o."), "pakmar");
  assert.equal(normCompanyName("Plásticos Andinos Ltda."), "plasticos andinos");
  assert.equal(normCompanyName("R&G PLAST"), "r g plast");
  assert.notEqual(normCompanyName("Poly Bags Ltd"), normCompanyName("Poly Film Ltd"));
  assert.equal(normCompanyName("Polyplast Pvt. Ltd."), normCompanyName("Polyplast Private Limited"));
  assert.equal(normCompanyName("Polyplast Pvt. Ltd."), "polyplast");
  // Only endings are legal forms: words in the middle or at the start stay.
  assert.equal(normCompanyName("A S Plastics"), "a s plastics");
  assert.equal(normCompanyName("Co Pack Group Ltd"), "co pack");
  assert.notEqual(normCompanyName("Inc Plast"), normCompanyName("Plast"));
  assert.equal(normCompanyName("Group Co"), "group"); // at least one word always stays
  // Dotted and undotted spellings are one company.
  for (const [a, b] of [["Plastik S.p.A.", "Plastik SpA"], ["Acme B.V.", "Acme BV"], ["Acme A/S", "Acme AS"], ["Tubos S.A.C.", "Tubos SAC"],
    ["Plasticos S. de R.L. de C.V.", "Plasticos"], ["Plasticos S.A.B. de C.V.", "Plasticos SA de CV"], ["Acme GmbH & Co. KG", "Acme"], ["Acme Pty Ltd", "Acme"]])
    assert.equal(normCompanyName(a), normCompanyName(b), `${a} vs ${b}`);
  assert.equal(normCompanyName(null), "");
  assert.equal(normCompanyName("  "), "");
});

test("leadShare: past searches with the same keywords, pulled toward the default when there are few", async () => {
  const { leadShare, DEFAULT_LEAD_SHARE } = await import("./estimate.ts");
  assert.deepEqual(leadShare([], ["injection molding"]), { share: DEFAULT_LEAD_SHARE, searches: 0, fromHistory: false }); // never searched
  const h = [
    { keywords: ["injection molding", "thermoforming"], available: 215, scored: 332 },
    { keywords: ["geomembrane"], available: 44, scored: 259 },
  ];
  const inj = leadShare(h, ["Injection Molding ", "thermoforming"]).share; // case and spaces don't matter
  assert.ok(inj > 0.6 && inj < 0.65, String(inj));
  const geo = leadShare(h, ["geomembrane"]).share;
  assert.ok(geo > 0.19 && geo < 0.23, String(geo));
  assert.equal(leadShare(h, ["pet bottles"]).share, DEFAULT_LEAD_SHARE); // other keywords' history doesn't leak in
  const tiny = leadShare([{ keywords: ["x"], available: 5, scored: 5 }], ["x"]).share; // 5 of 5 is not proof of 100%
  assert.ok(tiny < 0.55, String(tiny));
  // One huge search with every keyword (72% leads) must not outvote the keyword's own 17% history.
  const wide = { keywords: ["geomembrane", ...Array.from({ length: 82 }, (_, i) => `kw${i}`)], available: 276, scored: 381 };
  const g2 = leadShare([...h, wide], ["geomembrane"]);
  assert.ok(g2.share < 0.25, String(g2.share));
  assert.equal(g2.searches, 2);
  // A sliver of a wide search is not "history": only 1/83 of it matches.
  assert.equal(leadShare([wide], ["geomembrane"]).fromHistory, false);
  assert.equal(leadShare(h, ["geomembrane"]).fromHistory, true);
});

test("estimateFromCount: counted buyers → companies and a ±25% lead range", async () => {
  const { estimateFromCount } = await import("./estimate.ts");
  // Injection moulding, E. Europe (3 Nov 2026): 311 buyer companies, Apollo had 377.
  const e = estimateFromCount({ buyerCompanies: 311, newBuyerCompanies: 300, complete: true, share: 0.62, people: 1103 });
  assert.equal(e.companies.mid, 370);
  assert.ok(e.companies.low <= 377 && 377 <= e.companies.high, JSON.stringify(e.companies));
  assert.ok(e.leads.low < 215 && 215 < e.leads.high * 1.1, JSON.stringify(e.leads)); // real: 215 available
  assert.equal(e.at_least, false);
  assert.equal(estimateFromCount({ buyerCompanies: 900, newBuyerCompanies: 900, complete: false, share: 0.4, people: 60211 }).at_least, true);
  const none = estimateFromCount({ buyerCompanies: 0, newBuyerCompanies: 0, complete: true, share: 0.4, people: 0 });
  assert.deepEqual([none.companies.mid, none.leads.high], [0, 0]);
});
