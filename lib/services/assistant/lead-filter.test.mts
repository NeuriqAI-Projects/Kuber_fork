/** npx tsx --test lib/services/assistant/lead-filter.test.mts */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLeadFilter, campaignJoinMode, describeLeadFilter, leadSelect, type LeadFilter,
} from "./tools/lead-filter.ts";
import type { AssistantCaller } from "./context.ts";
import { SCOPE_TEMPLATES } from "../../auth/scope-areas.ts";
import { memberScopes, type Member } from "../../auth/scopes.ts";

/** Records every builder call so the query a filter produces can be asserted. */
function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const q: Record<string, (...a: unknown[]) => unknown> = {};
  for (const m of ["eq", "is", "in", "or", "ilike", "not", "gte", "lt"]) {
    q[m] = (...a: unknown[]) => { calls.push([m, ...a]); return q; };
  }
  return { q, calls };
}

function callerWith(id: string, template: "manager" | "employee"): AssistantCaller {
  const member: Member = { id, isOwner: false, active: true, scopes: SCOPE_TEMPLATES.find((t) => t.id === template)!.scopes };
  return { userId: id, companyId: "c1", member, scopes: memberScopes(member) } as unknown as AssistantCaller;
}
const manager = callerWith("m1", "manager");
const employee = callerWith("e1", "employee");

test("members without leads:all are always limited to their own leads", () => {
  const { q, calls } = recorder();
  applyLeadFilter(q, employee, {}, {});
  assert.deepEqual(calls.find((c) => c[0] === "eq" && c[1] === "assigned_to"), ["eq", "assigned_to", "e1"]);
});

test("members with leads:all are not limited unless they ask", () => {
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

test("Kuber AI tools are cut to the caller's scopes, in a fixed order", async () => {
  const { buildAssistantTools } = await import("./tools/index.ts");
  const names = (c: AssistantCaller) => Object.keys(buildAssistantTools({ ...c, db: {} } as AssistantCaller));
  const m = names(manager);
  const e = names(employee);
  assert.ok(m.includes("team_overview") && m.includes("propose_assign_leads") && m.includes("propose_reveal_emails"));
  for (const t of ["team_overview", "usage_and_credits", "propose_assign_leads", "propose_reveal_emails"]) assert.ok(!e.includes(t), t);
  assert.ok(e.includes("search_leads") && e.includes("propose_campaign_state") && e.includes("propose_reply_draft"));
  // Filter, never reorder (prompt cache): the employee list is the manager list minus some.
  assert.deepEqual(e, m.filter((n) => e.includes(n)));
  const bare = { ...employee, scopes: ["assistant:use"] } as unknown as AssistantCaller;
  assert.deepEqual(names(bare), []);
});
