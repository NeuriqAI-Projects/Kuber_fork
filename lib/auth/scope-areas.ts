/** Picker labels and the two one-click templates for Settings → Team. Same order as SCOPES. */
import { SCOPES, type Scope } from "./scopes";

export interface ScopeOption { scope: Scope; label: string; description: string }
export interface ScopeArea { id: string; label: string; options: ScopeOption[] }

export const SCOPE_AREAS: ScopeArea[] = [
  { id: "dashboard", label: "Dashboard", options: [
    { scope: "dashboard:read", label: "See", description: "Open the dashboard with their own numbers" },
    { scope: "dashboard:all", label: "See all", description: "Company-wide numbers, team oversight and the imports card" },
  ] },
  { id: "leads", label: "Leads", options: [
    { scope: "leads:read", label: "See", description: "Open Leads and the leads assigned to them" },
    { scope: "leads:all", label: "See all", description: "See and work every lead in the company, not only their own" },
    { scope: "leads:write", label: "Edit", description: "Edit lead fields and status, comment" },
    { scope: "leads:assign", label: "Assign", description: "Assign and reassign leads to people" },
    { scope: "leads:delete", label: "Delete", description: "Delete leads" },
    { scope: "leads:import", label: "Import", description: "Find, import, add and enrich leads (spends Apollo / Firecrawl credits)" },
  ] },
  { id: "organizations", label: "Organizations", options: [
    { scope: "organizations:read", label: "See all", description: "Open the organizations list and any company, not only those of their leads" },
    { scope: "organizations:write", label: "Edit", description: "Edit companies and re-read their websites (spends Firecrawl credits)" },
  ] },
  { id: "prospects", label: "Scored companies", options: [
    { scope: "prospects:read", label: "See", description: "See scored companies and estimates" },
    { scope: "prospects:run", label: "Run", description: "Search, score, approve and decline companies (spends Apollo / Firecrawl / AI credits)" },
  ] },
  { id: "campaigns", label: "Campaigns", options: [
    { scope: "campaigns:read", label: "See", description: "Open campaigns that hold their leads (only their leads inside)" },
    { scope: "campaigns:all", label: "See all", description: "See every campaign and lead, and change campaigns shared with teammates" },
    { scope: "campaigns:write", label: "Edit", description: "Create campaigns, edit options, sequences and drafts, add or remove leads" },
    { scope: "campaigns:generate", label: "AI drafts", description: "Write and rewrite emails with AI (spends AI credits)" },
    { scope: "campaigns:assign", label: "Assign", description: "Give a campaign to a teammate" },
    { scope: "campaigns:send", label: "Send", description: "Approve drafts, send, pause, resume and hold (sends email)" },
    { scope: "campaigns:delete", label: "Delete", description: "Delete campaigns" },
  ] },
  { id: "unibox", label: "Unibox", options: [
    { scope: "unibox:read", label: "See", description: "Read replies on their own leads" },
    { scope: "unibox:all", label: "See all", description: "Read every reply in the company" },
    { scope: "unibox:reply", label: "Reply", description: "Send replies and AI reply drafts (sends email, spends AI credits)" },
    { scope: "unibox:write", label: "Edit", description: "Set a reply's interest status" },
  ] },
  { id: "model_lab", label: "Model Lab", options: [
    { scope: "model_lab:read", label: "See", description: "Open Model Lab and its results" },
    { scope: "model_lab:write", label: "Run", description: "Run models, vote and save prompt sets (spends AI credits)" },
  ] },
  { id: "credits", label: "Credits", options: [
    { scope: "credits:read", label: "See", description: "See credits, spend and AI cost" },
  ] },
  { id: "assistant", label: "Kuber AI", options: [
    { scope: "assistant:use", label: "Use", description: "Chat with Kuber AI (it only sees what they can see)" },
    { scope: "assistant:actions", label: "Actions", description: "Confirm Kuber AI actions (each also needs its own permission)" },
    { scope: "assistant:admin", label: "Admin", description: "Pick Kuber AI models and see AI spend per person" },
  ] },
  { id: "settings", label: "Company settings", options: [
    { scope: "settings:write", label: "Edit", description: "Company email templates, reply AI, company details, logo, assignment" },
  ] },
  { id: "knowledge", label: "Knowledge", options: [
    { scope: "knowledge:write", label: "Edit", description: "Edit product offerings and industry segments" },
  ] },
  { id: "keys", label: "API keys", options: [
    { scope: "keys:read", label: "See", description: "See API keys and provider usage" },
    { scope: "keys:write", label: "Edit", description: "Add, change and remove API keys, AI models and the Apollo allowance" },
    { scope: "sending_accounts:write", label: "Sender", description: "Pick the company's default sending mailbox" },
  ] },
  { id: "team", label: "Team", options: [
    { scope: "team:read", label: "See", description: "See the team list" },
    { scope: "team:write", label: "Manage", description: "Add people, reset passwords, turn access on or off and tick permissions they hold" },
  ] },
];

/** "Leads · Edit", for chips. Unknown values come back unchanged. */
export function scopeLabel(scope: string): string {
  for (const area of SCOPE_AREAS) {
    const o = area.options.find((x) => x.scope === scope);
    if (o) return `${area.label} · ${o.label}`;
  }
  return scope;
}

const EMPLOYEE: Scope[] = [
  "dashboard:read",
  "leads:read", "leads:write",
  "campaigns:read", "campaigns:write", "campaigns:generate", "campaigns:send", "campaigns:delete",
  "unibox:read", "unibox:reply", "unibox:write",
  "assistant:use", "assistant:actions",
  "knowledge:write",
];

/** One-click presets matching the old roles exactly (parity test). Only the ticked scopes are stored. */
export const SCOPE_TEMPLATES: { id: "manager" | "employee"; label: string; scopes: Scope[] }[] = [
  { id: "manager", label: "Manager", scopes: SCOPES.filter((s) => s !== "sending_accounts:write") },
  { id: "employee", label: "Employee", scopes: SCOPES.filter((s) => EMPLOYEE.includes(s)) },
];

/** Name of the template a scope set matches exactly, else "Custom". */
export function templateName(scopes: readonly string[]): string {
  const key = [...scopes].sort().join();
  return SCOPE_TEMPLATES.find((t) => [...t.scopes].sort().join() === key)?.label ?? "Custom";
}
