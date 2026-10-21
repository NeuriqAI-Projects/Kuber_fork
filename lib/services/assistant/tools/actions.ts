// The assistant's action tools. Each one only builds a PROPOSAL (see
// lib/services/assistant/actions.ts) — it checks what would happen, counts it,
// and returns a confirm card. Nothing in the database changes here.
import { tool } from "ai";
import { z } from "zod";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import { signProposal, type ActionPayload, type ActionProposal } from "@/lib/services/assistant/actions";
import {
  applyLeadFilter, describeLeadFilter, leadSelect, LeadFilterSchema, resolveLeadFilter, type LeadFilter,
} from "@/lib/services/assistant/tools/lead-filter";
import {
  cleanSearch, isUuid, one, personName, readAllPages, resolveAssignee, resolveCampaign,
} from "@/lib/services/assistant/tools/shared";
import { MAX_ENRICH_ATTEMPTS } from "@/lib/services/enrich-leads";

/** Hard ceiling per proposal. Bigger jobs are split by the user, on purpose. */
const MAX_LEADS = 500;
const TERMINAL = new Set(["completed", "paused"]);

const LeadSetSchema = z.object({
  lead_ids: z.array(z.string()).max(MAX_LEADS).optional().describe("Exact lead ids (from search_leads). Prefer `filter` for 'all leads that…'."),
  filter: LeadFilterSchema.optional().describe("Same filter as search_leads — every matching lead is included."),
});

type LeadSetRow = {
  id: string; first_name: string | null; last_name: string | null; email: string | null; status: string;
  assigned_to: string | null; lead_source: string | null; enrich_attempts: number | null;
  organizations: { unsubscribed: boolean | null } | null;
};

async function loadLeadSet(
  caller: AssistantCaller,
  input: { lead_ids?: string[]; filter?: LeadFilter },
): Promise<{ rows: LeadSetRow[]; description: string; truncated: boolean } | { error: string }> {
  const cols = "id, first_name, last_name, email, status, assigned_to, lead_source, enrich_attempts";
  if (input.lead_ids?.length) {
    const ids = input.lead_ids.filter((id) => isUuid(id));
    if (!ids.length) return { error: "Those are not valid lead ids — use search_leads first or pass a filter." };
    let q = caller.db.from("leads").select(`${cols}, organizations(unsubscribed)`).in("id", ids).eq("is_deleted", false);
    if (caller.role === "employee") q = q.eq("assigned_to", caller.userId);
    const { data, error } = await q;
    if (error) return { error: error.message };
    return { rows: (data ?? []) as unknown as LeadSetRow[], description: `${ids.length} selected leads`, truncated: false };
  }
  if (!input.filter) return { error: "Say which leads: pass lead_ids or a filter." };
  const resolved = await resolveLeadFilter(caller, input.filter);
  if ("error" in resolved) return resolved;
  const { rows, truncated } = await readAllPages<LeadSetRow>((from, to) => {
    let q = caller.db.from("leads").select(leadSelect(input.filter!, resolved, cols, { minimal: true, withOrg: true }));
    q = applyLeadFilter(q, caller, input.filter!, resolved);
    return q.order("created_at", { ascending: false }).range(from, to);
  }, MAX_LEADS + 1);
  return { rows, description: describeLeadFilter(input.filter, resolved), truncated: truncated || rows.length > MAX_LEADS };
}

/** Same rule as POST /campaigns/[id]/leads: has an email, enriched or input_required, company not unsubscribed. */
function campaignReady(l: LeadSetRow): boolean {
  return !!l.email && (l.status === "enriched" || l.status === "input_required") && !one(l.organizations)?.unsubscribed;
}

async function proposal(
  caller: AssistantCaller,
  payload: ActionPayload,
  card: Omit<ActionProposal, "token" | "kind">,
): Promise<{ proposal: ActionProposal }> {
  return { proposal: { token: await signProposal(caller, payload), kind: payload.kind, ...card } };
}

/**
 * What the MODEL sees of a proposal: never the token, and whether the user has
 * confirmed it yet. The UI writes `executed` into the tool output after the
 * user clicks, so on the next turn the model knows the action really happened.
 */
function proposalForModel({ output }: { output: unknown }) {
  const o = output as { proposal?: ActionProposal; error?: string; executed?: unknown; cancelled?: boolean } | undefined;
  if (!o?.proposal) return { type: "json" as const, value: (o ?? null) as never };
  const { token: _token, ...rest } = o.proposal;
  void _token;
  return {
    type: "json" as const,
    value: {
      status: o.executed ? "done" : o.cancelled ? "cancelled_by_user" : "waiting_for_user_to_confirm",
      ...rest,
      result: o.executed ?? null,
    } as never,
  };
}

