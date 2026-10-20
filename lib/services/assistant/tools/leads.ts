import { tool } from "ai";
import { z } from "zod";
import type { AssistantCaller } from "@/lib/services/assistant/context";
import {
  applyLeadFilter, describeLeadFilter, LEAD_STATUSES, leadSelect, LeadFilterSchema, resolveLeadFilter,
} from "@/lib/services/assistant/tools/lead-filter";
import {
  clip, countBy, isUuid, loadTeam, one, personName, readAllPages, teamNameMap, cleanSearch,
} from "@/lib/services/assistant/tools/shared";

const LEAD_COLUMNS = "id, first_name, last_name, email, title, status, city, country, assigned_to, lead_source, created_at";

type LeadRow = {
  id: string; first_name: string | null; last_name: string | null; email: string | null; title: string | null;
  status: string; city: string | null; country: string | null; assigned_to: string | null; lead_source: string | null;
  created_at: string;
  organizations: { name: string | null; industry: string | null; domain: string | null; unsubscribed: boolean | null } | null;
  campaign_leads: Array<{ crm_status?: string; lead_temperature?: string | null; campaigns?: { name: string } | { name: string }[] | null }> | null;
};

export function leadTools(caller: AssistantCaller) {
  return {
    search_leads: tool({
      description:
        "Find leads (people) with filters and get the total count plus up to `limit` rows. Use for any 'which/how many leads…' question. " +
        "The total is exact even when only some rows are returned.",
      inputSchema: LeadFilterSchema.extend({
        limit: z.number().int().min(0).max(100).optional().describe("Rows to return (default 20). Use 0 when only the count matters."),
        sort: z.enum(["newest", "oldest", "name"]).optional(),
      }),
      execute: async ({ limit = 20, sort = "newest", ...filter }) => {
        const resolved = await resolveLeadFilter(caller, filter);
        if ("error" in resolved) return { error: resolved.error };

        if (limit === 0) {
          let cq = caller.db.from("leads").select(leadSelect(filter, resolved, "id", { minimal: true }), { count: "exact", head: true });
          cq = applyLeadFilter(cq, caller, filter, resolved);
          const { count, error } = await cq;
          if (error) return { error: error.message };
          return { filter: describeLeadFilter(filter, resolved), total: count ?? 0, returned: 0, leads: [] };
        }
        let q = caller.db.from("leads").select(leadSelect(filter, resolved, LEAD_COLUMNS), { count: "exact" });
        q = applyLeadFilter(q, caller, filter, resolved);
        if (sort === "name") q = q.order("first_name", { ascending: true });
        else q = q.order("created_at", { ascending: sort === "oldest" });
        const { data, count, error } = await q.range(0, Math.max(limit, 1) - 1);
        if (error) return { error: error.message };

        const team = teamNameMap(await loadTeam(caller.db));
        const rows = ((data ?? []) as unknown as LeadRow[]).slice(0, limit).map((l) => {
          const org = one(l.organizations);
          return {
            id: l.id,
            name: personName(l.first_name, l.last_name),
            title: l.title,
            email: l.email,
            status: l.status,
            company: org?.name ?? null,
            industry: org?.industry ?? null,
            location: [l.city, l.country].filter(Boolean).join(", ") || null,
            assigned_to: l.assigned_to ? team.get(l.assigned_to) ?? "someone" : "unassigned",
            campaigns: (l.campaign_leads ?? [])
              .map((c) => {
                const name = one(c.campaigns)?.name;
                return name ? `${name} (${c.crm_status ?? "?"}${c.lead_temperature ? `, ${c.lead_temperature}` : ""})` : null;
              })
              .filter(Boolean),
            url: `/leads/${l.id}`,
          };
        });
        return {
          filter: describeLeadFilter(filter, resolved),
          total: count ?? rows.length,
          returned: rows.length,
          leads: rows,
        };
      },
    }),

    lead_breakdown: tool({
      description:
        "Count leads grouped by one field (status, assignee, country, industry, source, campaign status, temperature), optionally filtered. " +
        "Use for 'how many leads per X' / distribution questions instead of listing leads.",
      inputSchema: LeadFilterSchema.extend({
        group_by: z.enum(["status", "assigned_to", "country", "industry", "source", "campaign_status", "temperature", "company"]),
        top: z.number().int().min(1).max(50).optional().describe("How many groups to return (default 15)."),
      }),
      execute: async ({ group_by, top = 15, ...filter }) => {
        const resolved = await resolveLeadFilter(caller, filter);
        if ("error" in resolved) return { error: resolved.error };
        // A campaign-level grouping needs the campaign_leads rows, not just presence.
        const f = (group_by === "campaign_status" || group_by === "temperature") && !filter.in_campaign && !resolved.campaignId
          ? { ...filter, in_campaign: "any" as const }
          : filter;
        // Fixed-value groupings are one parallel count per value — far faster
        // than reading every row when there are thousands of leads.
        const ENUM_GROUPS: Partial<Record<typeof group_by, readonly string[]>> = { status: LEAD_STATUSES, source: ["apollo", "excel", "manual"] };
        const values = ENUM_GROUPS[group_by];
        if (values) {
          const column = group_by === "status" ? "status" : "lead_source";
          const counts = await Promise.all(values.map(async (value) => {
            let q = caller.db.from("leads").select(leadSelect(f, resolved, "id", { minimal: true }), { count: "exact", head: true });
            q = applyLeadFilter(q, caller, f, resolved).eq(column, value);
            const { count, error } = await q;
            if (error) throw new Error(error.message);
            return { value, count: count ?? 0 };
          }));
          const groups = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count);
          return {
            filter: describeLeadFilter(f, resolved), group_by,
            total_leads: groups.reduce((s, g) => s + g.count, 0), truncated: false,
            groups: groups.slice(0, top), other_groups: Math.max(0, groups.length - top),
            // Stated, so "none are new/closed" is a fact from the data, not a guess.
            zero_groups: counts.filter((c) => c.count === 0).map((c) => c.value),
          };
        }
        const { rows, truncated } = await readAllPages<LeadRow>((from, to) => {
          let q = caller.db.from("leads").select(leadSelect(f, resolved, "id, status, country, assigned_to, lead_source", {
            minimal: true,
            withOrg: group_by === "industry" || group_by === "company",
            withCampaigns: group_by === "campaign_status" || group_by === "temperature",
          }));
          q = applyLeadFilter(q, caller, f, resolved);
          return q.order("id").range(from, to);
        });
        const team = teamNameMap(await loadTeam(caller.db));
        let groups: Array<{ value: string; count: number }>;
        if (group_by === "campaign_status" || group_by === "temperature") {
          const flat = rows.flatMap((r) => (r.campaign_leads ?? []).map((c) => (group_by === "campaign_status" ? c.crm_status : c.lead_temperature ?? "none")));
          groups = countBy(flat, (v) => v ?? "(none)");
        } else {
          groups = countBy(rows, (r) => {
            switch (group_by) {
              case "status": return r.status;
              case "assigned_to": return r.assigned_to ? team.get(r.assigned_to) ?? "someone" : "unassigned";
              case "country": return r.country;
              case "industry": return one(r.organizations)?.industry;
              case "source": return r.lead_source;
              case "company": return one(r.organizations)?.name;
            }
          });
        }
        return {
          filter: describeLeadFilter(f, resolved),
          group_by,
          total_leads: rows.length,
          truncated,
          groups: groups.slice(0, top),
          other_groups: Math.max(0, groups.length - top),
        };
      },
    }),

    get_lead: tool({
      description:
        "Everything about one lead: contact details, company profile, campaigns and their status, emails sent/replied, latest replies, notes and activity. " +
        "Pass the lead id, or a name/email to look it up.",
      inputSchema: z.object({
        lead: z.string().describe("Lead id, email, or full name."),
      }),
      execute: async ({ lead }) => {
        const v = lead.trim();
        let q = caller.db
          .from("leads")
          .select("id, first_name, last_name, email, email_status, title, headline, seniority, phone, linkedin_url, city, state, country, status, lead_source, assigned_to, created_at, organization_id")
          .eq("is_deleted", false);
        if (caller.role === "employee") q = q.eq("assigned_to", caller.userId);
        if (isUuid(v)) q = q.eq("id", v);
        else if (v.includes("@")) q = q.ilike("email", cleanSearch(v).replace(/ /g, ""));
        else {
          for (const word of cleanSearch(v).split(" ").filter(Boolean).slice(0, 3)) {
            q = q.or(`first_name.ilike.%${word}%,last_name.ilike.%${word}%`);
          }
        }
        const { data: matches } = await q.limit(6);
        if (!matches?.length) return { error: `No lead matches "${v}".` };
        if (matches.length > 1) {
          return {
            ambiguous: true,
            message: `${matches.length >= 6 ? "6+" : matches.length} leads match "${v}". Ask which one.`,
            candidates: matches.map((m) => ({ id: m.id, name: personName(m.first_name, m.last_name), email: m.email, title: m.title })),
          };
        }
        const l = matches[0];
        const [orgRes, clRes, eventsRes, commentsRes, team] = await Promise.all([
          l.organization_id
            ? caller.db.from("organizations").select("id, name, domain, website, industry, employees, city, country, company_description, sells_to, unsubscribed, enrichment_stage").eq("id", l.organization_id).maybeSingle()
            : Promise.resolve({ data: null }),
          caller.db.from("campaign_leads")
            .select("id, crm_status, lead_temperature, interest_status, first_sent_at, opened_at, last_reply_at, last_reply_body, campaigns(id, name, status)")
            .eq("lead_id", l.id),
          caller.db.from("lead_events").select("event, detail, actor_id, created_at").eq("lead_id", l.id).order("created_at", { ascending: false }).limit(12),
          caller.db.from("lead_comments").select("body, author_id, created_at").eq("lead_id", l.id).order("created_at", { ascending: false }).limit(5),
          loadTeam(caller.db),
        ]);
        const names = teamNameMap(team);
        const org = orgRes.data as Record<string, unknown> | null;
        return {
          id: l.id,
          url: `/leads/${l.id}`,
          name: personName(l.first_name, l.last_name),
          title: l.title,
          headline: l.headline,
          seniority: l.seniority,
          email: l.email,
          email_status: l.email_status,
          phone: l.phone,
          linkedin: l.linkedin_url,
          location: [l.city, l.state, l.country].filter(Boolean).join(", ") || null,
          status: l.status,
          source: l.lead_source,
          assigned_to: l.assigned_to ? names.get(l.assigned_to) ?? "someone" : "unassigned",
          added_on: l.created_at,
          // No company page exists to link to — the lead url is the place to see it.
          company: org
            ? {
              id: org.id, name: org.name, domain: org.domain, industry: org.industry, employees: org.employees,
              location: [org.city, org.country].filter(Boolean).join(", ") || null,
              description: clip(org.company_description as string | null, 500),
              sells_to: clip(org.sells_to as string | null, 300),
              unsubscribed: org.unsubscribed,
              website_read: org.enrichment_stage,
            }
            : null,
          campaign_count: (clRes.data ?? []).length,
          campaigns_with_reply: (clRes.data ?? []).filter((c) => c.last_reply_at).length,
          campaigns: (clRes.data ?? []).map((c) => {
            const camp = one(c.campaigns as unknown as { id: string; name: string; status: string } | null);
            return {
              campaign: camp?.name ?? null,
              campaign_id: camp?.id ?? null,
              campaign_state: camp?.status ?? null,
              lead_status_in_campaign: c.crm_status,
              temperature: c.lead_temperature,
              interested: c.interest_status === 1,
              first_email_sent: c.first_sent_at,
              opened: c.opened_at,
              last_reply_at: c.last_reply_at,
              last_reply: clip(c.last_reply_body as string | null, 400),
            };
          }),
          notes: (commentsRes.data ?? []).map((c) => ({ by: names.get(c.author_id as string) ?? "someone", at: c.created_at, text: clip(c.body as string, 300) })),
          recent_activity: (eventsRes.data ?? []).map((e) => ({ event: e.event, detail: clip(e.detail as string | null, 160), by: e.actor_id ? names.get(e.actor_id as string) ?? null : null, at: e.created_at })),
        };
      },
    }),
  };
}
