/** npx tsx --test lib/assistant-markdown.test.mts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown } from "./assistant-markdown.ts";

test("paragraphs, lists and headings", () => {
  const b = parseMarkdown("We have **2,537 leads**.\n\n- Enriched: 2,024\n- Input required: 513\n\n### Next\n1. Do this\n2. Then that");
  assert.deepEqual(b.map((x) => x.type), ["p", "ul", "h", "ol"]);
  assert.deepEqual((b[1] as { items: string[] }).items, ["Enriched: 2,024", "Input required: 513"]);
});

test("pipe tables", () => {
  const b = parseMarkdown("| Campaign | Sent |\n|---|---:|\n| A | 10 |\n| B | 4 |");
  assert.equal(b[0].type, "table");
  assert.deepEqual((b[0] as { rows: string[][] }).rows, [["A", "10"], ["B", "4"]]);
});

test("a lone pipe line is just text", () => {
  assert.equal(parseMarkdown("a | b")[0].type, "p");
});
