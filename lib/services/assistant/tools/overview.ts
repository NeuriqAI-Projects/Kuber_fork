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

/** Call a count/aggregate function from supabase/migrations/2026_11_05_C_stats_rpcs.sql.
 *  null when it is missing or fails — each tool then runs its old queries. */
async function statsRpc<T>(caller: AssistantCaller, fn: string, args: Record<string, unknown>): Promise<T | null> {
  const { data, error } = await caller.db.rpc(fn, { p_company: caller.companyId, ...args });
  if (error) { console.warn(`[assistant] ${fn} unavailable, using the old queries:`, error.message); return null; }
  return data as T;
}

/** Groups counted in SQL → countBy's shape and order (count desc; ties keep the
 *  order the old row scan met them in, i.e. newest `latest` first). */
function groupCounts(groups: Array<{ key: string; n: number; latest?: string }>): Array<{ value: string; count: number }> {
  const m = new Map<string, { count: number; latest: string }>();
  for (const g of groups) {
    const e = m.get(g.key) ?? { count: 0, latest: "" };
    e.count += g.n;
    if ((g.latest ?? "") > e.latest) e.latest = g.latest ?? "";
    m.set(g.key, e);
  }
  return [...m.entries()]
    .sort((a, b) => b[1].latest.localeCompare(a[1].latest))
    .map(([value, e]) => ({ value, count: e.count }))
    .sort((a, b) => b.count - a.count);
}

type Cell = { assigned_to: string | null; status: string; n: number };
/** Fallback for lead_counts_by_assignee: the same cells from raw rows. */
function countCells(rows: Array<{ assigned_to: string | null; status: string }>): Cell[] {
  const m = new Map<string, Cell>();
  for (const r of rows) {
    const k = `${r.assigned_to ?? ""}|${r.status}`;
    const c = m.get(k) ?? { assigned_to: r.assigned_to, status: r.status, n: 0 };
    c.n++;
    m.set(k, c);
  }
  return [...m.values()];
}