export function actionTools(caller: AssistantCaller) {
  const manager = caller.role === "manager";

  return {
    propose_create_campaign: tool({
      description:
        "Propose a NEW draft campaign containing a set of leads (by filter or ids). Only campaign-ready leads go in (email + enriched/input_required + not unsubscribed). " +
        "Returns a confirm card; the campaign is created only after the user confirms. It is created as a draft — nothing is sent.",
      inputSchema: LeadSetSchema.extend({
        name: z.string().min(1).max(120).describe("Campaign name."),
        daily_limit: z.number().int().min(1).max(500).optional().describe("Emails per day (default 30)."),
      }),
      execute: async ({ name, daily_limit = 30, ...set }) => {
        const leads = await loadLeadSet(caller, set);
        if ("error" in leads) return { error: leads.error };
        if (leads.truncated) return { error: `That matches more than ${MAX_LEADS} leads. Narrow the filter (e.g. by country or industry) or split it into several campaigns.` };
        const ready = leads.rows.filter(campaignReady);
        if (!ready.length) return { error: `None of the ${leads.rows.length} matching leads can go into a campaign (they need an email and status enriched/input_required).` };
        const notReady = leads.rows.length - ready.length;
        return proposal(caller, { kind: "create_campaign", name, daily_limit, lead_ids: ready.map((l) => l.id) }, {
          title: `Create campaign "${name}"`,
          summary: `New draft campaign with ${ready.length} lead${ready.length === 1 ? "" : "s"}.`,
          details: [
            { label: "Leads", value: `${ready.length} ready` },
            { label: "Picked by", value: leads.description },
            { label: "Daily limit", value: `${daily_limit} emails/day` },
            { label: "Drafts", value: "AI writes them right after, for your review" },
            { label: "Sending", value: "Off — draft only, you start it later" },
          ],
          warnings: notReady ? [`${notReady} matching lead${notReady === 1 ? " is" : "s are"} not ready (no email, not enriched, or unsubscribed) and will be left out.`] : [],
          confirm_label: "Create campaign",
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_add_to_campaign: tool({
      description: "Propose adding leads (filter or ids) to an EXISTING campaign. Returns a confirm card; nothing changes until the user confirms.",
      inputSchema: LeadSetSchema.extend({ campaign: z.string().describe("Target campaign name or id.") }),
      execute: async ({ campaign, ...set }) => {
        const ref = await resolveCampaign(caller, campaign);
        if ("error" in ref) return { error: ref.error };
        if (TERMINAL.has(ref.status)) return { error: `"${ref.name}" is ${ref.status} — leads cannot be added to it. Resume it first or pick another campaign.` };
        const leads = await loadLeadSet(caller, set);
        if ("error" in leads) return { error: leads.error };
        if (leads.truncated) return { error: `That matches more than ${MAX_LEADS} leads. Narrow the filter.` };
        const ids = leads.rows.map((l) => l.id);
        const { data: existing } = ids.length
          ? await caller.db.from("campaign_leads").select("lead_id").eq("campaign_id", ref.id).in("lead_id", ids)
          : { data: [] };
        const already = new Set((existing ?? []).map((r) => r.lead_id as string));
        const ready = leads.rows.filter((l) => campaignReady(l) && !already.has(l.id));
        if (!ready.length) return { error: `Nothing to add: ${already.size} already in "${ref.name}", the rest are not campaign-ready.` };
        return proposal(caller, { kind: "add_to_campaign", campaign_id: ref.id, campaign_name: ref.name, lead_ids: ready.map((l) => l.id) }, {
          title: `Add ${ready.length} lead${ready.length === 1 ? "" : "s"} to "${ref.name}"`,
          summary: `${ready.length} campaign-ready lead${ready.length === 1 ? "" : "s"} will join "${ref.name}" (${ref.status}).`,
          details: [
            { label: "Campaign", value: `${ref.name} (${ref.status})` },
            { label: "Picked by", value: leads.description },
            { label: "Adding", value: String(ready.length) },
          ],
          warnings: [
            ...(already.size ? [`${already.size} already in this campaign — skipped.`] : []),
            ...(leads.rows.length - ready.length - already.size > 0 ? [`${leads.rows.length - ready.length - already.size} not campaign-ready — skipped.`] : []),
          ],
          confirm_label: "Add leads",
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_assign_leads: tool({
      description: "Managers only. Propose assigning leads (filter or ids) to a teammate, or sharing them round-robin. Returns a confirm card.",
      inputSchema: LeadSetSchema.extend({
        to: z.string().describe("Teammate name/email/id, or 'round robin' to share across the team."),
      }),
      execute: async ({ to, ...set }) => {
        if (!manager) return { error: "Only managers can assign leads." };
        const roundRobin = /round.?robin|share|split|evenly/i.test(to);
        let assigned_to: string | null = null;
        let assignee_name = "round-robin";
        if (!roundRobin) {
          const a = await resolveAssignee(caller, to);
          if ("error" in a) return { error: a.error };
          assigned_to = a.id === "unassigned" ? null : a.id;
          assignee_name = a.id === "unassigned" ? "nobody (unassign)" : a.name;
        }
        const leads = await loadLeadSet(caller, set);
        if ("error" in leads) return { error: leads.error };
        if (leads.truncated) return { error: `That matches more than ${MAX_LEADS} leads. Narrow the filter.` };
        if (!leads.rows.length) return { error: "No leads match." };
        const alreadyThere = assigned_to ? leads.rows.filter((l) => l.assigned_to === assigned_to).length : 0;
        return proposal(caller, {
          kind: "assign_leads", lead_ids: leads.rows.map((l) => l.id),
          strategy: roundRobin ? "round_robin" : "manual", assigned_to, assignee_name,
        }, {
          title: roundRobin ? `Share ${leads.rows.length} leads round-robin` : `Assign ${leads.rows.length} leads to ${assignee_name}`,
          summary: `${leads.rows.length} lead${leads.rows.length === 1 ? "" : "s"} (${leads.description}).`,
          details: [{ label: "Leads", value: String(leads.rows.length) }, { label: "To", value: assignee_name }],
          warnings: alreadyThere ? [`${alreadyThere} already belong to ${assignee_name}.`] : [],
          confirm_label: "Assign",
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_campaign_state: tool({
      description:
        "Propose pausing or resuming a campaign, or starting AI draft writing for it. Returns a confirm card. " +
        "Pause is the only real stop for sending.",
      inputSchema: z.object({
        campaign: z.string().describe("Campaign name or id."),
        action: z.enum(["pause", "resume", "generate_drafts"]),
      }),
      execute: async ({ campaign, action }) => {
        const ref = await resolveCampaign(caller, campaign);
        if ("error" in ref) return { error: ref.error };
        if (action === "pause" && ref.status === "paused") return { error: `"${ref.name}" is already paused.` };
        if (action === "resume" && ref.status !== "paused") return { error: `"${ref.name}" is ${ref.status}, not paused.` };
        const { count } = await caller.db.from("campaign_leads").select("id", { count: "exact", head: true }).eq("campaign_id", ref.id);
        if (action === "generate_drafts" && !count) return { error: `"${ref.name}" has no leads yet — add leads first.` };
        const kind = action === "pause" ? "pause_campaign" : action === "resume" ? "resume_campaign" : "generate_drafts";
        const title = action === "pause" ? `Pause "${ref.name}"` : action === "resume" ? `Resume "${ref.name}"` : `Write drafts for "${ref.name}"`;
        return proposal(caller, { kind, campaign_id: ref.id, campaign_name: ref.name }, {
          title,
          summary: action === "pause"
            ? "Stops all sending for this campaign until it is resumed."
            : action === "resume" ? "Sending restarts on the campaign's schedule." : `AI writes a personalised first email for each of the ${count} leads. You review them before anything is sent.`,
          details: [{ label: "Campaign", value: `${ref.name} (${ref.status})` }, { label: "Leads", value: String(count ?? 0) }],
          warnings: [],
          uses_ai: action === "generate_drafts",
          confirm_label: action === "pause" ? "Pause" : action === "resume" ? "Resume" : "Write drafts",
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_reveal_emails: tool({
      description:
        "Managers only. Propose revealing emails through Apollo for leads that do not have one yet. COSTS 1 Apollo credit per lead. " +
        "Returns a confirm card with the exact credit cost; nothing is spent until the user confirms.",
      inputSchema: LeadSetSchema,
      execute: async (set) => {
        if (!manager) return { error: "Only managers can reveal emails (it spends Apollo credits)." };
        const leads = await loadLeadSet(caller, set);
        if ("error" in leads) return { error: leads.error };
        // Same selection the reveal route makes — only these leads can cost a credit.
        const candidates = leads.rows.filter((l) => l.lead_source === "apollo" && !l.email && (l.enrich_attempts ?? 0) < MAX_ENRICH_ATTEMPTS).slice(0, 200);
        if (!candidates.length) return { error: "None of these leads need an email reveal (they already have one, are not from Apollo, or hit the retry limit)." };
        return proposal(caller, { kind: "enrich_leads", lead_ids: candidates.map((l) => l.id) }, {
          title: `Reveal ${candidates.length} email${candidates.length === 1 ? "" : "s"}`,
          summary: `Apollo looks up the email for ${candidates.length} lead${candidates.length === 1 ? "" : "s"}.`,
          details: [{ label: "Leads", value: String(candidates.length) }, { label: "Picked by", value: leads.description }],
          warnings: leads.rows.length > candidates.length ? [`${leads.rows.length - candidates.length} matching leads are skipped (already have an email, not from Apollo, or over the retry limit).`] : [],
          apollo_credits: candidates.length,
          confirm_label: `Spend ${candidates.length} credit${candidates.length === 1 ? "" : "s"}`,
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_lead_note: tool({
      description: "Propose adding a note (comment) to a lead. Returns a confirm card.",
      inputSchema: z.object({
        lead: z.string().describe("Lead id, email or full name."),
        text: z.string().min(1).max(2000),
      }),
      execute: async ({ lead, text }) => {
        let q = caller.db.from("leads").select("id, first_name, last_name, email").eq("is_deleted", false);
        if (caller.role === "employee") q = q.eq("assigned_to", caller.userId);
        const v = lead.trim();
        if (isUuid(v)) q = q.eq("id", v);
        else if (v.includes("@")) q = q.ilike("email", cleanSearch(v).replace(/ /g, ""));
        else for (const w of cleanSearch(v).split(" ").filter(Boolean).slice(0, 3)) q = q.or(`first_name.ilike.%${w}%,last_name.ilike.%${w}%`);
        const { data } = await q.limit(3);
        if (!data?.length) return { error: `No lead matches "${v}".` };
        if (data.length > 1) return { error: `Several leads match "${v}": ${data.map((d) => `${personName(d.first_name, d.last_name)} <${d.email ?? "no email"}>`).join("; ")}. Ask which one.` };
        const l = data[0];
        const name = personName(l.first_name, l.last_name);
        return proposal(caller, { kind: "add_note", lead_id: l.id, lead_name: name, text }, {
          title: `Add a note to ${name}`,
          summary: text.length > 160 ? `${text.slice(0, 160)}…` : text,
          details: [{ label: "Lead", value: `${name}${l.email ? ` <${l.email}>` : ""}` }],
          warnings: [],
          confirm_label: "Add note",
        });
      },
      toModelOutput: proposalForModel,
    }),

    propose_reply_draft: tool({
      description:
        "Propose writing an AI reply DRAFT for an email conversation (it is saved in Unibox for review — never sent). " +
        "Use get_thread / search_inbox first to find the thread.",
      inputSchema: z.object({
        thread_id: z.string(),
        instruction: z.string().max(500).optional().describe("What the reply should say, e.g. 'offer a call on Monday'."),
      }),
      execute: async ({ thread_id, instruction }) => {
        let q = caller.db.from("unibox_emails")
          .select(caller.role === "employee"
            ? "thread_id, lead_email, campaign_leads!inner(leads!lead_id!inner(first_name, last_name, assigned_to))"
            : "thread_id, lead_email, campaign_leads(leads!lead_id(first_name, last_name))")
          .eq("thread_id", thread_id).eq("direction", "received");
        if (caller.role === "employee") q = q.eq("campaign_leads.leads.assigned_to", caller.userId);
        const { data } = await q.limit(1);
        const row = data?.[0] as { lead_email: string | null; campaign_leads: unknown } | undefined;
        if (!row) return { error: "No received email in that conversation to reply to." };
        const lead = one(one(row.campaign_leads as { leads: unknown } | null)?.leads as { first_name: string | null; last_name: string | null } | null);
        const name = lead ? personName(lead.first_name, lead.last_name) : row.lead_email ?? "the lead";
        return proposal(caller, { kind: "draft_reply", thread_id, lead_name: name, instruction: instruction ?? null }, {
          title: `Draft a reply to ${name}`,
          summary: instruction ? `AI writes a reply: ${instruction}` : "AI writes a reply to their latest email.",
          details: [{ label: "To", value: name }, { label: "Sending", value: "No — saved as a draft in Unibox" }],
          warnings: [],
          uses_ai: true,
          confirm_label: "Write draft",
        });
      },
      toModelOutput: proposalForModel,
    }),
  };
}

