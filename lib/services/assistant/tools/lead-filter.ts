// One lead filter, shared by the search, breakdown and action tools, so "find
// these leads" and "put these leads in a campaign" can never disagree about
// which leads "these" are.
import { z } from "zod";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import { cleanSearch, ilikeValue, resolveAssignee, resolveCampaign } from "@/lib/services/assistant/tools/shared";

export const LEAD_STATUSES = ["new", "enriching", "enriched", "input_required", "open", "closed"] as const;
export const CAMPAIGN_LEAD_STATUSES = [
  "new", "enriching", "enriched", "draft", "draft_ready", "approved", "sent", "replied", "won", "closed", "skipped", "failed",
] as const;
export const TEMPERATURES = ["hot", "warm", "cold", "neutral", "ooo", "unsubscribed"] as const;

export const LeadFilterSchema = z.object({
  query: z.string().optional().describe("Words matched against first name, last name, email and job title. Every word must match one of them."),
  company: z.string().optional().describe("Company (organization) name contains this text."),
  industry: z.string().optional().describe("Company industry contains this text, e.g. 'plastics', 'packaging', 'pharma'."),
  country: z.string().optional().describe("Lead country, e.g. 'India', 'United States'."),
  city: z.string().optional(),
  status: z.array(z.enum(LEAD_STATUSES)).optional().describe("Lead pipeline status. 'enriched' and 'input_required' are the ones that can go into a campaign."),
  assigned_to: z.string().optional().describe("'me', 'unassigned', or a teammate's name/email/id."),
  campaign: z.string().optional().describe("Only leads inside this campaign (exact name, part of the name, or id)."),
  campaign_status: z.array(z.enum(CAMPAIGN_LEAD_STATUSES)).optional().describe("The lead's status inside a campaign (sent, replied, approved…). Uses `campaign` when given, else any campaign."),
  in_campaign: z.enum(["any", "none"]).optional().describe("'none' = not in any campaign yet. 'any' = in at least one campaign."),
  temperature: z.enum(TEMPERATURES).optional().describe("Reply temperature set on a campaign lead (hot = interested reply)."),
  has_email: z.boolean().optional().describe("true = only leads whose email is revealed."),
  source: z.enum(["apollo", "excel", "manual"]).optional(),
  created_after: z.string().optional().describe("ISO date (YYYY-MM-DD). Leads added on/after this day."),
  created_before: z.string().optional().describe("ISO date (YYYY-MM-DD). Leads added before this day."),
});

export type LeadFilter = z.infer<typeof LeadFilterSchema>;

/** What the filter resolved names to — echoed back so the user sees how "Ravi" was read. */
export type ResolvedLeadFilter = {
  assigneeId?: string | "unassigned";
  assigneeName?: string;
  campaignId?: string;
  campaignName?: string;
};

export async function resolveLeadFilter(
  caller: AssistantCaller,
  f: LeadFilter,
): Promise<ResolvedLeadFilter | { error: string }> {
  const out: ResolvedLeadFilter = {};
  if (f.assigned_to) {
    const a = await resolveAssignee(caller, f.assigned_to);
    if ("error" in a) return a;
    out.assigneeId = a.id;
    out.assigneeName = a.name;
  }
  if (f.campaign) {
    const c = await resolveCampaign(caller, f.campaign);
    if ("error" in c) return c;
    out.campaignId = c.id;
    out.campaignName = c.name;
  }
  return out;
}

type JoinMode = "none" | "anti" | "inner" | "display";

/** Which campaign_leads embed the filter needs. Pure, so it is unit-tested. */
export function campaignJoinMode(f: LeadFilter, r: ResolvedLeadFilter): JoinMode {
  if (f.in_campaign === "none") return "anti";
  if (r.campaignId || f.campaign_status?.length || f.temperature || f.in_campaign === "any") return "inner";
  return "display";
}

export function needsOrgInner(f: LeadFilter): boolean {
  return !!(f.company || f.industry);
}

/**
 * The select string for a lead query under this filter. Pure (unit-tested).
 * `minimal` drops the embeds the filter does not need — counting and grouping
 * do not need every lead's company and campaign list, and those joins are
 * most of the query time.
 */
