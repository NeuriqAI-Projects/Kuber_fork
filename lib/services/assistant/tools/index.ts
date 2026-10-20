import type { AssistantCaller } from "@/lib/services/assistant/context";
import { leadTools } from "@/lib/services/assistant/tools/leads";
import { organizationTools } from "@/lib/services/assistant/tools/organizations";
import { campaignTools } from "@/lib/services/assistant/tools/campaigns";
import { inboxTools } from "@/lib/services/assistant/tools/inbox";
import { overviewTools } from "@/lib/services/assistant/tools/overview";
import { actionTools } from "@/lib/services/assistant/tools/actions";

/**
 * Every tool the assistant has, bound to one caller. Built per request: each
 * closure captures that user's scoped database client and role, so a tool can
 * only ever see what the user can see in the app.
 *
 * Key order is part of the prompt (tools render before the system prompt), so
 * it stays fixed to keep the prompt cache warm across requests.
 */
export function buildAssistantTools(caller: AssistantCaller) {
  return {
    ...overviewTools(caller),
    ...leadTools(caller),
    ...organizationTools(caller),
    ...campaignTools(caller),
    ...inboxTools(caller),
    ...actionTools(caller),
  };
}

export type AssistantTools = ReturnType<typeof buildAssistantTools>;
