// Run: npx tsx --test lib/utils/email-tables.test.mts
// Expected strings were produced by the version that imported sanitize-html at the
// top of the file; the lazy-load version must stay byte-identical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToHtmlWithTables } from "./email-tables.ts";

const SAMPLES = [
  "Hi Ravi,\n\nThanks for the call.\n\nBest,\nAmit",
  "Hi Ravi,\n\nHere are the grades:\n\n<table><tr><th>Grade</th><th>MFI</th></tr><tr><td>**Black 50%**</td><td>12</td></tr></table>\n\nLet me know.\nAmit",
  "Intro line.\n<TABLE border=\"0\" style=\"color:red\" onclick=\"x()\">\n  <thead>\n    <tr>\n      <th colspan=\"2\" class=\"h\">Product</th>\n    </tr>\n  </thead>\n  <tbody>\n    <tr><td><a href=\"javascript:alert(1)\">bad</a></td><td><a href=\"https://kuberpolyplast.com\" target=\"_blank\">site</a></td></tr>\n    <tr><td><script>alert(1)</script>ok</td><td><img src=x>*italic* and _u_</td></tr>\n  </tbody>\n</TABLE>\nMiddle text with **bold**.\n<table><caption>Two</caption><tr><td>a</td></tr></table>",
  "No table but <b>bold</b> & ampersand < less",
  "<table><tr><td>only table</td></tr></table>",
  "Text before\n\n<table cellpadding=\"2\" width=\"100%\" align=\"center\"><tr><td rowspan=\"2\" width=\"50\">x</td><td>y\n\n\nz</td></tr><tr><td>- list\n- items</td></tr></table>\n\n\nSignature\nKuber Polyplast | +91 99999",
];
const EXPECTED = [
  "<p>Hi Ravi,<br><br>Thanks for the call.<br><br>Best,<br>Amit</p>",
  "<p>Hi Ravi,<br><br>Here are the grades:</p><table border=\"1\" cellpadding=\"8\" cellspacing=\"0\"><tr><th>Grade</th><th>MFI</th></tr><tr><td><strong>Black 50%</strong></td><td>12</td></tr></table><p>Let me know.<br>Amit</p>",
  "<p>Intro line.</p><table border=\"0\" cellpadding=\"8\" cellspacing=\"0\"><thead><tr><th colspan=\"2\">Product</th></tr></thead><tbody><tr><td><a>bad</a></td><td><a href=\"https://kuberpolyplast.com\" target=\"_blank\">site</a></td></tr><tr><td>ok</td><td><em>italic</em> and _u_</td></tr></tbody></table><p>Middle text with <strong>bold</strong>.</p><table border=\"1\" cellpadding=\"8\" cellspacing=\"0\"><caption>Two</caption><tr><td>a</td></tr></table>",
  "<p>No table but &lt;b&gt;bold&lt;/b&gt; &amp; ampersand &lt; less</p>",
  "<table border=\"1\" cellpadding=\"8\" cellspacing=\"0\"><tr><td>only table</td></tr></table>",
  "<p>Text before</p><table border=\"1\" cellpadding=\"2\" cellspacing=\"0\" width=\"100%\" align=\"center\"><tr><td rowspan=\"2\" width=\"50\">x</td><td>y z</td></tr><tr><td>- list - items</td></tr></table><p>Signature<br>Kuber Polyplast | +91 99999</p>"
];

test("output is byte-identical to the eager-import version", () => {
  SAMPLES.forEach((s, i) => assert.equal(plainToHtmlWithTables(s), EXPECTED[i], `sample ${i}`));
});