/** One llm_usage_summary row (or one raw llm_usage row in the fallback). */
type UsageGroup = {
  purpose: string | null; provider: string; model: string; user_id: string | null; day: string;
  calls: number; cost_usd: number | string; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cache_write_tokens: number; failed: number; unpriced: number; last_used: string;
};

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
        // Only awaited when assistant_overview_counts is missing (fallback).
        let draftsQ = caller.db.from("email_drafts").select(employee ? "id, leads!inner(assigned_to)" : "id", { count: "exact", head: true }).eq("status", "draft");
        if (employee) draftsQ = draftsQ.eq("leads.assigned_to", caller.userId);
        let failQ = caller.db.from("lead_events").select(employee ? "id, leads!inner(assigned_to)" : "id", { count: "exact", head: true })
          .eq("event", "enrichment_failed").gte("created_at", daysAgoIso(7));
        if (employee) failQ = failQ.eq("leads.assigned_to", caller.userId);

        // Lead / campaign-lead / draft / failure counts: one SQL call
        // (assistant_overview_counts) instead of ~17 head counts; the old
        // counts run only if that function is missing. "Needs reply" still
        // comes from getThreads — its per-person rule lives in JS.
        type OverviewCounts = {
          lead_status: Record<string, number>; added_since: number; cl_status: Record<string, number>;
          hot: number; interested: number; drafts_waiting: number; enrichment_failed: number;
        };
        const since7 = daysAgoIso(7);
        const [rpcCounts, camps, needsReply, unread] = await Promise.all([
          statsRpc<OverviewCounts>(caller, "assistant_overview_counts", { p_user: employee ? caller.userId : null, p_since: since7 }),
          campsQ,
          getThreads(caller.db, { read_state: "needs_reply", limit: 10, scope }),
          getUnreadCount(caller.db, scope),
        ]);
        type Group = { value: string; count: number };
        const [leadStatus, addedWeek, clStages, hot, interested, draftCount, failedCount]: [Group[], number, Group[], number, number, number, number] = rpcCounts
          ? [
              LEAD_STATUSES.map((v) => ({ value: v as string, count: Number(rpcCounts.lead_status[v] ?? 0) })),
              Number(rpcCounts.added_since),
              CAMPAIGN_LEAD_STATUSES.map((v) => ({ value: v as string, count: Number(rpcCounts.cl_status[v] ?? 0) })),
              Number(rpcCounts.hot),
              Number(rpcCounts.interested),
              Number(rpcCounts.drafts_waiting),
              Number(rpcCounts.enrichment_failed),
            ]
          : await Promise.all([
              Promise.all(LEAD_STATUSES.map(async (v) => ({ value: v as string, count: await leadCount((q) => q.eq("status", v)) }))),
              leadCount((q) => q.gte("created_at", since7)),
              Promise.all(CAMPAIGN_LEAD_STATUSES.map(async (v) => ({ value: v as string, count: await clCount((q) => q.eq("crm_status", v)) }))),
              clCount((q) => q.eq("lead_temperature", "hot")),
              clCount((q) => q.eq("interest_status", 1)),
              Promise.resolve(draftsQ).then((r: { count: number | null }) => r.count ?? 0),
              Promise.resolve(failQ).then((r: { count: number | null }) => r.count ?? 0),
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
            drafts_waiting_review: draftCount,
            enrichment_failures_last_7_days: failedCount,
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
        // Leads per (assignee, status) come grouped from SQL (lead_counts_by_assignee)
        // instead of reading every lead row; the row read is only the fallback.
        const [team, grouped, camps] = await Promise.all([
          loadTeam(caller.db),
          statsRpc<Cell[]>(caller, "lead_counts_by_assignee", {}).then(async (cells) => cells
            ?? countCells((await readAllPages<{ assigned_to: string | null; status: string }>((from, to) =>
              caller.db.from("leads").select("assigned_to, status").eq("is_deleted", false).order("id").range(from, to))).rows)),
          caller.db.from("campaigns").select("id, status, created_by, assigned_to, replied_count, sent_count").eq("is_deleted", false),
        ]);
        const people = team.filter((t) => !only || t.id === only);
        const sumCells = (cells: Cell[]) => cells.reduce((s, c) => s + Number(c.n), 0);
        const byStatus = (cells: Cell[]) => groupCounts(cells.map((c) => ({ key: c.status, n: Number(c.n) })));
        const unassigned = grouped.filter((c) => !c.assigned_to);
        // ponytail: replies_needing_answer is still one getThreads per teammate
        // (per-person JS rule, up to 2,000 messages each); a company-wide read
        // would hit the 2,000 cap first (the client has ~7,700 messages).
        const members = await Promise.all(people.map(async (m) => {
          const mine = grouped.filter((c) => c.assigned_to === m.id);
          const owned = (camps.data ?? []).filter((c) => (c.assigned_to ?? c.created_by) === m.id);
          const waiting = await getThreads(caller.db, { read_state: "needs_reply", limit: 1, scope: { assigned_to: m.id } })
            .then((r) => r.counts.total).catch(() => null);
          return {
            name: m.name, email: m.email, role: m.role, active: m.is_active !== false,
            leads_assigned: sumCells(mine),
            leads_by_status: byStatus(mine),
            campaigns_owned: owned.length,
            active_campaigns: owned.filter((c) => c.status === "active").length,
            emails_sent: owned.reduce((s, c) => s + ((c.sent_count as number) ?? 0), 0),
            replies: owned.reduce((s, c) => s + ((c.replied_count as number) ?? 0), 0),
            replies_needing_answer: waiting,
          };
        }));
        return {
          members: members.sort((a, b) => b.leads_assigned - a.leads_assigned),
          unassigned_leads: only ? undefined : { total: sumCells(unassigned), by_status: byStatus(unassigned) },
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
        type EventRow = { event: string; detail: string | null; actor_id: string | null; created_at: string; lead_id: string; leads: unknown };
        // Counts per (event, actor) from SQL (lead_event_counts) + only the 15
        // newest rows, instead of reading up to 10,000 events (the client logs
        // ~10,000 a week). Old full read stays as the fallback.
        const [groups, latestRows, team] = await Promise.all([
          statsRpc<Array<{ event: string; actor_id: string | null; n: number; latest: string }>>(caller, "lead_event_counts", {
            p_since: daysAgoIso(days), p_user: employee ? caller.userId : null,
            p_event: event ?? null, p_actor: actor, p_lead: lead_id ?? null,
          }),
          build(0, 14),
          loadTeam(caller.db),
        ]);
        const names = teamNameMap(team);
        if (latestRows.error) throw new Error(latestRows.error.message);
        let rows = (latestRows.data ?? []) as unknown as EventRow[];
        let summary: { total: number; truncated: boolean; by_event: Array<{ value: string; count: number }>; by_person: Array<{ value: string; count: number }> };
        if (groups) {
          summary = {
            total: groups.reduce((s, g) => s + Number(g.n), 0),
            truncated: false,
            by_event: groupCounts(groups.map((g) => ({ key: g.event, n: Number(g.n), latest: g.latest }))),
            by_person: groupCounts(groups.filter((g) => g.actor_id).map((g) => ({ key: names.get(g.actor_id as string) ?? "someone", n: Number(g.n), latest: g.latest }))),
          };
        } else {
          const all = await readAllPages<EventRow>(build, 10_000);
          rows = all.rows;
          summary = {
            total: all.rows.length,
            truncated: all.truncated,
            by_event: countBy(all.rows, (r) => r.event),
            by_person: countBy(all.rows.filter((r) => r.actor_id), (r) => names.get(r.actor_id as string) ?? "someone"),
          };
        }
        return {
          window_days: days,
          total_events: summary.total,
          truncated: summary.truncated,
          by_event: summary.by_event,
          by_person: summary.by_person,
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
        // Drafts per campaign grouped in SQL (email_drafts_by_campaign); the
        // row read is only the fallback.
        const [drafts, replyDrafts, camps] = await Promise.all([
          statsRpc<Array<{ campaign_id: string | null; n: number }>>(caller, "email_drafts_by_campaign", {
            p_status: status, p_user: employee ? caller.userId : null,
          }).then(async (cells) => cells?.map((c) => ({ campaign_id: c.campaign_id, n: Number(c.n) }))
            ?? (await readAllPages<{ campaign_id: string | null }>((from, to) => {
              let q = caller.db.from("email_drafts").select(employee ? "campaign_id, leads!inner(assigned_to)" : "campaign_id").eq("status", status);
              if (employee) q = q.eq("leads.assigned_to", caller.userId);
              return q.order("id").range(from, to);
            })).rows.map((r) => ({ campaign_id: r.campaign_id, n: 1 }))),
          (() => {
            let q = caller.db.from("reply_drafts").select(employee ? "id, campaign_leads!inner(leads!lead_id!inner(assigned_to))" : "id", { count: "exact", head: true }).eq("status", "draft");
            if (employee) q = q.eq("campaign_leads.leads.assigned_to", caller.userId);
            return q;
          })(),
          caller.db.from("campaigns").select("id, name, status").eq("is_deleted", false),
        ]);
        const campName = new Map((camps.data ?? []).map((c) => [c.id as string, c.name as string]));
        const visible = drafts.filter((d) => !allowed || (d.campaign_id && allowed.includes(d.campaign_id)));
        return {
          status,
          email_drafts: visible.reduce((s, d) => s + d.n, 0),
          by_campaign: groupCounts(visible.map((d) => ({ key: d.campaign_id ? campName.get(d.campaign_id) ?? "(deleted campaign)" : "(no campaign)", n: d.n }))).slice(0, 20),
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
        // Pre-summed per (purpose, model, person, day) in SQL (llm_usage_summary):
        // a few hundred groups instead of up to 50,000 `select *` rows. The
        // fallback reads the rows (narrow columns) as single-call "groups".
        const [summary, team, credits] = await Promise.all([
          statsRpc<UsageGroup[]>(caller, "llm_usage_summary", { p_since: since }),
          loadTeam(caller.db),
          caller.db.from("system_state").select("key, value, updated_at").like("key", "credit_check_%"),
        ]);
        const rowsAsGroups = async (): Promise<UsageGroup[]> => (await readAllPages<Record<string, unknown>>((from, to) =>
          caller.db.from("llm_usage")
            .select("purpose, provider, model, user_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, error, created_at")
            .gte("created_at", since).order("created_at", { ascending: false }).range(from, to), 50_000)).rows
          .map((r) => ({
            purpose: r.purpose as string | null, provider: r.provider as string, model: r.model as string, user_id: (r.user_id as string | null) ?? null,
            day: String(r.created_at).slice(0, 10), calls: 1, cost_usd: Number(r.cost_usd ?? 0),
            input_tokens: Number(r.input_tokens ?? 0), output_tokens: Number(r.output_tokens ?? 0),
            cache_read_tokens: Number(r.cache_read_tokens ?? 0), cache_write_tokens: Number(r.cache_write_tokens ?? 0),
            failed: r.error ? 1 : 0, unpriced: !r.error && r.cost_usd == null ? 1 : 0, last_used: String(r.created_at),
          }));
        // Newest first, so equal-cost groups keep the old (first seen) order.
        const usageGroups = (summary ?? await rowsAsGroups()).sort((a, b) => String(b.last_used).localeCompare(String(a.last_used)));
        const names = teamNameMap(team);
        // One pass per grouping (the old spread-per-row grouping was O(n^2)).
        const sum = (rows: UsageGroup[]) => ({
          calls: rows.reduce((s, r) => s + Number(r.calls), 0),
          cost_usd: Math.round(rows.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0) * 100) / 100,
          input_tokens: rows.reduce((s, r) => s + Number(r.input_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens), 0),
          output_tokens: rows.reduce((s, r) => s + Number(r.output_tokens), 0),
          failed: rows.reduce((s, r) => s + Number(r.failed), 0),
        });
        const group = (rows: UsageGroup[], key: (r: UsageGroup) => string) => {
          const m = new Map<string, UsageGroup[]>();
          for (const r of rows) { const k = key(r); const list = m.get(k); if (list) list.push(r); else m.set(k, [r]); }
          return [...m.entries()].map(([k, list]) => ({ name: k, ...sum(list) })).sort((a, b) => b.cost_usd - a.cost_usd);
        };
        const assistantRows = usageGroups.filter((r) => r.purpose === "assistant");
        const creditRows = (credits.data ?? []).filter((c) => {
          const k = c.key as string;
          return !k.includes(":") || k.endsWith(`:${caller.companyId}`);
        });
        return {
          window_days: days,
          ai_total: sum(usageGroups),
          by_purpose: group(usageGroups, (r) => String(r.purpose ?? "other")),
          by_model: group(usageGroups, (r) => `${r.provider}/${r.model}`).slice(0, 10),
          assistant_by_person: group(assistantRows, (r) => (r.user_id ? names.get(r.user_id) ?? "someone" : "unknown")).slice(0, 20),
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
