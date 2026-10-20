// Whole-pipeline views: today's to-do list, team workload, activity, and spend.
import { tool } from "ai";
import { z } from "zod";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import { getThreads, getUnreadCount } from "@/lib/services/unibox";
import { getUniboxScope } from "@/lib/auth/scope";
import { CAMPAIGN_LEAD_STATUSES, LEAD_STATUSES } from "@/lib/services/assistant/tools/lead-filter";
import {
  accessibleCampaignIds, clip, countBy, daysAgoIso, loadTeam, one, personName, readAllPages, resolveAssignee, teamNameMap,
} from "@/lib/services/assistant/tools/shared";

const MANAGER_ONLY = { error: "Only managers can see this. Answer about the user's own work instead." };

export function overviewTools(caller: AssistantCaller) {
  const employee = caller.role === "employee";
  const scope = getUniboxScope({ id: caller.userId, role: caller.role, isSuperAdmin: false, companyId: caller.companyId }) ?? undefined;

  return {
    pipeline_overview: tool({
      description:
        "A snapshot of the whole pipeline in one call: leads by status, campaign-lead stages, campaigns by status, replies waiting for an answer, " +
        "unread inbox, drafts waiting for review, recent replies and enrichment failures. Use for 'what should I do today', 'how are we doing', " +
        "'where are leads stuck', and as the first call for broad questions.",
      inputSchema: z.object({}),
      execute: async () => {
        const allowed = await accessibleCampaignIds(caller);
        // Everything here is a head-only count, run in parallel: one round-trip
        // of latency however many leads the company has.
        const leadCount = (extra: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          let q = caller.db.from("leads").select("id", { count: "exact", head: true }).eq("is_deleted", false);
          if (employee) q = q.eq("assigned_to", caller.userId);
          return Promise.resolve(extra(q)).then((r: { count: number | null }) => r.count ?? 0);
        };
        const clCount = (extra: (q: any) => any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
          let q = caller.db.from("campaign_leads").select(employee ? "id, leads!lead_id!inner(assigned_to)" : "id", { count: "exact", head: true });
          if (employee) q = q.eq("leads.assigned_to", caller.userId);
          return Promise.resolve(extra(q)).then((r: { count: number | null }) => r.count ?? 0);
        };
        let campsQ = caller.db.from("campaigns").select("id, name, status, sent_count, replied_count").eq("is_deleted", false);
        if (allowed) campsQ = campsQ.in("id", allowed.length ? allowed : ["00000000-0000-0000-0000-000000000000"]);
        let draftsQ = caller.db.from("email_drafts").select(employee ? "id, leads!inner(assigned_to)" : "id", { count: "exact", head: true }).eq("status", "draft");
        if (employee) draftsQ = draftsQ.eq("leads.assigned_to", caller.userId);
        let failQ = caller.db.from("lead_events").select(employee ? "id, leads!inner(assigned_to)" : "id", { count: "exact", head: true })
          .eq("event", "enrichment_failed").gte("created_at", daysAgoIso(7));
        if (employee) failQ = failQ.eq("leads.assigned_to", caller.userId);

        const [leadStatus, addedWeek, clStages, hot, interested, camps, drafts, needsReply, unread, failed] = await Promise.all([
          Promise.all(LEAD_STATUSES.map(async (v) => ({ value: v, count: await leadCount((q) => q.eq("status", v)) }))),
          leadCount((q) => q.gte("created_at", daysAgoIso(7))),
          Promise.all(CAMPAIGN_LEAD_STATUSES.map(async (v) => ({ value: v, count: await clCount((q) => q.eq("crm_status", v)) }))),
          clCount((q) => q.eq("lead_temperature", "hot")),
          clCount((q) => q.eq("interest_status", 1)),
          campsQ,
          draftsQ,
          getThreads(caller.db, { read_state: "needs_reply", limit: 10, scope }),
          getUnreadCount(caller.db, scope),
          failQ,
        ]);
        const nonZero = (g: Array<{ value: string; count: number }>) => g.filter((x) => x.count > 0).sort((a, b) => b.count - a.count);
        return {
          scope: employee ? "your assigned leads only" : "whole company",
          leads: {
            total: leadStatus.reduce((s, g) => s + g.count, 0),
            by_status: nonZero(leadStatus),
            added_last_7_days: addedWeek,
          },
          in_campaigns: {
            total: clStages.reduce((s, g) => s + g.count, 0),
            by_stage: nonZero(clStages),
            hot,
            interested,
          },
          campaigns: {
            total: (camps.data ?? []).length,
            by_status: countBy(camps.data ?? [], (c) => c.status as string),
          },
          to_do: {
            replies_needing_answer: needsReply.counts.total,
            // getThreads is newest first; reversed so the longest-waiting comes first.
            longest_waiting_first: needsReply.threads.slice(-3).reverse().map((t) => ({ lead: t.lead ? personName(t.lead.first_name, t.lead.last_name) : t.lead_email, last_message_at: t.latest_at, thread_id: t.thread_id })),
            unread_emails: unread,
            drafts_waiting_review: drafts.count ?? 0,
            enrichment_failures_last_7_days: failed.count ?? 0,
          },
        };
      },
    }),

    team_overview: tool({
      description:
        "Managers only. Each teammate's workload and results: leads assigned (by status), campaigns owned, replies waiting. " +
        "Use for 'who has the most leads', 'how is Ravi doing', 'unassigned leads'.",
      inputSchema: z.object({ person: z.string().optional().describe("Limit to one teammate (name or email).") }),
      execute: async ({ person }) => {
        if (employee) return MANAGER_ONLY;
        let only: string | null = null;
        if (person) {
          const a = await resolveAssignee(caller, person);
          if ("error" in a) return { error: a.error };
          only = a.id === "unassigned" ? null : a.id;
        }
        const [team, leads, camps] = await Promise.all([
          loadTeam(caller.db),
          readAllPages<{ assigned_to: string | null; status: string }>((from, to) =>
            caller.db.from("leads").select("assigned_to, status").eq("is_deleted", false).order("id").range(from, to)),
          caller.db.from("campaigns").select("id, status, created_by, assigned_to, replied_count, sent_count").eq("is_deleted", false),
        ]);
        const people = team.filter((t) => !only || t.id === only);
        const unassigned = leads.rows.filter((l) => !l.assigned_to);
        const members = await Promise.all(people.map(async (m) => {
          const mine = leads.rows.filter((l) => l.assigned_to === m.id);
          const owned = (camps.data ?? []).filter((c) => (c.assigned_to ?? c.created_by) === m.id);
          const waiting = await getThreads(caller.db, { read_state: "needs_reply", limit: 1, scope: { assigned_to: m.id } })
            .then((r) => r.counts.total).catch(() => null);
          return {
            name: m.name, email: m.email, role: m.role, active: m.is_active !== false,
            leads_assigned: mine.length,
            leads_by_status: countBy(mine, (l) => l.status),
            campaigns_owned: owned.length,
            active_campaigns: owned.filter((c) => c.status === "active").length,
            emails_sent: owned.reduce((s, c) => s + ((c.sent_count as number) ?? 0), 0),
            replies: owned.reduce((s, c) => s + ((c.replied_count as number) ?? 0), 0),
            replies_needing_answer: waiting,
          };
        }));
        return {
          members: members.sort((a, b) => b.leads_assigned - a.leads_assigned),
          unassigned_leads: only ? undefined : { total: unassigned.length, by_status: countBy(unassigned, (l) => l.status) },
        };
      },
    }),

    recent_activity: tool({
      description:
        "What happened recently: lead events (created, enriched, added to campaign, draft created/approved/sent, assigned, enrichment failed…) " +
        "counted by type plus the latest entries. Filter by days, event type, teammate or lead.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(90).optional().describe("Look-back window (default 7; 1 = today)."),
        event: z.string().optional().describe("Event type, e.g. 'added_to_campaign', 'draft_sent', 'enrichment_failed'."),
        person: z.string().optional().describe("Only actions done by this teammate."),
        lead_id: z.string().optional(),
      }),
      execute: async ({ days = 7, event, person, lead_id }) => {
        let actor: string | null = null;
        if (person) {
          const a = await resolveAssignee(caller, person);
          if ("error" in a) return { error: a.error };
          if (a.id !== "unassigned") actor = a.id;
        }
        const build = (from: number, to: number) => {
          let q = caller.db.from("lead_events")
            .select(`event, detail, actor_id, created_at, lead_id, leads!inner(first_name, last_name, assigned_to)`)
            .gte("created_at", daysAgoIso(days));
          if (employee) q = q.eq("leads.assigned_to", caller.userId);
          if (event) q = q.eq("event", event);
          if (actor) q = q.eq("actor_id", actor);
          if (lead_id) q = q.eq("lead_id", lead_id);
          return q.order("created_at", { ascending: false }).range(from, to);
        };
        const [{ rows, truncated }, team] = await Promise.all([
          readAllPages<{ event: string; detail: string | null; actor_id: string | null; created_at: string; lead_id: string; leads: unknown }>(build, 10_000),
          loadTeam(caller.db),
        ]);
        const names = teamNameMap(team);
        return {
          window_days: days,
          total_events: rows.length,
          truncated,
          by_event: countBy(rows, (r) => r.event),
          by_person: countBy(rows.filter((r) => r.actor_id), (r) => names.get(r.actor_id as string) ?? "someone"),
          latest: rows.slice(0, 15).map((r) => {
            const l = one(r.leads as { first_name: string | null; last_name: string | null } | null);
            return { at: r.created_at, event: r.event, lead: l ? personName(l.first_name, l.last_name) : null, lead_id: r.lead_id, by: r.actor_id ? names.get(r.actor_id) ?? null : null, detail: clip(r.detail, 140) };
          }),
        };
      },
    }),

    drafts_overview: tool({
      description: "Email drafts and reply drafts waiting for review, per campaign. Use for 'how many drafts need approval', 'which campaign has drafts pending'.",
      inputSchema: z.object({ status: z.enum(["draft", "approved", "rejected", "sent", "failed"]).optional().describe("Default 'draft' (= waiting for review).") }),
      execute: async ({ status = "draft" }) => {
        const allowed = await accessibleCampaignIds(caller);
        const [drafts, replyDrafts, camps] = await Promise.all([
          readAllPages<{ campaign_id: string | null }>((from, to) => {
            let q = caller.db.from("email_drafts").select(employee ? "campaign_id, leads!inner(assigned_to)" : "campaign_id").eq("status", status);
            if (employee) q = q.eq("leads.assigned_to", caller.userId);
            return q.order("id").range(from, to);
          }),
          (() => {
            let q = caller.db.from("reply_drafts").select(employee ? "id, campaign_leads!inner(leads!lead_id!inner(assigned_to))" : "id", { count: "exact", head: true }).eq("status", "draft");
            if (employee) q = q.eq("campaign_leads.leads.assigned_to", caller.userId);
            return q;
          })(),
          caller.db.from("campaigns").select("id, name, status").eq("is_deleted", false),
        ]);
        const campName = new Map((camps.data ?? []).map((c) => [c.id as string, c.name as string]));
        const visible = drafts.rows.filter((d) => !allowed || (d.campaign_id && allowed.includes(d.campaign_id)));
        return {
          status,
          email_drafts: visible.length,
          by_campaign: countBy(visible, (d) => (d.campaign_id ? campName.get(d.campaign_id) ?? "(deleted campaign)" : "(no campaign)")).slice(0, 20),
          reply_drafts_waiting: replyDrafts.count ?? 0,
        };
      },
    }),

    usage_and_credits: tool({
      description:
        "Managers only. AI spend (tokens and $ by purpose, by model, and by person for the assistant) over the last N days, plus the last known Apollo / Firecrawl / Instantly credit balances. " +
        "Reads stored numbers only — never calls a paid API.",
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe("Default 30.") }),
      execute: async ({ days = 30 }) => {
        if (employee) return MANAGER_ONLY;
        const since = daysAgoIso(days);
        const [usage, team, credits] = await Promise.all([
          readAllPages<Record<string, unknown>>((from, to) =>
            caller.db.from("llm_usage").select("*").gte("created_at", since).order("created_at", { ascending: false }).range(from, to), 50_000),
          loadTeam(caller.db),
          caller.db.from("system_state").select("key, value, updated_at").like("key", "credit_check_%"),
        ]);
        const names = teamNameMap(team);
        const sum = (rows: Record<string, unknown>[]) => ({
          calls: rows.length,
          cost_usd: Math.round(rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) * 100) / 100,
          input_tokens: rows.reduce((s, r) => s + Number(r.input_tokens ?? 0) + Number(r.cache_read_tokens ?? 0) + Number(r.cache_write_tokens ?? 0), 0),
          output_tokens: rows.reduce((s, r) => s + Number(r.output_tokens ?? 0), 0),
          failed: rows.filter((r) => r.error).length,
        });
        const group = (rows: Record<string, unknown>[], key: (r: Record<string, unknown>) => string) => {
          const m = new Map<string, Record<string, unknown>[]>();
          for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); }
          return [...m.entries()].map(([k, list]) => ({ name: k, ...sum(list) })).sort((a, b) => b.cost_usd - a.cost_usd);
        };
        const assistantRows = usage.rows.filter((r) => r.purpose === "assistant");
        const creditRows = (credits.data ?? []).filter((c) => {
          const k = c.key as string;
          return !k.includes(":") || k.endsWith(`:${caller.companyId}`);
        });
        return {
          window_days: days,
          ai_total: sum(usage.rows),
          by_purpose: group(usage.rows, (r) => String(r.purpose ?? "other")),
          by_model: group(usage.rows, (r) => `${r.provider}/${r.model}`).slice(0, 10),
          assistant_by_person: usage.rows.length === 0 || "user_id" in usage.rows[0]
            ? group(assistantRows, (r) => (r.user_id ? names.get(r.user_id as string) ?? "someone" : "unknown")).slice(0, 20)
            : "per-person tracking starts once the 2026_10_19_assistant migration is run",
          last_known_credit_balances: creditRows.map((c) => {
            let parsed: { remaining?: number | null; message?: string } = {};
            try { parsed = JSON.parse(c.value as string); } catch { /* keep empty */ }
            return { service: (c.key as string).replace("credit_check_", "").split(":")[0], remaining: parsed.remaining ?? null, note: clip(parsed.message ?? null, 120), as_of: c.updated_at };
          }),
        };
      },
    }),
  };
}
