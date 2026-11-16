// HTTP checks of the scopes spec against the local dev server. Needs setup.mts first.
// Run: node --experimental-strip-types --no-warnings --test --test-concurrency=1 scripts/scopes-e2e/api.test.mts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { admin, api, msg, need, tokenFor, ownerToken, loadState, saveState, DEV } from "./lib.mts";

const S = loadState();
if (!S) throw new Error("run setup.mts first");
const M = S.members;
const CAMP = "f024ea4e-91fa-405c-87a4-0565dc172bd4"; // existing Dev draft campaign, read-only use
const RND = randomUUID(); // destructive routes get a random id: the guard runs first, and a broken guard can't hurt real rows
const T = {};
let ownerId;
const db = admin();

before(async () => {
  for (const k of Object.keys(M)) T[k] = await tokenFor(M[k].email, M[k].password).catch(() => null); // a deactivated member cannot sign in
  T.OWNER = await ownerToken();
  ownerId = (await db.from("profiles").select("id").eq("email", "lakshit@gmail.com").single()).data.id;
});

const forbid = async (who, method, path, scope, body) => {
  const r = await api(T[who], method, path, body);
  assert.equal(r.status, 403, `${who} ${method} ${path}: status ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  assert.equal(msg(r), need(scope), `${who} ${method} ${path}: message`);
};
const allow = async (who, method, path, body) => {
  const r = await api(T[who], method, path, body);
  assert.equal(r.status, 200, `${who} ${method} ${path}: status ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r;
};
const rowsOf = (data) => (Array.isArray(data) ? data : data?.leads ?? data?.items ?? data?.data ?? data?.rows ?? []);

// ── 1. Refusals ──
test("1a READONLY refused on writes/spends in every area", async (t) => {
  const { data: cur } = await db.from("settings").select("value").eq("company_id", DEV).eq("key", "client_industry").maybeSingle();
  const cases = [
    ["PATCH", `/api/v1/leads/${RND}`, "leads:write", { title: "x" }],
    ["POST", "/api/v1/leads/bulk-assign", "leads:assign", { lead_ids: [RND] }],
    ["POST", "/api/v1/leads/bulk-delete", "leads:delete", { ids: [RND] }],
    ["POST", "/api/v1/leads/apollo-search", "leads:import", {}],
    ["POST", "/api/v1/campaigns", "campaigns:write", {}],
    ["POST", `/api/v1/campaigns/${RND}/send`, "campaigns:send", {}],
    ["POST", `/api/v1/campaigns/${RND}/pause`, "campaigns:send", {}],
    ["DELETE", `/api/v1/campaigns/${RND}`, "campaigns:delete", undefined],
    ["PATCH", `/api/v1/unibox/threads/${RND}/status`, "unibox:write", { interest_status: "interested" }],
    ...(cur ? [["PATCH", "/api/v1/settings", "settings:write", { client_industry: cur.value }]] : []), // same value: a broken guard changes nothing
    ["GET", "/api/v1/settings/keys", "keys:read"],
    ["GET", "/api/v1/settings/users", "team:read"],
    ["POST", "/api/v1/settings/users", "team:write", { email: "scopes-e2e-never@example.test", password: "x".repeat(12), full_name: "n", scopes: [] }],
    ["GET", "/api/v1/model-lab", "model_lab:read"],
    ["GET", "/api/v1/assistant/models", "assistant:admin"],
    ["GET", "/api/v1/settings/usage", "credits:read"],
  ];
  assert.ok(cur, "could not read Dev client_industry; settings PATCH case skipped");
  for (const [m, p, s, b] of cases) await t.test(`${m} ${p}`, () => forbid("READONLY", m, p, s, b));
});

test("1b EMP refused on manager-only things", async (t) => {
  const cases = [
    ["POST", "/api/v1/leads/bulk-assign", "leads:assign", { lead_ids: [RND] }],
    ["DELETE", `/api/v1/leads/${RND}`, "leads:delete"],
    ["GET", "/api/v1/organizations", "organizations:read"],
    ["GET", "/api/v1/prospects", "prospects:read"],
    ["GET", "/api/v1/model-lab", "model_lab:read"],
    ["GET", "/api/v1/settings/keys", "keys:read"],
    ["GET", "/api/v1/settings/users", "team:read"],
    ["GET", "/api/v1/dashboard/oversight", "dashboard:all"],
    ["POST", "/api/v1/unibox/sync", "unibox:all", {}],
    ["GET", `/api/v1/campaigns/${CAMP}/credits`, "credits:read"],
    ["GET", `/api/v1/campaigns/${CAMP}/llm-cost`, "credits:read"],
  ];
  for (const [m, p, s, b] of cases) await t.test(`${m} ${p}`, () => forbid("EMP", m, p, s, b));
});

// ── 2. Allowed ──
test("2a MGR reads manager pages", async (t) => {
  for (const p of ["/api/v1/organizations", "/api/v1/prospects", "/api/v1/model-lab", "/api/v1/settings/keys", "/api/v1/settings/users",
    "/api/v1/dashboard/oversight", `/api/v1/campaigns/${CAMP}/credits`, "/api/v1/settings/usage", "/api/v1/assistant/models"]) {
    await t.test(`GET ${p}`, () => allow("MGR", "GET", p));
  }
});
test("2b EMP reads its pages", async (t) => {
  for (const p of ["/api/v1/leads", "/api/v1/campaigns", "/api/v1/unibox/threads", "/api/v1/dashboard/analytics"]) {
    await t.test(`GET ${p}`, () => allow("EMP", "GET", p));
  }
});
test("2c EMP harmless writes on own lead: comment, field edit + restore; not on others", async () => {
  const own = S.leadOf.EMP, other = S.leadOf.MGR;
  const c = await allow("EMP", "POST", `/api/v1/leads/${own}/comments`, { body: "scopes-e2e comment" });
  assert.ok(c.body.data?.comment?.id);
  const orig = S.leads.find((l) => l.id === own).title;
  const e = await allow("EMP", "PATCH", `/api/v1/leads/${own}`, { title: "scopes-e2e title" });
  assert.equal(e.body.data.title, "scopes-e2e title");
  await allow("EMP", "PATCH", `/api/v1/leads/${own}`, { title: orig ?? "" });
  const x = await api(T.EMP, "PATCH", `/api/v1/leads/${other}`, { title: "nope" });
  assert.equal(x.status, 404, `EMP edit of MGR's lead: ${x.status}`);
  const y = await api(T.EMP, "POST", `/api/v1/leads/${other}/comments`, { body: "nope" });
  assert.ok([403, 404].includes(y.status), `EMP comment on MGR's lead: ${y.status}`);
  await forbid("EMP", "PATCH", `/api/v1/leads/${own}`, "leads:assign", { assigned_to: null });
});

// ── 3. Row reach ──
test("3a EMP's lead list holds only EMP's leads", async () => {
  const r = await allow("EMP", "GET", "/api/v1/leads");
  const rows = rowsOf(r.body.data);
  assert.ok(rows.length >= 1, `EMP sees ${rows.length} leads, expected its own one`);
  for (const l of rows) assert.equal(l.assigned_to, M.EMP.id, `lead ${l.id} assigned to ${l.assigned_to}`);
  assert.ok(rows.some((l) => l.id === S.leadOf.EMP));
});
test("3b MGR sees other owners' leads", async () => {
  const rows = rowsOf((await allow("MGR", "GET", "/api/v1/leads")).body.data);
  assert.ok(rows.some((l) => l.assigned_to !== M.MGR.id), "MGR saw only its own leads");
  // First page is newest-first (often all unassigned), so also ask for EMP's leads by filter.
  const emp = rowsOf((await allow("MGR", "GET", `/api/v1/leads?assigned_to=${M.EMP.id}`)).body.data);
  assert.ok(emp.some((l) => l.id === S.leadOf.EMP), "MGR cannot see EMP's lead");
  assert.ok(emp.every((l) => l.assigned_to === M.EMP.id), "assigned_to filter leaked other rows");
});
test("3c CUSTOM_ORG gets a foreign org but none of its leads; READONLY gets 404", async () => {
  const org = S.leads.find((l) => l.id === S.leadOf.EMP).organization_id;
  const r = await allow("CUSTOM_ORG", "GET", `/api/v1/organizations/${org}`);
  assert.equal(r.body.data.id, org);
  assert.deepEqual(r.body.data.leads.map((l) => l.id), [], "CUSTOM_ORG saw other people's leads in the org");
  const e = await allow("EMP", "GET", `/api/v1/organizations/${org}`);
  const { data: mine } = await db.from("leads").select("id").eq("organization_id", org).eq("assigned_to", M.EMP.id);
  assert.deepEqual(e.body.data.leads.map((l) => l.id).sort(), mine.map((l) => l.id).sort(), "EMP org leads != own leads");
  const ro = await api(T.READONLY, "GET", `/api/v1/organizations/${org}`);
  assert.equal(ro.status, 404, `READONLY on foreign org: ${ro.status}`);
});

// ── 7. Open routes (before READONLY is deactivated) ──
test("7 open routes for READONLY, health public", async (t) => {
  for (const p of ["/api/v1/me/settings", "/api/v1/settings", "/api/v1/apollo-credits"]) await t.test(p, () => allow("READONLY", "GET", p));
  await t.test("health no token", async () => assert.equal((await api(null, "GET", "/api/v1/health")).status, 200));
  await t.test("leads no token → 401", async () => assert.equal((await api(null, "GET", "/api/v1/leads")).status, 401));
});

// ── 4. Team rules ──
const newEmail = (tag) => `scopes-e2e-${tag}-${S.run}-${randomBytes(2).toString("hex")}@example.test`;
const pw = () => randomBytes(12).toString("base64url");
async function create(who, scopes, extra = {}) {
  const r = await api(T[who], "POST", "/api/v1/settings/users", { email: newEmail(who.toLowerCase()), password: pw(), full_name: `scopes-e2e by ${who}`, scopes, ...extra });
  if (r.status === 200 && r.body.data?.id) { S.extraUserIds.push(r.body.data.id); saveState(S); }
  return r;
}
let SENDER; // owner-made member holding sending_accounts:write
test("4a owner creates members with any scopes incl. team:write", async () => {
  const a = await create("OWNER", ["team:read", "team:write"]);
  assert.equal(a.status, 200, JSON.stringify(a.body).slice(0, 300));
  assert.deepEqual(a.body.data.scopes, ["team:read", "team:write"]);
  const b = await create("OWNER", ["sending_accounts:write"]);
  assert.equal(b.status, 200, JSON.stringify(b.body).slice(0, 300));
  SENDER = b.body.data.id;
});
test("4b MGR creates an Employee-template member", async () => {
  const r = await create("MGR", S.employee, { territory_countries: ["IN"] });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.deepEqual(r.body.data.scopes, S.employee);
});
test("4c MGR cannot give team:write", async () => {
  const r = await create("MGR", ["team:read", "team:write"]);
  assert.equal(r.status, 403, `status ${r.status}`);
});
test("4d MGR cannot edit a member holding team:write (TEAMLEAD)", async () => {
  const r = await api(T.MGR, "PATCH", `/api/v1/settings/users/${M.TEAMLEAD.id}`, { full_name: "scopes-e2e TEAMLEAD" });
  assert.equal(r.status, 403, `status ${r.status}`);
});
test("4e MGR cannot edit / reset password of a member with a scope MGR lacks", async () => {
  assert.ok(SENDER, "4a did not create SENDER");
  const a = await api(T.MGR, "PATCH", `/api/v1/settings/users/${SENDER}`, { full_name: "scopes-e2e by OWNER" });
  assert.equal(a.status, 403, `edit: ${a.status}`);
  const b = await api(T.MGR, "PATCH", `/api/v1/settings/users/${SENDER}`, { password: pw() });
  assert.equal(b.status, 403, `password: ${b.status}`);
});
test("4f MGR may edit EMP (harmless name change)", async () => {
  await allow("MGR", "PATCH", `/api/v1/settings/users/${M.EMP.id}`, { full_name: "scopes-e2e EMP" });
});
test("4g TEAMLEAD: cannot add leads:assign; cannot strip EMP; may add/remove a scope it holds", async () => {
  const add = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { scopes: ["leads:read", "leads:write", "leads:assign"] });
  assert.equal(add.status, 403, `add leads:assign: ${add.status}`);
  const strip = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.EMP.id}`, { scopes: S.employee.filter((s) => s !== "unibox:write") });
  assert.equal(strip.status, 403, `strip unibox:write from EMP: ${strip.status}`);
  const up = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { scopes: ["leads:read", "leads:write", "team:read"] });
  assert.equal(up.status, 200, `add team:read (held): ${up.status} ${msg(up)}`);
  const down = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { scopes: ["leads:read", "leads:write"] });
  assert.equal(down.status, 200, `remove team:read: ${down.status} ${msg(down)}`);
});
test("4h nobody changes own scopes", async () => {
  const a = await api(T.MGR, "PATCH", `/api/v1/settings/users/${M.MGR.id}`, { scopes: M.MGR.scopes.filter((s) => s !== "credits:read") });
  assert.equal(a.status, 403, `MGR self: ${a.status}`);
  const { data: o } = await db.from("profiles").select("scopes").eq("id", ownerId).single();
  const b = await api(T.OWNER, "PATCH", `/api/v1/settings/users/${ownerId}`, { scopes: ["leads:read"] });
  if (b.status === 200) await db.from("profiles").update({ scopes: o.scopes }).eq("id", ownerId);
  assert.equal(b.status, 403, `owner self: ${b.status}`);
});
test("4i nobody deactivates self (400) or the owner (400)", async () => {
  for (const [who, id] of [["MGR", M.MGR.id], ["OWNER", ownerId], ["MGR", ownerId], ["TEAMLEAD", ownerId]]) {
    const r = await api(T[who], "PATCH", `/api/v1/settings/users/${id}`, { is_active: false });
    if (r.status === 200) { await db.from("profiles").update({ is_active: true }).eq("id", id); await db.auth.admin.updateUserById(id, { ban_duration: "none" }); }
    assert.equal(r.status, 400, `${who} deactivate ${id === ownerId ? "owner" : "self"}: ${r.status} ${msg(r)}`);
  }
});
test("4j MGR cannot edit the owner row (403)", async () => {
  const { data: o } = await db.from("profiles").select("full_name").eq("id", ownerId).single();
  const r = await api(T.MGR, "PATCH", `/api/v1/settings/users/${ownerId}`, { full_name: o.full_name }); // same value: a broken guard changes nothing
  assert.equal(r.status, 403, `status ${r.status}`);
});
test("4k invalid scope string → 400", async () => {
  const a = await create("OWNER", ["foo:bar"]);
  assert.equal(a.status, 400, `create: ${a.status}`);
  const b = await api(T.OWNER, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { scopes: ["leads:read", "nope"] });
  assert.equal(b.status, 400, `patch: ${b.status}`);
});
test("4l deactivate with handover: manual needs leads:assign (403), pool needs only team:write (200)", async () => {
  // TEAMLEAD (no leads:assign) on TARGET (holds 1 lead, scopes ⊆ TEAMLEAD's).
  const manual = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { is_active: false, handover_strategy: "manual", reassign_to: M.EMP.id });
  assert.equal(manual.status, 403, `manual: ${manual.status} ${msg(manual)}`);
  assert.equal(msg(manual), need("leads:assign"));
  const pool = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { is_active: false, handover_strategy: "pool" });
  assert.equal(pool.status, 200, `pool: ${pool.status} ${msg(pool)}`);
  const back = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.TARGET.id}`, { is_active: true });
  assert.equal(back.status, 200, `reactivate: ${back.status} ${msg(back)}`);
});
test("4m brief case: TEAMLEAD deactivating EMP is refused even with pool (rule 4: EMP holds scopes TEAMLEAD lacks)", async () => {
  const manual = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.EMP.id}`, { is_active: false, handover_strategy: "manual", reassign_to: M.TARGET.id });
  const pool = await api(T.TEAMLEAD, "PATCH", `/api/v1/settings/users/${M.EMP.id}`, { is_active: false, handover_strategy: "pool" });
  if (pool.status === 200) {
    await api(T.OWNER, "PATCH", `/api/v1/settings/users/${M.EMP.id}`, { is_active: true });
    await db.from("leads").update({ assigned_to: M.EMP.id }).eq("id", S.leadOf.EMP);
  }
  assert.equal(manual.status, 403, `manual: ${manual.status}`);
  assert.equal(pool.status, 403, `pool: ${pool.status} ${msg(pool)}`);
});

// ── 6. Scope change takes effect ──
test("6 owner grants READONLY campaigns:read → 200 within 35 s", async () => {
  await forbid("READONLY", "GET", "/api/v1/campaigns", "campaigns:read");
  const r = await api(T.OWNER, "PATCH", `/api/v1/settings/users/${M.READONLY.id}`, { scopes: ["leads:read", "campaigns:read"] });
  assert.equal(r.status, 200, `grant: ${r.status} ${msg(r)}`);
  const t0 = Date.now();
  let s = 0;
  while (Date.now() - t0 < 35_000) {
    s = (await api(T.READONLY, "GET", "/api/v1/campaigns")).status;
    if (s === 200) break;
    await new Promise((res) => setTimeout(res, 2000));
  }
  assert.equal(s, 200, `still ${s} after 35 s`);
  console.log(`# scope change took ${Date.now() - t0} ms`);
});

// ── 5. Deactivated ──
test("5 owner deactivates READONLY → its token gets 401 everywhere", async () => {
  const r = await api(T.OWNER, "PATCH", `/api/v1/settings/users/${M.READONLY.id}`, { is_active: false });
  assert.equal(r.status, 200, `deactivate: ${r.status} ${msg(r)}`);
  for (const p of ["/api/v1/me/settings", "/api/v1/leads", "/api/v1/settings", "/api/v1/campaigns"]) {
    const x = await api(T.READONLY, "GET", p);
    assert.equal(x.status, 401, `${p}: ${x.status}`);
  }
});
