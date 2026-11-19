import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAttachment, filesBlockHtml, FILES_BLOCK_LABEL, ATTACHMENT_MAX_BYTES } from "./attachment-upload.ts";

test("25 MB limit", () => {
  assert.equal(checkAttachment("application/pdf", ATTACHMENT_MAX_BYTES), null);
  assert.match(checkAttachment("application/pdf", ATTACHMENT_MAX_BYTES + 1) ?? "", /25 MB/);
  assert.match(checkAttachment("text/x-sh", 10) ?? "", /Unsupported/);
});

test("files block: one escaped link per file, empty when none", () => {
  assert.equal(filesBlockHtml([]), "");
  const html = filesBlockHtml([
    { name: "Brochure.pdf", size: 2 * 1024 * 1024, url: "https://x/a?t=1&b=2" },
    { name: "<Price>.xlsx", size: 500, url: "https://x/b" },
  ]);
  assert.ok(html.startsWith(`<p>${FILES_BLOCK_LABEL}<br>`));
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.ok(html.includes('href="https://x/a?t=1&amp;b=2"'));
  assert.ok(html.includes("&lt;Price&gt;.xlsx</a> (1 KB)"));
  assert.ok(html.includes("Brochure.pdf</a> (2.0 MB)"));
});

test("upload paths stay inside the caller's company folder", async () => {
  const { isOwnUploadPath, uploadPrefix } = await import("./attachment-upload.ts");
  const co = "00000000-0000-0000-0000-00000000000a";
  assert.equal(uploadPrefix(co), `uploads/${co}/`);
  assert.ok(isOwnUploadPath(`uploads/${co}/${"a".repeat(64)}/Brochure.pdf`, co));
  assert.ok(!isOwnUploadPath(`uploads/00000000-0000-0000-0000-00000000000b/x/B.pdf`, co));
  assert.ok(!isOwnUploadPath(`uploads/${co}/../other/B.pdf`, co));
  assert.ok(!isOwnUploadPath(`branding/${co}/logo.png`, co));
});

test("replaceFilesBlock swaps, appends, removes, and survives editor re-serialising", async () => {
  const { replaceFilesBlock, filesBlockHtml } = await import("./attachment-upload.ts");
  const a = filesBlockHtml([{ name: "A.pdf", size: 1024, url: "https://x/a" }]);
  const b = filesBlockHtml([{ name: "B.pdf", size: 2048, url: "https://x/b" }]);
  const body = "<p>Dear Ravi,<br><br>Hello.</p><p>Best regards,<br>Pushkar</p>";
  assert.equal(replaceFilesBlock(body, a), body + a);                 // none yet -> append
  assert.equal(replaceFilesBlock(body + a, b), body + b);             // swap
  assert.equal(replaceFilesBlock(body + a, ""), body);                // remove
  const edited = body + '<p class="x">Attached files:<br><a target="_blank" rel="noopener noreferrer nofollow" href="https://x/a">A.pdf</a> (1 KB)</p>';
  assert.equal(replaceFilesBlock(edited, b), body + b);               // TipTap-style markup
  assert.equal((replaceFilesBlock(body + a, b).match(/Attached files:/g) ?? []).length, 1);
});
