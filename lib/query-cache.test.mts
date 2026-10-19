/**
 * The client GET cache behind useCached / prefetch (lib/query-cache.ts).
 * Run: npx tsx --test lib/query-cache.test.mts
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { QueryCache, resourceOf } from "./query-cache";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("resourceOf picks the first segment after /api/v1", () => {
  assert.equal(resourceOf("/api/v1/campaigns/abc/pause?x=1"), "campaigns");
  assert.equal(resourceOf("/api/v1/leads"), "leads");
  assert.equal(resourceOf("/api/v1/leads?page=2"), "leads");
});

test("fetch stores data and later reads return it instantly", async () => {
  const c = new QueryCache();
  let calls = 0;
  const data = await c.fetch("/api/v1/campaigns", async () => { calls++; return [1, 2]; });
  assert.deepEqual(data, [1, 2]);
  assert.deepEqual(c.getData("/api/v1/campaigns"), [1, 2]);
  // Inside maxAge: served from cache, no new request.
  const again = await c.fetch("/api/v1/campaigns", async () => { calls++; return [3]; }, { maxAgeMs: 10_000 });
  assert.deepEqual(again, [1, 2]);
  assert.equal(calls, 1);
});

test("concurrent fetches of one key share a single request", async () => {
  const c = new QueryCache();
  const d = deferred<string>();
  let calls = 0;
  const fetcher = () => { calls++; return d.promise; };
  const a = c.fetch("k", fetcher);
  const b = c.fetch("k", fetcher);
  await Promise.resolve();
  assert.equal(calls, 1);
  d.resolve("x");
  assert.equal(await a, "x");
  assert.equal(await b, "x");
  // Settled: the next fetch starts a new request.
  await c.fetch("k", async () => { calls++; return "y"; });
  assert.equal(calls, 2);
  assert.equal(c.getData("k"), "y");
});

test("revalidation keeps the old value visible until the new one lands", async () => {
  const c = new QueryCache();
  await c.fetch("k", async () => "old");
  const d = deferred<string>();
  const p = c.fetch("k", () => d.promise);
  await Promise.resolve();
  assert.equal(c.getData("k"), "old");
  assert.equal(c.get("k")?.validating, true);
  d.resolve("new");
  await p;
  assert.equal(c.getData("k"), "new");
  assert.equal(c.get("k")?.validating, false);
});

test("an error keeps the last good data and is reported", async () => {
  const c = new QueryCache();
  await c.fetch("k", async () => "good");
  await assert.rejects(c.fetch("k", async () => { throw new Error("boom"); }));
  assert.equal(c.getData("k"), "good");
  assert.equal((c.get("k")?.error as Error).message, "boom");
});

test("a fetcher that throws synchronously still settles cleanly", async () => {
  const c = new QueryCache();
  await assert.rejects(c.fetch("k", () => { throw new Error("sync"); }));
  assert.equal(c.get("k")?.validating, false);
  // No stuck in-flight promise: a later fetch runs.
  assert.equal(await c.fetch("k", async () => 1), 1);
});

test("subscribers are notified on writes and snapshots change identity", async () => {
  const c = new QueryCache();
  let n = 0;
  const unsub = c.subscribe("k", () => n++);
  const before = c.get("k");
  c.set("k", 1);
  assert.ok(n > 0);
  assert.notEqual(c.get("k"), before);
  const snap = c.get("k");
  c.set<number>("k", (prev) => (prev ?? 0) + 1);
  assert.equal(c.getData("k"), 2);
  assert.notEqual(c.get("k"), snap);
  unsub();
  const seen = n;
  c.set("k", 3);
  assert.equal(n, seen);
});

test("seed fills only an empty key and is treated as stale", () => {
  const c = new QueryCache();
  c.seed("lead:1", { id: "1", name: "row" });
  assert.deepEqual(c.getData("lead:1"), { id: "1", name: "row" });
  assert.equal(c.isFresh("lead:1", 60_000), false);
  c.set("lead:1", { id: "1", name: "full" });
  c.seed("lead:1", { id: "1", name: "row again" });
  assert.deepEqual(c.getData("lead:1"), { id: "1", name: "full" });
});

test("changing scope (user) drops everything, and late responses from the old user are discarded", async () => {
  const c = new QueryCache();
  c.setScope("user-a");
  await c.fetch("/api/v1/leads", async () => ["a-lead"]);
  const d = deferred<string[]>();
  const late = c.fetch("/api/v1/campaigns", () => d.promise);
  assert.equal(c.setScope("user-a"), false, "same user keeps the cache");
  assert.deepEqual(c.getData("/api/v1/leads"), ["a-lead"]);
  assert.equal(c.setScope("user-b"), true);
  assert.equal(c.getData("/api/v1/leads"), undefined);
  d.resolve(["a-campaign"]);
  await late;
  assert.equal(c.getData("/api/v1/campaigns"), undefined, "user A's response must not land in user B's cache");
});

test("clear() empties the cache and notifies listeners", async () => {
  const c = new QueryCache();
  await c.fetch("k", async () => 1);
  let n = 0;
  c.subscribe("k", () => n++);
  c.clear();
  assert.equal(c.getData("k"), undefined);
  assert.ok(n > 0);
});

test("invalidate marks stale and refetches only mounted keys", async () => {
  const c = new QueryCache();
  let mounted = 0;
  let unmounted = 0;
  await c.fetch("/api/v1/leads", async () => { mounted++; return mounted; });
  await c.fetch("/api/v1/leads/count", async () => { unmounted++; return unmounted; });
  c.subscribe("/api/v1/leads", () => {});
  c.invalidate("/api/v1/leads");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(mounted, 2, "mounted key refetched");
  assert.equal(unmounted, 1, "unmounted key only marked stale");
  assert.equal(c.get("/api/v1/leads/count")?.stale, true);
  assert.equal(c.isFresh("/api/v1/leads/count", 60_000), false);
});

test("a mutation refetches mounted related keys and leaves unrelated ones alone", async () => {
  const c = new QueryCache();
  const calls: Record<string, number> = {};
  const f = (k: string) => async () => { calls[k] = (calls[k] ?? 0) + 1; return calls[k]; };
  for (const k of ["/api/v1/campaigns", "/api/v1/dashboard/analytics", "/api/v1/settings", "/api/v1/unibox/threads"]) {
    await c.fetch(k, f(k));
    c.subscribe(k, () => {});
  }
  c.invalidateForMutation("/api/v1/campaigns/abc/pause");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls["/api/v1/campaigns"], 2);
  assert.equal(calls["/api/v1/dashboard/analytics"], 2);
  assert.equal(calls["/api/v1/settings"], 1, "unrelated mounted key is not refetched");
  assert.equal(c.get("/api/v1/settings")?.stale, false, "and stays fresh");
  assert.equal(calls["/api/v1/unibox/threads"], 1);
});

test("a mutation stales unmounted related keys so their next read revalidates", async () => {
  const c = new QueryCache();
  let n = 0;
  await c.fetch("/api/v1/leads/abc", async () => ++n);
  c.invalidateForMutation("/api/v1/leads/abc");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(n, 1, "not mounted: no request now");
  assert.equal(c.isFresh("/api/v1/leads/abc", 60_000), false);
  assert.equal(await c.fetch("/api/v1/leads/abc", undefined, { maxAgeMs: 60_000 }), 2, "stale entry refetches even inside maxAge");
});

test("fetch without a registered fetcher rejects", async () => {
  const c = new QueryCache();
  await assert.rejects(c.fetch("nope"));
});
