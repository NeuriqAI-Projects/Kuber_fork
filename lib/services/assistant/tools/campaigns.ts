import { tool } from "ai";
import { z } from "zod";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import {
  accessibleCampaignIds, clip, countBy, ilikeValue, loadTeam, one, personName, readAllPages, resolveCampaign, teamNameMap,
} from "@/lib/services/assistant/tools/shared";

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

export function campaignTools(caller: AssistantCaller) {
  return {
    list_campaigns: tool({
      description:
        "List campaigns with their status and results (leads, sent, opened, replied, hot, bounced, reply rate). " +
        "Use for 'which campaigns…', 'how are my campaigns doing', or to compare campaigns.",
      inputSchema: z.object({
        status: z.array(z.enum(["draft", "processing", "active", "paused", "completed"])).optional(),
        name: z.string().optional().describe("Campaign name contains."),
        sort: z.enum(["newest", "most_replies", "most_sent", "best_reply_rate"]).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Default 15."),
      }),
      execute: async ({ status, name, sort = "newest", limit = 15 }) => {
        const allowed = await accessibleCampaignIds(caller);
        let q = caller.db.from("campaigns")
          .select("id, name, status, total_leads, sent_count, opened_count, replied_count, hot_count, bounced_count, daily_limit, created_by, assigned_to, created_at", { count: "exact" })
          .eq("is_deleted", false);
        if (allowed) q = q.in("id", allowed.length ? allowed : ["00000000-0000-0000-0000-000000000000"]);
        if (status?.length) q = q.in("status", status);
        if (name) q = q.ilike("name", `%${ilikeValue(name)}%`);
        const { data, count, error } = await q.order("created_at", { ascending: false }).limit(500);
        if (error) return { error: error.message };
        const names = teamNameMap(await loadTeam(caller.db));
        let rows = (data ?? []).map((c) => ({
          id: c.id as string,
          name: c.name as string,
          status: c.status as string,
          leads: (c.total_leads as number) ?? 0,
          sent: (c.sent_count as number) ?? 0,
          opened: (c.opened_count as number) ?? 0,
          replied: (c.replied_count as number) ?? 0,
          hot: (c.hot_count as number) ?? 0,
          bounced: (c.bounced_count as number) ?? 0,
          reply_rate_pct: pct((c.replied_count as number) ?? 0, (c.sent_count as number) ?? 0),
          owner: names.get((c.assigned_to ?? c.created_by) as string) ?? null,
          created_at: c.created_at as string,
          url: `/campaigns/${c.id}`,
        }));
        if (sort === "most_replies") rows.sort((a, b) => b.replied - a.replied);
        if (sort === "most_sent") rows.sort((a, b) => b.sent - a.sent);
        if (sort === "best_reply_rate") rows = rows.filter((r) => r.sent >= 10).sort((a, b) => (b.reply_rate_pct ?? 0) - (a.reply_rate_pct ?? 0));
        const byStatus = countBy(rows, (r) => r.status);
        return {
          total: count ?? rows.length,
          by_status: byStatus,
          totals: {
            leads: rows.reduce((s, r) => s + r.leads, 0),
            sent: rows.reduce((s, r) => s + r.sent, 0),
            replied: rows.reduce((s, r) => s + r.replied, 0),
            hot: rows.reduce((s, r) => s + r.hot, 0),
          },
          campaigns: rows.slice(0, limit),
        };
      },
    }),

    get_campaign: tool({
      description:
        "One campaign in depth: settings, schedule, sequence steps, lead status breakdown, draft review status, results and the latest replies. " +
        "Use before answering anything about a single campaign.",
      inputSchema: z.object({ campaign: z.string().describe("Campaign name (or part of it) or id.") }),
      execute: async ({ campaign }) => {
        const ref = await resolveCampaign(caller, campaign);
        if ("error" in ref) return { error: ref.error };
        const employee = caller.role === "employee";
        const [campRes, steps, cls, drafts, replies, team] = await Promise.all([
          caller.db.from("campaigns").select("*").eq("id", ref.id).maybeSingle(),
          caller.db.from("campaign_steps").select("step_order, delay, delay_unit, subject").eq("campaign_id", ref.id).order("step_order"),
          readAllPages<{ crm_status: string; lead_temperature: string | null; interest_status: number | null; leads: { assigned_to: string | null } | null }>((from, to) => {
            let q = caller.db.from("campaign_leads")
              .select(`crm_status, lead_temperature, interest_status, leads!lead_id${employee ? "!inner" : ""}(assigned_to)`)
              .eq("campaign_id", ref.id);
            if (employee) q = q.eq("leads.assigned_to", caller.userId);
            return q.order("id").range(from, to);
          }),
          readAllPages<{ status: string; step_number: number | null }>((from, to) => {
            let q = caller.db.from("email_drafts")
              .select(employee ? "status, step_number, leads!inner(assigned_to)" : "status, step_number")
              .eq("campaign_id", ref.id);
            if (employee) q = q.eq("leads.assigned_to", caller.userId);
            return q.order("id").range(from, to);
          }),
          caller.db.from("campaign_leads")
            .select("last_reply_at, last_reply_body, lead_temperature, leads!lead_id(id, first_name, last_name, email, assigned_to)")
            .eq("campaign_id", ref.id).not("last_reply_at", "is", null)
            .order("last_reply_at", { ascending: false }).limit(8),
          loadTeam(caller.db),
        ]);
        const c = campRes.data as Record<string, unknown> | null;
        if (!c) return { error: "Campaign not found." };
        const names = teamNameMap(team);
        const sent = (c.sent_count as number) ?? 0;
        return {
          id: c.id, name: c.name, url: `/campaigns/${c.id}`, status: c.status,
          owner: names.get((c.assigned_to ?? c.created_by) as string) ?? null,
          created_at: c.created_at,
          settings: {
            human_review: c.human_in_loop, daily_limit: c.daily_limit, send_mode: c.send_mode,
            schedule_start: c.schedule_start_at, window: c.window_from ? `${c.window_from}–${c.window_to}` : null,
            timezone: c.schedule_timezone, send_days: c.send_days, sending_on_hold: !!c.sending_held_at,
            ai_followups: c.followups_ai_enabled, extra_ai_context: clip(c.ai_prompt_context as string | null, 300),
          },
          results: {
            leads: c.total_leads, sent, opened: c.opened_count, replied: c.replied_count, hot: c.hot_count, bounced: c.bounced_count,
            open_rate_pct: pct((c.opened_count as number) ?? 0, sent),
            reply_rate_pct: pct((c.replied_count as number) ?? 0, sent),
          },
          steps: (steps.data ?? []).map((s) => ({ step: s.step_order, wait: s.step_order === 1 ? null : `${s.delay} ${s.delay_unit}`, subject: clip(s.subject as string | null, 120) })),
          lead_status_breakdown: countBy(cls.rows, (r) => r.crm_status),
          temperature_breakdown: countBy(cls.rows.filter((r) => r.lead_temperature), (r) => r.lead_temperature),
          interested_leads: cls.rows.filter((r) => r.interest_status === 1).length,
          draft_breakdown: countBy(drafts.rows, (r) => `step ${r.step_number ?? 1}: ${r.status}`),
          latest_replies: (replies.data ?? [])
            .filter((r) => !employee || one(r.leads as unknown as { assigned_to: string | null } | null)?.assigned_to === caller.userId)
            .map((r) => {
              const l = one(r.leads as unknown as { id: string; first_name: string | null; last_name: string | null; email: string | null } | null);
              return { lead: l ? personName(l.first_name, l.last_name) : null, lead_id: l?.id ?? null, email: l?.email ?? null, at: r.last_reply_at, temperature: r.lead_temperature, reply: clip(r.last_reply_body as string | null, 300) };
            }),
          scope_note: employee ? "Counts cover only your own leads in this campaign." : undefined,
        };
      },
    }),
  };
}
