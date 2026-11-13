// Bulk certify / bulk delete must split big selections to fit the routes' id caps
// (bulk-approve: 200, bulk-delete: 500). A 402-draft certify used to fail outright.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bulkApproveDrafts, bulkDeleteLeads } from "./api-client.ts";

function fakeServer(cap: number, key: string, reply: (n: number) => unknown) {
  const sizes: number[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const ids = JSON.parse(String(init.body))[key] as string[];
    sizes.push(ids.length);
    const body = ids.length > cap
      ? { success: false, data: null, error: { message: "Invalid request" } }
      : { success: true, data: reply(ids.length), error: null };
    return new Response(JSON.stringify(body), { status: body.success ? 200 : 400 });
  }) as typeof fetch;
  return sizes;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

test("certify 402 drafts -> 200 + 200 + 2, counts summed", async () => {
  const sizes = fakeServer(200, "draft_ids", (n) => ({ approved: n - 1, skipped: 1 }));
  const r = await bulkApproveDrafts("tok", ids(402));
  assert.deepEqual(sizes, [200, 200, 2]);
  assert.deepEqual(r, { approved: 399, skipped: 3 });
});

test("delete 1200 leads -> 500 + 500 + 200, counts summed", async () => {
  const sizes = fakeServer(500, "ids", (n) => ({ deleted: n }));
  const r = await bulkDeleteLeads("tok", ids(1200));
  assert.deepEqual(sizes, [500, 500, 200]);
  assert.deepEqual(r, { deleted: 1200 });
});
