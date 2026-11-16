// Undo setup.mts + anything the tests created. Safe to run more than once.
import { admin, DEV, loadState, saveState, STATE } from "./lib.mts";
import { unlinkSync } from "node:fs";

const db = admin();
const state = loadState();
const problems = [];

// Every throwaway profile (setup + ones the API tests created), found by email.
const { data: profs } = await db.from("profiles").select("id, email, company_id").like("email", "scopes-e2e-%");
const ids = [...new Set([...(profs ?? []).map((p) => p.id), ...Object.values(state?.members ?? {}).map((m) => m.id), ...(state?.extraUserIds ?? [])])];
if ((profs ?? []).some((p) => p.company_id !== DEV)) problems.push("a scopes-e2e profile is outside Dev!");

if (state?.leads?.length) {
  for (const l of state.leads) {
    const { error } = await db.from("leads").update({
      assigned_to: l.assigned_to, assigned_at: l.assigned_at, updated_by: l.updated_by, updated_at: l.updated_at, title: l.title,
    }).eq("id", l.id).eq("company_id", DEV);
    if (error) problems.push(`restore lead ${l.id}: ${error.message}`);
  }
  const leadIds = state.leads.map((l) => l.id);
  const ev = await db.from("lead_events").delete({ count: "exact" }).in("lead_id", leadIds).gte("created_at", state.startedAt);
  if (ev.error) problems.push(`events: ${ev.error.message}`); else console.log("deleted lead_events", ev.count);
}
if (ids.length) {
  const c = await db.from("lead_comments").delete({ count: "exact" }).in("author_id", ids);
  if (c.error) problems.push(`comments: ${c.error.message}`); else console.log("deleted comments", c.count);
  const e2 = await db.from("lead_events").delete({ count: "exact" }).in("actor_id", ids);
  if (e2.error) problems.push(`events by actor: ${e2.error.message}`); else console.log("deleted actor events", e2.count);
  const p = await db.from("profiles").delete().in("id", ids);
  if (p.error) problems.push(`profiles: ${p.error.message}`);
  for (const id of ids) {
    const { error } = await db.auth.admin.deleteUser(id);
    if (error && !/not found/i.test(error.message)) problems.push(`auth ${id}: ${error.message}`);
  }
}

// Verify: no profiles and no auth users named scopes-e2e-% left.
const { count } = await db.from("profiles").select("id", { count: "exact", head: true }).like("email", "scopes-e2e-%");
let authLeft = 0;
for (let page = 1; page < 50; page++) {
  const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
  if (error) { problems.push(`listUsers: ${error.message}`); break; }
  authLeft += data.users.filter((u) => u.email?.startsWith("scopes-e2e-")).length;
  if (data.users.length < 1000) break;
}
if (state?.leads?.length) {
  const { data: now } = await db.from("leads").select("id, assigned_to, title").in("id", state.leads.map((l) => l.id));
  for (const l of state.leads) {
    const n = now?.find((x) => x.id === l.id);
    if (!n || n.assigned_to !== l.assigned_to || n.title !== l.title) problems.push(`lead ${l.id} not restored`);
  }
}
console.log(`left: profiles=${count} auth=${authLeft}`);
if (problems.length) { console.log("PROBLEMS:", problems); process.exitCode = 1; }
else if (state) unlinkSync(STATE);
