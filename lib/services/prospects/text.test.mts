// npx tsx --test lib/services/prospects/text.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, wordCount, htmlToText, linksFromMarkdown, pickSecondPage, sitemapLocs, dropCookieText, companyName } from "./text.ts";
import { verdict, displayScore, reasonFor, DEFAULT_FIT_SCORING } from "./fit-rules.ts";

test("cleaning drops images, link targets, bare URLs and repeated lines", () => {
  const t = cleanText("![logo](a.png)\n# Hi [About us](/about) https://x.com\nHi About us\nhi about us\n");
  assert.equal(t, "Hi About us");
  assert.equal(wordCount(t), 3);
});

test("second page: About beats Products, same site only, no files", () => {
  const home = "https://www.acme.com/";
  assert.equal(pickSecondPage(home, ["https://acme.com/products/", "https://www.acme.com/about-us", "https://other.com/about"]), "https://www.acme.com/about-us");
  assert.equal(pickSecondPage(home, ["https://acme.com/brochure.pdf", "https://acme.com/quienes-somos"]), "https://acme.com/quienes-somos");
  assert.equal(pickSecondPage(home, ["https://acme.com/blog/post-1"]), null);
  assert.equal(pickSecondPage("not a url", ["https://acme.com/about"]), null);
});

test("links and sitemap parsing", () => {
  assert.deepEqual(linksFromMarkdown("[About](/empresa) [x](https://b.com/a)", "https://a.com/"), ["https://a.com/empresa", "https://b.com/a"]);
  assert.deepEqual(sitemapLocs("<urlset><url><loc> https://a.com/about </loc></url></urlset>"), ["https://a.com/about"]);
  assert.equal(htmlToText("<style>x{}</style><p>Hello&nbsp;world</p>"), "Hello world");
});

test("decision rules: plastic maker ≥65% good, ≤35% hidden, between unsure; 9/7/2 shown", () => {
  const C = DEFAULT_FIT_SCORING;
  assert.deepEqual([0.1, 0.35, 0.5, 0.64, 0.65, 0.95].map((p) => verdict(p, C)), ["hidden", "hidden", "unsure", "unsure", "good", "good"]);
  assert.deepEqual([displayScore(0.9, 0.9, C), displayScore(0.9, 0.1, C), displayScore(0.5, 0.9, C), displayScore(0.1, 0.9, C)], [9, 7, null, 2]);
  assert.match(reasonFor(0.12, 0.9, C), /Not a plastic maker \(12%\)/);
});

test("cookie banners are dropped, so a banner-only page reads as almost no text", () => {
  const banner = cleanText("We use cookies to improve your experience.\nAccept all\nReject all\nManage preferences\nPrivacy settings");
  const pt = cleanText("Utilizamos cookies para melhorar a sua experiência, de acordo com a LGPD.\nAceitar\nPolítica de Privacidade");
  for (const t of [banner, pt]) {
    const r = dropCookieText(t);
    assert.ok(r.hadCookies);
    assert.ok(wordCount(r.text) < 20, r.text);
  }
  const real = "We extrude PE film for food packaging on 12 blown film lines.\nOur factory runs 24/7.\nWe use cookies.";
  const r = dropCookieText(real);
  assert.equal(r.text, "We extrude PE film for food packaging on 12 blown film lines.\nOur factory runs 24/7.");
});

test("junk Apollo names: the company it points to, else the website name", () => {
  assert.equal(companyName("This page is closed. Please see Trioworld Group page", null), "Trioworld Group");
  assert.equal(companyName("This page is no longer available", "acme-plast.com"), "Acme-plast (name from website)");
  assert.equal(companyName("Berry Global, Inc.", "berryglobal.com"), "Berry Global, Inc.");
  assert.equal(companyName("", "www.kanaflex.com"), "Kanaflex (name from website)");
  assert.equal(companyName(null, null), "Unknown company");
});
