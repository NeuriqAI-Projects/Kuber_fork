/**
 * npx tsx --test lib/auth/scopes.test.mts
 *
 * Spec tests for the per-member scopes core (docs/notes/scopes-plan.md §2, §3, §4, §5).
 * Expected values come from the plan, not from the implementation.
 *
 * Why: scopes decide who may read, change, send and spend in a live multi-tenant app.
 * This suite catches the bug classes that are silent in the UI:
 *  - a write guarded by a read scope (write implying read or read implying write),
 *  - escalation through Settings → Team (a manager granting what they lack, editing a
 *    peer manager or the owner, handing out team:write, editing their own scopes),
 *  - a template that silently changes someone's access (Manager / Employee drifting
 *    from the parity sets in §5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPES, isScope, parseScopes, memberScopes, hasScope, can, canSeeAll, isLeadOwner,
  canManage, canGrant, type Member, type Scope,
} from "./scopes.ts";
import { SCOPE_AREAS, SCOPE_TEMPLATES, scopeLabel, templateName } from "./scope-areas.ts";

// ── fixtures ──────────────────────────────────────────────────────────────
const SPEC_SCOPES = [
  "dashboard:read", "dashboard:all",
  "leads:read", "leads:all", "leads:write", "leads:assign", "leads:delete", "leads:import",
  "organizations:read", "organizations:write",
  "prospects:read", "prospects:run",
  "campaigns:read", "campaigns:all", "campaigns:write", "campaigns:generate", "campaigns:assign", "campaigns:send", "campaigns:delete",
  "unibox:read", "unibox:all", "unibox:reply", "unibox:write",
  "model_lab:read", "model_lab:write",
  "credits:read",
  "assistant:use", "assistant:actions", "assistant:admin",
  "settings:write",
  "knowledge:write",
  "keys:read", "keys:write", "sending_accounts:write",
  "team:read", "team:write",
];
const SPEC_EMPLOYEE = [
  "dashboard:read", "leads:read", "leads:write", "campaigns:read", "campaigns:write",
  "campaigns:generate", "campaigns:send", "campaigns:delete", "unibox:read", "unibox:reply",
  "unibox:write", "assistant:use", "assistant:actions", "knowledge:write",
];
const SPEC_MANAGER = SPEC_SCOPES.filter((s) => s !== "sending_accounts:write");

let n = 0;
const member = (scopes: readonly string[], extra: Partial<Member> = {}): Member =>
  ({ id: `u${++n}`, isOwner: false, active: true, scopes, ...extra });
const owner = (scopes: readonly string[] = []) => member(scopes, { isOwner: true });
const sorted = (a: readonly string[]) => [...a].sort();
const inScopesOrder = (a: readonly string[]) =>
  a.every((s, i) => i === 0 || SCOPES.indexOf(s as Scope) > SCOPES.indexOf(a[i - 1] as Scope));

// ── §2 SCOPES ─────────────────────────────────────────────────────────────
test("SCOPES is exactly the 36 scopes of §2, in that order", () => {
  assert.deepEqual([...SCOPES], SPEC_SCOPES);
});

test("SCOPES has no duplicates and every scope is area:verb", () => {
  assert.equal(new Set(SCOPES).size, SCOPES.length);
  for (const s of SCOPES) assert.match(s, /^[a-z_]+:[a-z]+$/, s);
});

test("SCOPES are grouped: all scopes of one prefix are contiguous", () => {
  const seen = new Set<string>();
  let prev = "";
  for (const s of SCOPES) {
    const area = s.split(":")[0];
    if (area !== prev) {
      assert.ok(!seen.has(area), `${area} appears in two separate runs`);
      seen.add(area);
      prev = area;
    }
  }
});

// ── isScope / parseScopes ─────────────────────────────────────────────────
test("isScope accepts known scopes only", () => {
  for (const s of SCOPES) assert.equal(isScope(s), true);
  for (const v of ["leads:edit", "LEADS:READ", "leads", "", " leads:read", null, undefined, 1, {}, ["leads:read"]]) {
    assert.equal(isScope(v), false, JSON.stringify(v));
  }
});

test("parseScopes rejects unknown values", () => {
  assert.equal(parseScopes(["leads:read", "leads:edit"]).ok, false);
  assert.equal(parseScopes(["admin"]).ok, false);
  assert.equal(parseScopes([42]).ok, false);
});

test("parseScopes rejects a repeated value", () => {
  assert.equal(parseScopes(["leads:read", "leads:read"]).ok, false);
});

test("parseScopes returns SCOPES order whatever the input order; empty is ok", () => {
  const r = parseScopes(["team:write", "leads:write", "dashboard:read", "leads:read"]);
  assert.deepEqual(r, { ok: true, scopes: ["dashboard:read", "leads:read", "leads:write", "team:write"] });
  assert.deepEqual(parseScopes([...SCOPES].reverse()), { ok: true, scopes: [...SCOPES] });
  assert.deepEqual(parseScopes([]), { ok: true, scopes: [] });
});

// ── §3 memberScopes / hasScope ────────────────────────────────────────────
test("owner holds every scope whatever is stored", () => {
  for (const stored of [[], ["leads:read"], ["junk"]]) {
    const o = owner(stored);
    assert.deepEqual(memberScopes(o), [...SCOPES]);
    for (const s of SCOPES) assert.equal(hasScope(o, s), true, s);
  }
});

test("member holds exactly the ticked scopes, in SCOPES order", () => {
  const m = member(["unibox:reply", "leads:read"]);
  assert.deepEqual(memberScopes(m), ["leads:read", "unibox:reply"]);
  for (const s of SCOPES) assert.equal(hasScope(m, s), s === "leads:read" || s === "unibox:reply", s);
});

test("unknown stored values are ignored", () => {
  const m = member(["leads:read", "superadmin", "leads:edit", ""]);
  assert.deepEqual(memberScopes(m), ["leads:read"]);
});

test("deactivated member holds nothing, owner flag or not", () => {
  for (const m of [member([...SCOPES], { active: false }), owner([...SCOPES]), member(["leads:read"], { active: false })]) {
    if (m.isOwner) m.active = false;
    assert.deepEqual(memberScopes(m), []);
    for (const s of SCOPES) assert.equal(hasScope(m, s), false, s);
  }
});

test("write never implies read; read never implies write", () => {
  const w = member(["leads:write"]);
  assert.equal(hasScope(w, "leads:read"), false);
  assert.equal(hasScope(w, "leads:all"), false);
  const r = member(["leads:read"]);
  assert.equal(hasScope(r, "leads:write"), false);
  const t = member(["team:write"]);
  assert.equal(hasScope(t, "team:read"), false);
  const k = member(["keys:read"]);
  assert.equal(hasScope(k, "keys:write"), false);
  const all = member(["leads:all"]);
  assert.equal(hasScope(all, "leads:read"), false);
});

// ── reach / §4 lead owners ────────────────────────────────────────────────
test("canSeeAll is true only with <area>:all", () => {
  for (const area of ["leads", "campaigns", "unibox", "dashboard"] as const) {
    assert.equal(canSeeAll(member([`${area}:all`]), area), true, area);
    const without = SPEC_SCOPES.filter((s) => s !== `${area}:all`);
    assert.equal(canSeeAll(member(without), area), false, area);
    assert.equal(canSeeAll(member([`${area}:all`], { active: false }), area), false, `${area} deactivated`);
  }
  assert.equal(canSeeAll(member(["leads:all"]), "campaigns"), false);
  assert.equal(canSeeAll(owner(), "leads"), true);
});

// §4 (edited 16 Nov): not owner + stored leads:read + not stored leads:all; ignores active like the old role column.
test("isLeadOwner = non-owner + stored leads:read + not leads:all (ignores active)", () => {
  assert.equal(isLeadOwner(member(["leads:read"])), true);
  assert.equal(isLeadOwner(member(SPEC_EMPLOYEE)), true);
  assert.equal(isLeadOwner(member(["leads:read", "leads:all"])), false);
  assert.equal(isLeadOwner(member(SPEC_MANAGER)), false);
  assert.equal(isLeadOwner(member(["leads:write"])), false);
  assert.equal(isLeadOwner(member([])), false);
  assert.equal(isLeadOwner(member(["leads:read"], { active: false })), true, "deactivated keeps lead-owner status");
  assert.equal(isLeadOwner(member(["leads:read", "leads:all"], { active: false })), false);
  assert.equal(isLeadOwner(member(["leads:read"], { isOwner: true, active: false })), false, "deactivated owner still not");
  assert.equal(isLeadOwner(owner()), false, "owner holds leads:all so is not a lead owner");
  assert.equal(isLeadOwner(owner(["leads:read"])), false);
});

// ── can ───────────────────────────────────────────────────────────────────
test("can needs every listed scope", () => {
  const caller = { scopes: ["leads:read", "leads:write"] as Scope[] };
  assert.equal(can(caller, "leads:read"), true);
  assert.equal(can(caller, "leads:read", "leads:write"), true);
  assert.equal(can(caller, "leads:read", "leads:delete"), false);
  assert.equal(can({ scopes: [] }, "leads:read"), false);
});

// ── §3 No escalation ──────────────────────────────────────────────────────
const ok = (v: { ok: boolean }, msg?: string) => assert.equal(v.ok, true, msg);
const no = (v: { ok: boolean }, msg?: string) => assert.equal(v.ok, false, msg);

test("rule 1: owner may grant anything to a non-owner, including team:write", () => {
  const o = owner();
  const emp = member(SPEC_EMPLOYEE);
  ok(canManage(o, emp));
  ok(canGrant(o, emp, [...SCOPES]));
  ok(canGrant(o, emp, ["team:write"]));
  ok(canGrant(o, emp, []));
  const mgr = member(SPEC_MANAGER);
  ok(canManage(o, mgr), "owner edits a team:write member");
  ok(canGrant(o, mgr, SPEC_EMPLOYEE as Scope[]), "owner strips a manager");
});

test("rule 3: nobody edits the owner", () => {
  const o = owner();
  const mgr = member(SPEC_MANAGER);
  const full = member([...SCOPES]);
  no(canManage(mgr, o));
  no(canManage(full, o));
  no(canGrant(mgr, o, []));
  no(canGrant(full, o, [...SCOPES]));
  no(canGrant(o, o, ["leads:read"]), "owner can't change own scopes either");
});

test("rule 3: nobody changes their own scopes", () => {
  const mgr = member(SPEC_MANAGER);
  no(canGrant(mgr, mgr, SPEC_MANAGER.filter((s) => s !== "leads:delete") as Scope[]), "remove own");
  const partial = member(["team:write", "leads:read"]);
  no(canGrant(partial, partial, ["team:write", "leads:read", "leads:write"].filter(isScope)), "add own (held? no) ");
  const holder = member(["team:write", "leads:read", "leads:write"]);
  no(canGrant(holder, holder, ["team:write", "leads:read"]), "drop a held scope from self");
});

test("rule 2: non-owner without team:write can't manage or grant", () => {
  const g = member(SPEC_MANAGER.filter((s) => s !== "team:write"));
  const emp = member(["leads:read"]);
  no(canManage(g, emp));
  no(canGrant(g, emp, ["leads:read", "leads:write"]));
  no(canGrant(g, emp, ["leads:read"]), "even an unchanged set");
  const teamRead = member(["team:read", "leads:read", "leads:write"]);
  no(canGrant(teamRead, emp, ["leads:read", "leads:write"]), "team:read is not team:write");
});

test("rule 4: non-owner can't touch a member who holds team:write", () => {
  const mgr = member(SPEC_MANAGER);
  const peer = member(SPEC_MANAGER);
  no(canManage(mgr, peer));
  no(canGrant(mgr, peer, SPEC_MANAGER as Scope[]), "unchanged");
  no(canGrant(mgr, peer, SPEC_EMPLOYEE as Scope[]), "demote peer");
  const weakPeer = member(["team:write"]);
  no(canManage(mgr, weakPeer));
  no(canGrant(mgr, weakPeer, []));
});

test("rule 6: only the owner gives team:write", () => {
  const mgr = member(SPEC_MANAGER);
  const emp = member(SPEC_EMPLOYEE);
  no(canGrant(mgr, emp, [...SPEC_EMPLOYEE, "team:write"].filter(isScope)));
  no(canGrant(mgr, emp, ["team:write"]));
  const full = member([...SCOPES]);
  no(canGrant(full, emp, [...SCOPES]));
});

test("rule 5: non-owner may only add or remove scopes they hold", () => {
  const mgr = member(SPEC_MANAGER); // lacks sending_accounts:write
  const emp = member(SPEC_EMPLOYEE);
  // add a held scope: ok
  ok(canManage(mgr, emp));
  ok(canGrant(mgr, emp, [...SPEC_EMPLOYEE, "leads:assign"].filter(isScope)), "add held");
  // remove a held scope: ok
  ok(canGrant(mgr, emp, SPEC_EMPLOYEE.filter((s) => s !== "campaigns:delete").filter(isScope)), "remove held");
  // add an unheld scope: refused
  no(canGrant(mgr, emp, [...SPEC_EMPLOYEE, "sending_accounts:write"].filter(isScope)), "add unheld");

  // narrow granter: team:write + leads:read + leads:write
  const g = member(["team:write", "leads:read", "leads:write"]);
  const t = member(["leads:read"]);
  ok(canGrant(g, t, ["leads:read", "leads:write"]), "add held");
  ok(canGrant(g, t, []), "remove held");
  ok(canGrant(g, t, ["leads:read"]), "unchanged set");
  no(canGrant(g, t, ["leads:read", "leads:delete"]), "add unheld (leads:delete)");
  // target holding a scope the granter lacks is refused outright (rule 4 subset, 16 Nov security review)
  const over = member(["leads:read", "leads:delete"]);
  no(canGrant(g, over, ["leads:read"]), "remove unheld (leads:delete)");
  no(canGrant(g, over, ["leads:delete"]), "remove held, unheld left as is: now refused");
  no(canGrant(g, over, ["leads:read", "leads:delete"]), "unchanged set: now refused");
  no(canGrant(g, over, ["leads:read", "leads:write", "leads:delete"]), "add held while unheld stays: now refused");
});

test("rule 4 subset: a non-owner manages only members whose stored scopes they all hold", () => {
  const g = member(["team:write", "leads:read", "leads:write"]);
  no(canManage(g, member(["leads:read", "leads:delete"])), "target holds leads:delete, granter lacks it");
  no(canManage(member(SPEC_MANAGER), member(["sending_accounts:write"])), "manager vs target with sending_accounts:write");
  no(canManage(member(["team:write"]), member(["team:read"])), "team:read is not held by granter");
  ok(canManage(g, member(["leads:read", "leads:write"])), "target equal to granter's non-team scopes");
  ok(canManage(g, member(["leads:read"])), "target strict subset");
  ok(canManage(g, member([])), "empty target");
  ok(canManage(member(SPEC_MANAGER), member(SPEC_EMPLOYEE)), "manager vs employee");
  ok(canManage(g, g), "self is still ok (non-scope fields)");
  ok(canManage(owner(), member([...SCOPES].filter((s) => s !== "team:write"))), "owner manages anyone non-owner");
  ok(canManage(owner(), member([...SCOPES])), "owner manages a full member");
});

test("rule 4 subset ignores unknown stored values on the target", () => {
  const g = member(["team:write", "leads:read", "leads:write"]);
  const t = member(["leads:read", "legacy:thing"]);
  ok(canManage(g, t));
  ok(canGrant(g, t, ["leads:read", "leads:write"]), "add held; junk dropped is not a change");
});

test("deactivated granter can do nothing, even the owner flag", () => {
  const emp = member(SPEC_EMPLOYEE);
  const mgr = member(SPEC_MANAGER, { active: false });
  no(canManage(mgr, emp));
  no(canGrant(mgr, emp, SPEC_EMPLOYEE as Scope[]));
  no(canGrant(mgr, emp, [...SPEC_EMPLOYEE, "leads:assign"].filter(isScope)));
  const deadOwner = member([], { isOwner: true, active: false });
  no(canManage(deadOwner, emp));
  no(canGrant(deadOwner, emp, ["leads:read"]));
});

// ── §5 templates + picker ─────────────────────────────────────────────────
const tpl = (id: "manager" | "employee") => SCOPE_TEMPLATES.find((t) => t.id === id)!;

test("Manager template = every scope except sending_accounts:write", () => {
  assert.deepEqual(tpl("manager").scopes, SPEC_MANAGER);
  assert.equal(tpl("manager").label, "Manager");
});

test("Employee template = exactly the 14 scopes of §5", () => {
  assert.equal(tpl("employee").scopes.length, 14);
  assert.deepEqual(sorted(tpl("employee").scopes), sorted(SPEC_EMPLOYEE));
  assert.equal(tpl("employee").label, "Employee");
});

test("templates are subsets of SCOPES in SCOPES order", () => {
  for (const t of SCOPE_TEMPLATES) {
    for (const s of t.scopes) assert.ok(isScope(s), s);
    assert.ok(inScopesOrder(t.scopes), t.id);
  }
});

test("SCOPE_AREAS lists every scope exactly once, in SCOPES order", () => {
  const flat = SCOPE_AREAS.flatMap((a) => a.options.map((o) => o.scope));
  assert.deepEqual(flat, [...SCOPES]);
});

test("scopeLabel: area · box label; unknown passes through", () => {
  assert.equal(scopeLabel("leads:write"), "Leads · Edit");
  assert.equal(scopeLabel("leads:all"), "Leads · See all");
  assert.equal(scopeLabel("nope:thing"), "nope:thing");
});

test("templateName: Manager / Employee on exact match, else Custom", () => {
  assert.equal(templateName(SPEC_MANAGER), "Manager");
  assert.equal(templateName([...SPEC_MANAGER].reverse()), "Manager");
  assert.equal(templateName(SPEC_EMPLOYEE), "Employee");
  assert.equal(templateName([...SPEC_EMPLOYEE].reverse()), "Employee");
  assert.equal(templateName([...SCOPES]), "Custom");
  assert.equal(templateName([...SPEC_EMPLOYEE, "leads:assign"]), "Custom");
  assert.equal(templateName(SPEC_EMPLOYEE.slice(1)), "Custom");
  assert.equal(templateName([]), "Custom");
});
