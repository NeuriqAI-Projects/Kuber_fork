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
