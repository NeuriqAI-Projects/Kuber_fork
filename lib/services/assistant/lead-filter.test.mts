/** npx tsx --test lib/services/assistant/lead-filter.test.mts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLeadFilter, campaignJoinMode, describeLeadFilter, leadSelect, type LeadFilter,
} from "./tools/lead-filter.ts";
import type { AssistantCaller } from "./context.ts";

/** Records every builder call so the query a filter produces can be asserted. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["eq", "is", "in", "or", "ilike", "not", "gte", "lt"]) {
    q[m] = (...a: unknown[]) => { calls.push([m, ...a]); return q; };
  }
  return { q, calls };
}

const manager = { userId: "m1", role: "manager", companyId: "c1" } as unknown as AssistantCaller;
const employee = { userId: "e1", role: "employee", companyId: "c1" } as unknown as AssistantCaller;

test("employees are always limited to their own leads", () => {
  const { q, calls } = recorder();
  applyLeadFilter(q, employee, {}, {});
  assert.deepEqual(calls.find((c) => c[0] === "eq" && c[1] === "assigned_to"), ["eq", "assigned_to", "e1"]);
});

test("managers are not limited unless they ask", () => {
  const { q, calls } = recorder();
  applyLeadFilter(q, manager, {}, {});
  assert.equal(calls.some((c) => c[1] === "assigned_to"), false);
  assert.deepEqual(calls[0], ["eq", "is_deleted", false]);
});

test("'not in any campaign' is an anti-join on campaign_leads", () => {
  const f: LeadFilter = { status: ["enriched"], in_campaign: "none" };
  assert.equal(campaignJoinMode(f, {}), "anti");
  assert.match(leadSelect(f, {}, "id"), /campaign_leads!lead_id\(id\)/);
  const { q, calls } = recorder();
  applyLeadFilter(q, manager, f, {});
  assert.ok(calls.some((c) => c[0] === "is" && c[1] === "campaign_leads" && c[2] === null));
  assert.ok(calls.some((c) => c[0] === "in" && c[1] === "status"));
});

test("campaign filters use an inner join and filter the embedded rows", () => {
  const f: LeadFilter = { campaign_status: ["replied"], temperature: "hot" };
  assert.equal(campaignJoinMode(f, { campaignId: "camp" }), "inner");
  const { q, calls } = recorder();
  applyLeadFilter(q, manager, f, { campaignId: "camp" });
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "campaign_leads.campaign_id" && c[2] === "camp"));
  assert.ok(calls.some((c) => c[0] === "eq" && c[1] === "campaign_leads.lead_temperature" && c[2] === "hot"));
});

test("company / industry filters make the organization join inner", () => {
  assert.match(leadSelect({ industry: "plastics" }, {}, "id"), /organizations!inner/);
  assert.doesNotMatch(leadSelect({}, {}, "id"), /organizations!inner/);
});

test("minimal select drops embeds the filter does not need", () => {
  assert.equal(leadSelect({}, {}, "id", { minimal: true }), "id");
  assert.match(leadSelect({ in_campaign: "none" }, {}, "id", { minimal: true }), /campaign_leads/);
});

test("free text: every word must match, and filter syntax is stripped", () => {
  const { q, calls } = recorder();
  applyLeadFilter(q, manager, { query: "amit, shah)" }, {});
  const ors = calls.filter((c) => c[0] === "or").map((c) => String(c[1]));
  assert.equal(ors.length, 2);
  assert.ok(ors.every((o) => !o.includes(")") || o.endsWith("%")));
  assert.ok(ors[0].includes("amit") && ors[1].includes("shah"));
});

test("unassigned resolves to IS NULL", () => {
  const { q, calls } = recorder();
  applyLeadFilter(q, manager, {}, { assigneeId: "unassigned" });
  assert.ok(calls.some((c) => c[0] === "is" && c[1] === "assigned_to" && c[2] === null));
});

test("description reads like the filter", () => {
  assert.equal(describeLeadFilter({}, {}), "all leads");
  assert.equal(
    describeLeadFilter({ status: ["enriched"], country: "India", in_campaign: "none" }, {}),
    "status enriched, in India, not in any campaign",
  );
});