export function leadSelect(
  f: LeadFilter,
  r: ResolvedLeadFilter,
  columns: string,
  opts?: { minimal?: boolean; withOrg?: boolean; withCampaigns?: boolean },
): string {
  const parts = [columns];
  const orgNeeded = needsOrgInner(f);
  if (!opts?.minimal || orgNeeded || opts.withOrg) {
    parts.push(`organizations${orgNeeded ? "!inner" : ""}(name, industry, domain, unsubscribed)`);
  }
  const mode = campaignJoinMode(f, r);
  if (mode === "anti") parts.push("campaign_leads!lead_id(id)");
  else if (mode === "inner") parts.push("campaign_leads!lead_id!inner(campaign_id, crm_status, lead_temperature, campaigns(name))");
  else if (!opts?.minimal || opts.withCampaigns) parts.push("campaign_leads!lead_id(crm_status, lead_temperature, campaigns(name))");
  return parts.join(", ");
}

/**
 * Apply the filter to a supabase-js query on `leads`. Typed loosely on purpose:
 * the select string is built at runtime, which defeats supabase-js's select
 * inference and makes tsc give up ("type instantiation is excessively deep").
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyLeadFilter(q: any, caller: AssistantCaller, f: LeadFilter, r: ResolvedLeadFilter): any {
  q = q.eq("is_deleted", false);
  // The security boundary: an employee only ever sees leads assigned to them.
  if (caller.role === "employee") q = q.eq("assigned_to", caller.userId);

  if (r.assigneeId === "unassigned") q = q.is("assigned_to", null);
  else if (r.assigneeId) q = q.eq("assigned_to", r.assigneeId);

  if (f.query) {
    for (const word of cleanSearch(f.query).split(" ").filter(Boolean).slice(0, 4)) {
      q = q.or(`first_name.ilike.%${word}%,last_name.ilike.%${word}%,email.ilike.%${word}%,title.ilike.%${word}%`);
    }
  }
  if (f.company) q = q.ilike("organizations.name", `%${ilikeValue(f.company)}%`);
  if (f.industry) q = q.ilike("organizations.industry", `%${ilikeValue(f.industry)}%`);
  if (f.country) q = q.ilike("country", `%${ilikeValue(f.country)}%`);
  if (f.city) q = q.ilike("city", `%${ilikeValue(f.city)}%`);
  if (f.status?.length) q = q.in("status", f.status);
  if (f.has_email === true) q = q.not("email", "is", null);
  if (f.has_email === false) q = q.is("email", null);
  if (f.source) q = q.eq("lead_source", f.source);
  if (f.created_after) q = q.gte("created_at", f.created_after);
  if (f.created_before) q = q.lt("created_at", f.created_before);

  const mode = campaignJoinMode(f, r);
  if (mode === "anti") q = q.is("campaign_leads", null);
  if (mode === "inner") {
    if (r.campaignId) q = q.eq("campaign_leads.campaign_id", r.campaignId);
    if (f.campaign_status?.length) q = q.in("campaign_leads.crm_status", f.campaign_status);
    if (f.temperature) q = q.eq("campaign_leads.lead_temperature", f.temperature);
  }
  return q;
}

/** One-line description of the filter, for tool output and action cards. */
export function describeLeadFilter(f: LeadFilter, r: ResolvedLeadFilter): string {
  const parts: string[] = [];
  if (f.status?.length) parts.push(`status ${f.status.join("/")}`);
  if (f.query) parts.push(`matching "${f.query}"`);
  if (f.company) parts.push(`company contains "${f.company}"`);
  if (f.industry) parts.push(`industry "${f.industry}"`);
  if (f.country) parts.push(`in ${f.country}`);
  if (f.city) parts.push(`city ${f.city}`);
  if (r.assigneeName) parts.push(r.assigneeId === "unassigned" ? "unassigned" : `assigned to ${r.assigneeName}`);
  if (r.campaignName) parts.push(`in campaign "${r.campaignName}"`);
  if (f.campaign_status?.length) parts.push(`campaign status ${f.campaign_status.join("/")}`);
  if (f.in_campaign === "none") parts.push("not in any campaign");
  if (f.in_campaign === "any") parts.push("in a campaign");
  if (f.temperature) parts.push(`${f.temperature}`);
  if (f.has_email === true) parts.push("with email");
  if (f.has_email === false) parts.push("without email");
  if (f.source) parts.push(`from ${f.source}`);
  if (f.created_after) parts.push(`added since ${f.created_after}`);
  if (f.created_before) parts.push(`added before ${f.created_before}`);
  return parts.length ? parts.join(", ") : "all leads";
}
