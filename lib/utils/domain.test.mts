/**
 * npx tsx --test lib/utils/domain.test.mts
 *
 * Why this exists: the worker guesses an org's website from its leads' emails and merges
 * orgs that share a website. A bare TLD ("com" from "x@mail.com") or a webmail host
 * ("gmail.com") taken as a "website" made unrelated companies look like one, and their
 * leads were merged together (16 Nov 2026).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveDomainFromEmail, normalizeDomain } from "./domain.ts";

const FREE = [
  "mail.com", "gmail.com", "googlemail.com", "hanmail.net", "naver.com", "qq.com", "163.com",
  "mail.ru", "web.de", "yandex.ru", "yahoo.co.in", "hotmail.co.uk", "outlook.in", "live.fr",
  "yahoo.com", "outlook.com", "hotmail.com", "rediffmail.com",
];

test("every free/webmail provider gives no website", () => {
  for (const host of FREE) {
    assert.equal(deriveDomainFromEmail(`x@${host}`), null, host);
    assert.equal(deriveDomainFromEmail(`Some.One@${host.toUpperCase()}`), null, host);
  }
});

test("a work email gives its domain, lower-cased", () => {
  assert.equal(deriveDomainFromEmail("A@Tata-Packaging.COM"), "tata-packaging.com");
  assert.equal(deriveDomainFromEmail("  p@acme.co.in  "), "acme.co.in");
  assert.equal(deriveDomainFromEmail("x@mail.acme.com"), "acme.com");
});

test("malformed emails give no website", () => {
  for (const e of ["", "x", "x@", "@acme.com", "x@com", "x y@acme.com", "x@@acme.com"]) {
    assert.equal(deriveDomainFromEmail(e), null, JSON.stringify(e));
  }
});

test("no result is ever dot-less", () => {
  for (const e of ["x@mail.com", "x@mail.ru", "x@app.io", "x@portal.com", "x@www.com"]) {
    const d = deriveDomainFromEmail(e);
    assert.ok(d === null || d.includes("."), `${e} -> ${d}`);
  }
});

test("normalizeDomain strips protocol, www, path, case and app subdomains", () => {
  assert.equal(normalizeDomain("https://www.Acme.com/about"), "acme.com");
  assert.equal(normalizeDomain("http://ACME.com"), "acme.com");
  assert.equal(normalizeDomain("  acme.com/x/y?z=1 "), "acme.com");
  assert.equal(normalizeDomain("mail.acme.co.in"), "acme.co.in");
  assert.equal(normalizeDomain("app.acme.com"), "acme.com");
  assert.equal(normalizeDomain("portal.acme.com"), "acme.com");
});

test("normalizeDomain rejects emails and anything without a dot", () => {
  assert.equal(normalizeDomain("jm@o2.ie"), "");
  for (const raw of ["com", "ru", "mail.com", "https://mail.com/", "app.io", "", "   "]) {
    assert.equal(normalizeDomain(raw), "", JSON.stringify(raw));
  }
});
