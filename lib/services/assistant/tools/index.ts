import { can, type Scope } from "@/lib/auth/scopes";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import { leadTools } from "@/lib/services/assistant/tools/leads";
import { organizationTools } from "@/lib/services/assistant/tools/organizations";
import { campaignTools } from "@/lib/services/assistant/tools/campaigns";
import { inboxTools } from "@/lib/services/assistant/tools/inbox";
import { overviewTools } from "@/lib/services/assistant/tools/overview";
import { actionTools } from "@/lib/services/assistant/tools/actions";

function allTools(caller: AssistantCaller) {
  return {
    ...overviewTools(caller),
    ...leadTools(caller),
    ...organizationTools(caller),
    ...campaignTools(caller),
    ...inboxTools(caller),
    ...actionTools(caller),
  };
}

export type AssistantTools = ReturnType<typeof allTools>;
type ToolName = keyof AssistantTools;


/**
 * The scopes each tool needs (every one of them). Typed over every tool name, so
 * a new tool does not compile until it declares its scopes here. Sub-parts that
 * need more (reply text → unibox:read, spend per person → assistant:admin, the
 * company-wide view → an :all scope) are cut inside the tool. A propose_* tool
 * also needs assistant:actions plus the scope of the route its confirm calls.
 */
export const TOOL_SCOPES: Record<ToolName, Scope[]> = {
  pipeline_overview: ["dashboard:read"],
  team_overview: ["dashboard:all"],
  recent_activity: ["leads:read"],
  drafts_overview: ["campaigns:read"],
  usage_and_credits: ["credits:read"],
  search_leads: ["leads:read"],
  lead_breakdown: ["leads:read"],
  get_lead: ["leads:read"],
  search_organizations: ["leads:read"],
  get_organization: ["leads:read"],
  list_campaigns: ["campaigns:read"],
  get_campaign: ["campaigns:read"],
  search_inbox: ["unibox:read"],
  get_thread: ["unibox:read"],
  propose_create_campaign: ["assistant:actions", "campaigns:write"],
  propose_add_to_campaign: ["assistant:actions", "campaigns:write"],
  propose_assign_leads: ["assistant:actions", "leads:assign"],
  // Pause/resume need campaigns:send, generate_drafts campaigns:generate: the tool
  // is offered with either and checks the one its action needs.
  propose_campaign_state: ["assistant:actions"],
  propose_reveal_emails: ["assistant:actions", "leads:import"],
  propose_lead_note: ["assistant:actions", "leads:write"],
  propose_reply_draft: ["assistant:actions", "unibox:reply"],
};

function toolAllowed(caller: AssistantCaller, name: ToolName): boolean {
  if (!can(caller, ...TOOL_SCOPES[name])) return false;
  if (name === "propose_campaign_state") return can(caller, "campaigns:send") || can(caller, "campaigns:generate");
  return true;
}

/**
 * The tools this caller may use, bound to them. Built per request: each closure
 * captures that user's scoped database client and scopes, so a tool can only
 * ever see what the user can see in the app. Tools they lack a scope for are
 * left out (the model never sees them); each tool also re-checks inside.
 *
 * Key order is part of the prompt (tools render before the system prompt), so
 * tools are only ever filtered, never reordered — each scope combination keeps
 * its own warm prompt cache.
 */
export function buildAssistantTools(caller: AssistantCaller): Partial<AssistantTools> {
  const all = allTools(caller);
  const out: Partial<AssistantTools> = {};
  for (const name of Object.keys(all) as ToolName[]) {
    if (toolAllowed(caller, name)) (out as Record<ToolName, unknown>)[name] = all[name];
  }
  return out;
}
