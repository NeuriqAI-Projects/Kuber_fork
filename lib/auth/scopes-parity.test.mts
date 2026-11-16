/**
 * npx tsx --test lib/auth/scopes-parity.test.mts
 *
 * Why this exists: the Manager / Employee templates (lib/auth/scope-areas.ts) replace the old
 * roles, and the migration gives every existing member one of them. If a template is edited
 * (or a scope is moved), someone silently gains or loses access on deploy day. This pins every
 * audited route handler, AI tool and gated UI item (docs/notes/scopes-audit/*.md) to who could
 * do it BEFORE scopes:
 *   oldAccess "any"     (requireAuth, no employee restriction) → Manager AND Employee hold it
 *   oldAccess "manager" (requireManager / manager-only branch)  → Manager only
 *   oldAccess "super"   (requireSuperAdmin / isSuperAdmin only) → neither template (owner only)
 * Reach rows: an employee-sees-own-rows branch is the read scope ("any") plus the `:all`
 * scope ("manager").
 * Rows changed ON PURPOSE by plan §7 A / B / C carry `changed` and a reason, and are asserted
 * the NEW way: Manager holds the scope, Employee does not.
 * Open / public / secret routes have no scope and are covered by access-wiring.test.mts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCOPES, type Scope } from "./scopes.ts";
import { SCOPE_TEMPLATES } from "./scope-areas.ts";

type Row = { what: string; oldAccess: "any" | "manager" | "super"; scope: Scope; changed?: "A" | "B" | "C"; why?: string };

const A = "plan §7 A: campaign-wide action on a campaign shared with a teammate's leads needs campaigns:all";

const ROWS: Row[] = [
  // ── audit-leads.md ──
  { what: "GET /leads", oldAccess: "any", scope: "leads:read" },
  { what: "GET /leads (every lead, not own)", oldAccess: "manager", scope: "leads:all" },
  { what: "POST /leads (manual add, spends Firecrawl)", oldAccess: "manager", scope: "imports:manual" },
  { what: "POST /leads with assigned_to", oldAccess: "manager", scope: "leads:assign" },
  { what: "GET /leads/count", oldAccess: "any", scope: "leads:read" },
  { what: "GET /leads/hot-count", oldAccess: "any", scope: "leads:read" },
  { what: "GET /leads/[id]", oldAccess: "any", scope: "leads:read" },
  { what: "PATCH /leads/[id]", oldAccess: "any", scope: "leads:write" },
  { what: "PATCH /leads/[id] assigned_to", oldAccess: "manager", scope: "leads:assign" },
  { what: "DELETE /leads/[id]", oldAccess: "manager", scope: "leads:delete" },
  { what: "POST /leads/bulk-assign", oldAccess: "manager", scope: "leads:assign" },
  { what: "POST /leads/bulk-delete", oldAccess: "manager", scope: "leads:delete" },
  { what: "POST /leads/apollo-search", oldAccess: "manager", scope: "imports:apollo" },
  { what: "POST /leads/company-search", oldAccess: "manager", scope: "imports:company" },
  { what: "POST /leads/company-people", oldAccess: "manager", scope: "imports:company" },
  { what: "POST /leads/company-import", oldAccess: "manager", scope: "imports:company" },
  { what: "POST /leads/enrich (reveal, from Apollo search)", oldAccess: "manager", scope: "imports:apollo" },
  { what: "POST /leads/enrich (reveal, from Company lookup)", oldAccess: "manager", scope: "imports:company" },
  { what: "POST /leads/import-excel", oldAccess: "manager", scope: "imports:excel" },
  { what: "GET /leads/[id]/activity", oldAccess: "any", scope: "leads:read" },
  { what: "GET /leads/[id]/comments", oldAccess: "any", scope: "leads:read" },
  { what: "POST /leads/[id]/comments", oldAccess: "any", scope: "leads:write" },
  { what: "POST /leads/[id]/comments/[cid]/reactions", oldAccess: "any", scope: "leads:write" },
  { what: "GET /organizations", oldAccess: "manager", scope: "organizations:read" },
  { what: "POST /organizations", oldAccess: "manager", scope: "organizations:write" },
  { what: "GET /organizations/[id] (via own leads)", oldAccess: "any", scope: "leads:read" },
  { what: "GET /organizations/[id] (any org)", oldAccess: "manager", scope: "organizations:read" },
  { what: "GET /organizations/[id] scored block", oldAccess: "manager", scope: "prospects:read" },
  { what: "GET /organizations/[id] co-workers' leads in the list", oldAccess: "any", scope: "leads:all", changed: "B", why: "plan §7 B: org detail leaked teammates' leads to employees" },
  { what: "PATCH /organizations/[id]", oldAccess: "manager", scope: "organizations:write" },
  { what: "POST /organizations/[id]/rescrape", oldAccess: "manager", scope: "organizations:write" },
  { what: "GET /prospects", oldAccess: "manager", scope: "prospects:read" },
  { what: "POST /prospects/search", oldAccess: "manager", scope: "prospects:run" },
  { what: "POST /prospects/estimate", oldAccess: "manager", scope: "prospects:read" },
  { what: "POST /prospects/run", oldAccess: "manager", scope: "prospects:run" },
  { what: "POST /prospects/decide", oldAccess: "manager", scope: "prospects:run" },
  { what: "POST /prospects/[id]", oldAccess: "manager", scope: "prospects:run" },
  { what: "GET /imports", oldAccess: "any", scope: "leads:read" },
  { what: "GET /dashboard/analytics", oldAccess: "any", scope: "dashboard:read" },
  { what: "GET /dashboard/analytics (company numbers)", oldAccess: "manager", scope: "dashboard:all" },
  { what: "GET /dashboard/oversight", oldAccess: "manager", scope: "dashboard:all" },
  { what: "POST /ai-readiness (campaign create check)", oldAccess: "any", scope: "campaigns:write" },
  { what: "POST /enrich/retry", oldAccess: "any", scope: "organizations:write", changed: "B", why: "plan §7 B: any member could requeue any org and spend Firecrawl; its twin rescrape is manager-only" },
  { what: "GET /enrich/status (own leads' org)", oldAccess: "any", scope: "leads:read" },
  { what: "GET /enrich/status (any org)", oldAccess: "any", scope: "organizations:read", changed: "B", why: "plan §7 B: no ownership check, any member read any org" },
  { what: "POST /enrich/retry-all", oldAccess: "manager", scope: "organizations:write" },

  // ── audit-campaigns.md ──
  { what: "#1 GET /campaigns", oldAccess: "any", scope: "campaigns:read" },
  { what: "#1 GET /campaigns (every campaign)", oldAccess: "manager", scope: "campaigns:all" },
  { what: "#2 POST /campaigns", oldAccess: "any", scope: "campaigns:write" },
  { what: "#3 POST /campaigns/attachment", oldAccess: "any", scope: "campaigns:write" },
  { what: "#5 GET /campaigns/[id]", oldAccess: "any", scope: "campaigns:read" },
  { what: "#6 DELETE /campaigns/[id]", oldAccess: "any", scope: "campaigns:delete" },
  { what: "#6 DELETE a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#7 PATCH /campaigns/[id]", oldAccess: "any", scope: "campaigns:write" },
  { what: "#7 PATCH a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#8 POST /campaigns/[id]/assign", oldAccess: "manager", scope: "campaigns:assign" },
  { what: "#8 assign with reassign_leads", oldAccess: "manager", scope: "leads:assign" },
  { what: "#9 GET /campaigns/[id]/comments", oldAccess: "any", scope: "campaigns:read" },
  { what: "#10 POST /campaigns/[id]/comments", oldAccess: "any", scope: "campaigns:write" },
  { what: "#11 POST comment reactions", oldAccess: "any", scope: "campaigns:write" },
  { what: "#12 PATCH /campaigns/[id]/config (sole owner)", oldAccess: "any", scope: "campaigns:write" },
  { what: "#12 PATCH config on a shared campaign", oldAccess: "manager", scope: "campaigns:all" },
  { what: "#13 GET /campaigns/[id]/credits", oldAccess: "any", scope: "credits:read", changed: "C", why: "plan §7 C: campaign spend is credits:read; the employee tab was already hidden in the UI" },
  { what: "#14 GET /campaigns/[id]/draft-progress", oldAccess: "any", scope: "campaigns:read" },
  { what: "#15 POST followup-regenerate", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#15 followup-regenerate on a teammate's lead", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: no lead-owner check" },
  { what: "#16 POST followup-save", oldAccess: "any", scope: "campaigns:write" },
  { what: "#16 followup-save on a teammate's lead", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: no lead-owner check" },
  { what: "#17 POST followup-step-regenerate", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#18 POST generate-drafts/kick", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#19 POST generate-drafts", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#19 generate-drafts on a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#20 POST hold (stays open: emergency brake)", oldAccess: "any", scope: "campaigns:send" },
  { what: "#21 POST leads/remove", oldAccess: "any", scope: "campaigns:write" },
  { what: "#22 GET /campaigns/[id]/leads", oldAccess: "any", scope: "campaigns:read" },
  { what: "#23 POST /campaigns/[id]/leads", oldAccess: "any", scope: "campaigns:write" },
  { what: "#24 PATCH /campaigns/[id]/leads (kanban)", oldAccess: "any", scope: "campaigns:write" },
  { what: "#24 kanban status on a teammate's lead", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: no lead-owner check" },
  { what: "#25 GET /campaigns/[id]/llm-cost", oldAccess: "any", scope: "credits:read", changed: "C", why: "plan §7 C: campaign AI cost is credits:read; the employee tab was already hidden in the UI" },
  { what: "#26 POST pause", oldAccess: "any", scope: "campaigns:send" },
  { what: "#26 pause a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#27 POST regenerate-drafts", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#28 GET regenerate-drafts (preview)", oldAccess: "any", scope: "campaigns:read" },
  { what: "#29 POST regeneration-job/cancel", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#29 cancel regeneration on a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#30 POST regeneration-job/kick", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#31 GET regeneration-job", oldAccess: "any", scope: "campaigns:read" },
  { what: "#32 GET /campaigns/[id]/replies", oldAccess: "any", scope: "campaigns:read" },
  { what: "#32 replies: teammates' threads", oldAccess: "any", scope: "unibox:all", changed: "B", why: "plan §7 B: leaked teammates' reply threads" },
  { what: "#33 GET report", oldAccess: "any", scope: "campaigns:read" },
  { what: "#34 POST resume", oldAccess: "any", scope: "campaigns:send" },
  { what: "#34 resume a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#35 POST send", oldAccess: "any", scope: "campaigns:send" },
  { what: "#36 GET steps", oldAccess: "any", scope: "campaigns:read" },
  { what: "#37 PUT steps (sole owner)", oldAccess: "any", scope: "campaigns:write" },
  { what: "#37 PUT steps on a shared campaign", oldAccess: "manager", scope: "campaigns:all" },
  { what: "#38 POST sync-replies", oldAccess: "any", scope: "campaigns:write" },
  { what: "#38 sync-replies on a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#39 POST use-default-drafts", oldAccess: "any", scope: "campaigns:write" },
  { what: "#39 default drafts on a shared campaign", oldAccess: "any", scope: "campaigns:all", changed: "A", why: A },
  { what: "#40 POST campaign-leads/[id]/attachment", oldAccess: "any", scope: "campaigns:write" },
  { what: "#41 DELETE campaign-leads/[id]/attachment", oldAccess: "any", scope: "campaigns:write" },
  { what: "#40/41 attachment on a teammate's lead", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: no lead-owner check" },
  { what: "#42 POST campaign-leads/[id]/replace", oldAccess: "any", scope: "campaigns:write" },
  { what: "#42 replace edits the lead row", oldAccess: "any", scope: "leads:write" },
  { what: "#43 POST drafts/bulk-approve", oldAccess: "any", scope: "campaigns:send" },
  { what: "#43 bulk-approve a teammate's drafts", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: bulk-approve certified teammates' drafts" },
  { what: "#44 GET /drafts", oldAccess: "any", scope: "campaigns:read" },
  { what: "#44 GET /drafts: teammates' drafts", oldAccess: "any", scope: "campaigns:all", changed: "B", why: "plan §7 B: showed teammates' drafts" },
  { what: "#46 GET drafts/[id]/history", oldAccess: "any", scope: "campaigns:read" },
  { what: "#47 POST drafts/[id]/regenerate", oldAccess: "any", scope: "campaigns:generate" },
  { what: "#48 PATCH drafts/[id] approve", oldAccess: "any", scope: "campaigns:send" },
  { what: "#48 PATCH drafts/[id] edit/reject/reopen/restore", oldAccess: "any", scope: "campaigns:write" },
  { what: "#49 GET drafts/[id]/siblings", oldAccess: "any", scope: "campaigns:read" },
  { what: "#50 POST reply-drafts/generate", oldAccess: "any", scope: "unibox:reply" },
  { what: "#51 POST reply-drafts/[id]/regenerate", oldAccess: "any", scope: "unibox:reply" },
  { what: "#52 GET reply-drafts/[id]", oldAccess: "any", scope: "unibox:read" },
  { what: "#53 PATCH reply-drafts/[id] edit/reject", oldAccess: "any", scope: "unibox:write" },
  { what: "#53 PATCH reply-drafts/[id] approve", oldAccess: "any", scope: "unibox:reply" },
  { what: "#54 POST reply-drafts/[id]/send", oldAccess: "any", scope: "unibox:reply" },
  { what: "#55 POST unibox/reply", oldAccess: "any", scope: "unibox:reply" },
  { what: "#56 POST unibox/sync (user token; secret branch is outside scopes)", oldAccess: "any", scope: "unibox:all", changed: "B", why: "plan §7 B: any member could run a cross-company sync" },
  { what: "#65 GET reply-mailing-list (own rows, reply box only)", oldAccess: "any", scope: "unibox:reply" },
  { what: "#58 GET unibox/threads", oldAccess: "any", scope: "unibox:read" },
  { what: "#58 GET unibox/threads (every thread)", oldAccess: "manager", scope: "unibox:all" },
  { what: "#59 POST threads/[tid]/add-lead", oldAccess: "manager", scope: "imports:manual" },
  { what: "#60 POST threads/[tid]/read", oldAccess: "any", scope: "unibox:read" },
  { what: "#61 GET threads/[tid]", oldAccess: "any", scope: "unibox:read" },
  { what: "#62 PATCH threads/[tid]/status", oldAccess: "any", scope: "unibox:write" },
  { what: "#63 POST threads/[tid]/unread", oldAccess: "any", scope: "unibox:read" },
  { what: "#64 GET unibox/unread-count", oldAccess: "any", scope: "unibox:read" },

  // ── audit-settings-ai.md: routes ──
  { what: "PATCH /settings knowledge keys", oldAccess: "any", scope: "knowledge:write" },
  { what: "PATCH /settings company keys", oldAccess: "manager", scope: "settings:write" },
  { what: "GET /settings/usage", oldAccess: "manager", scope: "credits:read" },
  { what: "exact credits left (settings/usage, keys/usage/*, AI tool)", oldAccess: "super", scope: "credits:read", changed: "C", why: "plan §7 C: the super-admin trim already leaked to managers; credits:read shows exact numbers" },
  { what: "POST /settings/logo", oldAccess: "manager", scope: "settings:write" },
  { what: "DELETE /settings/logo", oldAccess: "manager", scope: "settings:write" },
  { what: "GET /settings/assignment", oldAccess: "manager", scope: "settings:write" },
  { what: "PATCH /settings/assignment", oldAccess: "manager", scope: "settings:write" },
  { what: "POST /settings/industry-keywords", oldAccess: "any", scope: "knowledge:write" },
  { what: "GET /settings/users", oldAccess: "manager", scope: "team:read" },
  { what: "POST /settings/users", oldAccess: "manager", scope: "team:write" },
  { what: "PATCH /settings/users/[id]", oldAccess: "manager", scope: "team:write" },
  { what: "GET /settings/keys", oldAccess: "manager", scope: "keys:read" },
  { what: "POST /settings/keys", oldAccess: "manager", scope: "keys:write" },
  { what: "PATCH /settings/keys/[id]", oldAccess: "manager", scope: "keys:write" },
  { what: "DELETE /settings/keys/[id]", oldAccess: "manager", scope: "keys:write" },
  { what: "POST /settings/keys/[id]/check", oldAccess: "manager", scope: "keys:write" },
  { what: "PUT /settings/keys/model", oldAccess: "manager", scope: "keys:write" },
  { what: "GET /settings/keys/models", oldAccess: "manager", scope: "keys:read" },
  { what: "PUT /settings/keys/reorder", oldAccess: "manager", scope: "keys:write" },
  { what: "PUT /settings/keys/tier", oldAccess: "manager", scope: "keys:write" },
  { what: "GET /settings/keys/sending-accounts", oldAccess: "manager", scope: "keys:read" },
  { what: "PUT /settings/keys/sending-accounts", oldAccess: "super", scope: "sending_accounts:write" },
  { what: "GET /settings/keys/usage/ai", oldAccess: "manager", scope: "credits:read" },
  { what: "GET /settings/keys/usage/apollo", oldAccess: "manager", scope: "credits:read" },
  { what: "PATCH /settings/keys/usage/apollo (plan §7 D: stays keys:write)", oldAccess: "manager", scope: "keys:write" },
  { what: "GET /settings/keys/usage/firecrawl", oldAccess: "manager", scope: "credits:read" },
  { what: "GET /settings/keys/usage/instantly", oldAccess: "manager", scope: "credits:read" },
  { what: "GET /settings/keys/usage/jev", oldAccess: "manager", scope: "credits:read" },
  { what: "GET /settings/keys/usage/tavily", oldAccess: "manager", scope: "credits:read" },
  { what: "POST /assistant/chat", oldAccess: "any", scope: "assistant:use" },
  { what: "POST /assistant/actions", oldAccess: "any", scope: "assistant:actions" },
  { what: "GET /assistant/models", oldAccess: "manager", scope: "assistant:admin" },
  { what: "PUT /assistant/models", oldAccess: "manager", scope: "assistant:admin" },
  { what: "GET /assistant/overview", oldAccess: "any", scope: "dashboard:read" },
  { what: "GET /assistant/usage", oldAccess: "manager", scope: "assistant:admin" },
  { what: "GET /model-lab", oldAccess: "manager", scope: "model_lab:read" },
  { what: "PUT /model-lab", oldAccess: "manager", scope: "model_lab:write" },
  { what: "POST /model-lab/generate", oldAccess: "manager", scope: "model_lab:write" },
  { what: "GET /model-lab/generate", oldAccess: "manager", scope: "model_lab:read" },
  { what: "POST /model-lab/prompt-sets", oldAccess: "manager", scope: "model_lab:write" },
  { what: "DELETE /model-lab/prompt-sets", oldAccess: "manager", scope: "model_lab:write" },
  { what: "POST /model-lab/vote", oldAccess: "manager", scope: "model_lab:write" },
  // requireAuth only, but a vote can only be cast through the manager-only POST, so only a
  // manager ever had one to delete.
  { what: "DELETE /model-lab/vote", oldAccess: "manager", scope: "model_lab:write" },

  // ── audit-settings-ai.md: Kuber AI tools ──
  { what: "tool pipeline_overview", oldAccess: "any", scope: "dashboard:read" },
  { what: "tool team_overview", oldAccess: "manager", scope: "dashboard:all" },
  { what: "tool recent_activity", oldAccess: "any", scope: "leads:read" },
  { what: "tool drafts_overview", oldAccess: "any", scope: "campaigns:read" },
  { what: "tool usage_and_credits (balances)", oldAccess: "manager", scope: "credits:read" },
  { what: "tool usage_and_credits (spend per person)", oldAccess: "manager", scope: "assistant:admin" },
  { what: "tool search_leads", oldAccess: "any", scope: "leads:read" },
  { what: "tool lead_breakdown", oldAccess: "any", scope: "leads:read" },
  { what: "tool get_lead", oldAccess: "any", scope: "leads:read" },
  { what: "tool search_organizations (via own leads)", oldAccess: "any", scope: "leads:read" },
  { what: "tool get_organization (via own leads)", oldAccess: "any", scope: "leads:read" },
  { what: "tool list_campaigns", oldAccess: "any", scope: "campaigns:read" },
  { what: "tool get_campaign", oldAccess: "any", scope: "campaigns:read" },
  { what: "tool search_inbox", oldAccess: "any", scope: "unibox:read" },
  { what: "tool get_thread", oldAccess: "any", scope: "unibox:read" },
  { what: "tool propose_* (confirm)", oldAccess: "any", scope: "assistant:actions" },
  { what: "tool propose_create_campaign", oldAccess: "any", scope: "campaigns:write" },
  { what: "tool propose_add_to_campaign", oldAccess: "any", scope: "campaigns:write" },
  { what: "tool propose_assign_leads", oldAccess: "manager", scope: "leads:assign" },
  { what: "tool propose_campaign_state (pause/resume)", oldAccess: "any", scope: "campaigns:send" },
  { what: "tool propose_campaign_state (generate drafts)", oldAccess: "any", scope: "campaigns:generate" },
  { what: "tool propose_reveal_emails", oldAccess: "manager", scope: "imports:apollo" },
  { what: "tool propose_lead_note", oldAccess: "any", scope: "leads:write" },
  { what: "tool propose_reply_draft", oldAccess: "any", scope: "unibox:reply" },

  // ── audit-ui.md: nav, settings sections, gated buttons ──
  { what: "nav Dashboard", oldAccess: "any", scope: "dashboard:read" },
  { what: "nav Unibox", oldAccess: "any", scope: "unibox:read" },
  { what: "nav Leads", oldAccess: "any", scope: "leads:read" },
  { what: "nav Campaigns", oldAccess: "any", scope: "campaigns:read" },
  { what: "nav Model Lab", oldAccess: "manager", scope: "model_lab:read" },
  { what: "nav Credits", oldAccess: "manager", scope: "credits:read" },
  { what: "settings ai: template / default / followup / html / replies / footer", oldAccess: "manager", scope: "settings:write" },
  { what: "settings knowledge: company details + logo", oldAccess: "manager", scope: "settings:write" },
  { what: "settings knowledge: products / industry segments", oldAccess: "any", scope: "knowledge:write" },
  { what: "settings team tab", oldAccess: "manager", scope: "team:read" },
  { what: "settings email & sending tab (see)", oldAccess: "manager", scope: "keys:read" },
  { what: "settings email & sending 'Use account'", oldAccess: "super", scope: "sending_accounts:write" },
  { what: "app-shell prospects badge", oldAccess: "manager", scope: "prospects:read" },
  { what: "app-shell org drawer 'Add lead'", oldAccess: "manager", scope: "imports:manual" },
  { what: "dashboard imports card", oldAccess: "manager", scope: "dashboard:all" },
  { what: "campaigns owner filter + column", oldAccess: "manager", scope: "campaigns:all" },
  { what: "leads 'Assign' button", oldAccess: "manager", scope: "leads:assign" },
  // Shown when the member holds ANY imports:* scope (useAccess().canImportAny).
  ...(["imports:apollo", "imports:company", "imports:excel", "imports:manual"] as const).map((scope): Row =>
    ({ what: `leads 'Add leads' button / leads/add page (${scope})`, oldAccess: "manager", scope })),
  { what: "leads bulk 'Delete (N)'", oldAccess: "manager", scope: "leads:delete" },
  { what: "leads kanban 'Retry all failed' (app/(app)/leads/page.tsx gates it on organizations:write)", oldAccess: "manager", scope: "organizations:write" },
  { what: "lead drawer Owner select", oldAccess: "manager", scope: "leads:assign" },
  { what: "lead drawer Retry / Enrich", oldAccess: "manager", scope: "organizations:write" },
  { what: "org drawer 'Edit' (API manager-only)", oldAccess: "manager", scope: "organizations:write" },
  { what: "unibox / outbox 'Add as lead' (API manager-only)", oldAccess: "manager", scope: "imports:manual" },
  { what: "campaign drawer Credits tab", oldAccess: "manager", scope: "credits:read" },
  { what: "create campaign 'Assign entire campaign to'", oldAccess: "manager", scope: "campaigns:assign" },
  { what: "credits page", oldAccess: "manager", scope: "credits:read" },
  { what: "assistant AI cost per answer", oldAccess: "manager", scope: "credits:read" },
  { what: "assistant skill 'Team workload'", oldAccess: "manager", scope: "dashboard:all" },
  { what: "assistant skill 'AI spend'", oldAccess: "manager", scope: "credits:read" },
  { what: "assistant skill 'Assign leads'", oldAccess: "manager", scope: "leads:assign" },
  { what: "assistant skill 'Reveal emails'", oldAccess: "manager", scope: "imports:apollo" },
  { what: "Credits > AI model picks", oldAccess: "manager", scope: "assistant:admin" },
  { what: "Credits > AI spend per person", oldAccess: "manager", scope: "assistant:admin" },
  { what: "add-leads drawer Apollo source", oldAccess: "manager", scope: "imports:apollo" },
  { what: "add-leads drawer Company source", oldAccess: "manager", scope: "imports:company" },
  { what: "add-leads drawer Excel source", oldAccess: "manager", scope: "imports:excel" },
  { what: "add-leads drawer Manual source", oldAccess: "manager", scope: "imports:manual" },
  { what: "add-leads drawer Scored companies source", oldAccess: "manager", scope: "prospects:run" },
  { what: "team view 'Add user'", oldAccess: "manager", scope: "team:write" },
  { what: "team view Deactivate / Reactivate employee", oldAccess: "manager", scope: "team:write" },
];

const tpl = (id: "manager" | "employee") => new Set<string>(SCOPE_TEMPLATES.find((t) => t.id === id)!.scopes);
const manager = tpl("manager");
const employee = tpl("employee");

test("every row names a real scope, and changed rows give a reason", () => {
  for (const r of ROWS) {
    assert.ok((SCOPES as readonly string[]).includes(r.scope), `${r.what}: unknown scope ${r.scope}`);
    if (r.changed) assert.ok(r.why, `${r.what}: changed row needs a reason`);
  }
});

test("Manager template holds the scope ⇔ a manager could do it before", () => {
  const bad = ROWS.filter((r) => manager.has(r.scope) !== (r.changed ? true : r.oldAccess !== "super"))
    .map((r) => `${r.what} → ${r.scope} (old: ${r.oldAccess}${r.changed ? `, changed ${r.changed}` : ""})`);
  assert.deepEqual(bad, [], `Manager template drift:\n  ${bad.join("\n  ")}`);
});

test("Employee template holds the scope ⇔ an employee could do it before", () => {
  const bad = ROWS.filter((r) => employee.has(r.scope) !== (r.changed ? false : r.oldAccess === "any"))
    .map((r) => `${r.what} → ${r.scope} (old: ${r.oldAccess}${r.changed ? `, changed ${r.changed}` : ""})`);
  assert.deepEqual(bad, [], `Employee template drift:\n  ${bad.join("\n  ")}`);
});

test("every scope is pinned by at least one row (a new scope needs a parity row)", () => {
  const covered = new Set(ROWS.map((r) => r.scope));
  assert.deepEqual(SCOPES.filter((s) => !covered.has(s)), []);
});
