/** npx tsx --test lib/services/assistant/actions.test.mts */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.INTERNAL_SECRET ||= "test-secret-for-assistant-actions";
const { signProposal, verifyProposal, executeAction } = await import("./actions.ts");

const me = { userId: "u1", role: "manager", companyId: "c1", token: "t", baseUrl: "http://x" } as never;
const other = { userId: "u2", role: "manager", companyId: "c1", token: "t", baseUrl: "http://x" } as never;
const otherCompany = { userId: "u1", role: "manager", companyId: "c2", token: "t", baseUrl: "http://x" } as never;
const payload = { kind: "add_note", lead_id: "l1", lead_name: "Amit", text: "hi" } as const;

test("a proposal verifies for the person it was made for", async () => {
  const token = await signProposal(me, payload);
  const v = await verifyProposal(me, token);
  assert.ok("payload" in v);
  assert.deepEqual((v as { payload: unknown }).payload, payload);
});

test("someone else, or another company, cannot run it", async () => {
  const token = await signProposal(me, payload);
  assert.ok("error" in (await verifyProposal(other, token)));
  assert.ok("error" in (await verifyProposal(otherCompany, token)));
});

test("a tampered token is rejected", async () => {
  const token = await signProposal(me, payload);
  const [h, body, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString());
  forged.p.lead_id = "someone-else";
  const tampered = [h, Buffer.from(JSON.stringify(forged)).toString("base64url"), sig].join(".");
  assert.ok("error" in (await verifyProposal(me, tampered)));
});

test("a token runs once: the second click is refused before any request", async () => {
  const token = await signProposal(me, payload);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ success: true, data: {} })); }) as typeof fetch;
  try {
    const first = await executeAction(me, token);
    const second = await executeAction(me, token);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match(second.message, /already/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("confirmed / cancelled / waiting cards are reported to the model", async () => {
  const { actionOutcomes } = await import("./agent.ts");
  const card = (output: Record<string, unknown>) => ({ type: "tool-propose_create_campaign", toolCallId: "t", state: "output-available", input: {}, output });
  const text = actionOutcomes([{
    id: "a", role: "assistant", parts: [
      card({ proposal: { title: "Create campaign \"X\"" }, executed: { ok: true, message: "Created", link: "/campaigns/1" } }),
      card({ proposal: { title: "Pause \"Y\"" }, cancelled: true }),
      card({ proposal: { title: "Add note" } }),
    ],
  }] as never);
  assert.match(text ?? "", /Create campaign "X": DONE — Created \(\/campaigns\/1\)/);
  assert.match(text ?? "", /Pause "Y": CANCELLED/);
  assert.match(text ?? "", /Add note: still waiting/);
  assert.equal(actionOutcomes([{ id: "u", role: "user", parts: [{ type: "text", text: "hi" }] }] as never), null);
});
