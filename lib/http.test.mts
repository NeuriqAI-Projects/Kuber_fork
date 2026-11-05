import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry } from "./http.ts";

function fakeFetch(responses: Array<() => Response>) {
  let calls = 0;
  globalThis.fetch = (async () => responses[Math.min(calls++, responses.length - 1)]()) as typeof fetch;
  return () => calls;
}

test("Retry-After is capped at 5 s", async () => {
  const calls = fakeFetch([
    () => new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    () => new Response("ok", { status: 200 }),
  ]);
  const t0 = Date.now();
  const res = await fetchWithRetry("llm", "http://x", {});
  const took = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.equal(calls(), 2);
  assert.ok(took >= 4_900 && took < 6_000, `waited ${took} ms`);
});

test("no new attempt starts past the deadline", async () => {
  const calls = fakeFetch([() => new Response("", { status: 503 })]);
  const res = await fetchWithRetry("llm", "http://x", {}, { deadline: Date.now() + 500 });
  assert.equal(res.status, 503);
  assert.equal(calls(), 1); // first retry would wait 1 s, past the 0.5 s deadline
});

test("network errors also stop at the deadline", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("ECONNRESET"); }) as typeof fetch;
  await assert.rejects(fetchWithRetry("llm", "http://x", {}, { deadline: Date.now() + 500 }), /ECONNRESET/);
  assert.equal(calls, 1);
});

test("retries still run inside the deadline", async () => {
  const calls = fakeFetch([
    () => new Response("", { status: 500 }),
    () => new Response("ok", { status: 200 }),
  ]);
  const res = await fetchWithRetry("llm", "http://x", {});
  assert.equal(res.status, 200);
  assert.equal(calls(), 2);
});

test("apollo still never retries", async () => {
  const calls = fakeFetch([() => new Response("", { status: 429, headers: { "Retry-After": "1" } })]);
  const res = await fetchWithRetry("apollo", "http://x", {});
  assert.equal(res.status, 429);
  assert.equal(calls(), 1);
});
