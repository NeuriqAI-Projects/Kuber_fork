// Creates throwaway members in the Dev company and assigns 3 Dev leads to them. Run teardown.mts after.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { admin, DEV, saveState, loadState } from "./lib.mts";

if (loadState()) throw new Error("state file exists: run teardown.mts first");

const src = readFileSync(new URL("../../lib/auth/scopes.ts", import.meta.url), "utf8");
const SCOPES = [...src.match(/export const SCOPES = \[([\s\S]*?)\] as const/)[1].matchAll(/"([a-z_]+:[a-z_]+)"/g)].map((m) => m[1]);
const EMPLOYEE = ["dashboard:read", "leads:read", "leads:write", "campaigns:read", "campaigns:write", "campaigns:generate", "campaigns:send", "campaigns:delete", "unibox:read", "unibox:reply", "unibox:write", "assistant:use", "assistant:actions", "knowledge:write"];
const ordered = (list) => SCOPES.filter((s) => list.includes(s));
const MEMBERS = {
  EMP: ordered(EMPLOYEE),
  MGR: SCOPES.filter((s) => s !== "sending_accounts:write"),
  READONLY: ["leads:read"],
  TEAMLEAD: ordered(["team:read", "team:write", "leads:read", "leads:write"]),
  CUSTOM_ORG: ordered(["leads:read", "organizations:read"]),
  TARGET: ordered(["leads:read", "leads:write"]),
};
const LEADS = ["352b131d-d5f9-467a-90fb-872fc65562e5", "6d7387a0-8c23-4b49-ae5d-52b84c2fc4ae", "1ccf8d4d-5369-4387-8ae4-220ed1fe3520"];
const LEAD_TO = ["EMP", "MGR", "TARGET"];

const db = admin();
const run = randomBytes(3).toString("hex");
const state = { startedAt: new Date().toISOString(), run, scopes: SCOPES, employee: MEMBERS.EMP, manager: MEMBERS.MGR, members: {}, leads: [], extraUserIds: [] };
saveState(state); // saved first so teardown can clean a half-finished setup

const { data: before, error: le } = await db.from("leads").select("id, company_id, assigned_to, assigned_at, updated_by, updated_at, title, organization_id").in("id", LEADS);
if (le || before.length !== 3 || before.some((l) => l.company_id !== DEV)) throw new Error("lead lookup failed / not Dev");
state.leads = before;
saveState(state);

for (const [role, scopes] of Object.entries(MEMBERS)) {
  const email = `scopes-e2e-${role.toLowerCase().replace("_", "")}-${run}@example.test`;
  const password = randomBytes(12).toString("base64url");
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(`createUser ${role}: ${error.message}`);
  state.members[role] = { id: data.user.id, email, password, scopes };
  saveState(state);
  const leadOwner = scopes.includes("leads:read") && !scopes.includes("leads:all");
  const { error: pe } = await db.from("profiles").insert({
    id: data.user.id, company_id: DEV, email, full_name: `scopes-e2e ${role}`, is_active: true, is_owner: false,
    scopes, territory_countries: leadOwner ? ["IN"] : [],
  });
  if (pe) throw new Error(`profile ${role}: ${pe.message}`);
}

for (let i = 0; i < 3; i++) {
  const { error } = await db.from("leads").update({ assigned_to: state.members[LEAD_TO[i]].id }).eq("id", LEADS[i]).eq("company_id", DEV);
  if (error) throw new Error(`assign lead: ${error.message}`);
}
state.leadOf = { EMP: LEADS[0], MGR: LEADS[1], TARGET: LEADS[2] };
saveState(state);
console.log("setup ok", Object.fromEntries(Object.entries(state.members).map(([k, v]) => [k, v.scopes.length])));
