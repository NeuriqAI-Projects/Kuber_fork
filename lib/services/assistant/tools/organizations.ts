import { tool } from "ai";
import { z } from "zod";
import { can, canSeeAll } from "@/lib/auth/scopes";
import { lacks, type AssistantCaller } from "@/lib/services/assistant/context";
import { cleanSearch, clip, ilikeValue, isUuid, loadTeam, personName, teamNameMap } from "@/lib/services/assistant/tools/shared";

export function organizationTools(caller: AssistantCaller) {
  return {
    search_organizations: tool({
      description:
        "Find companies (organizations) by name, industry or country, with how many leads each has. " +
        "Use for 'which companies…' questions. For people use search_leads.",
      inputSchema: z.object({
        name: z.string().optional().describe("Company name contains."),
        industry: z.string().optional(),
        country: z.string().optional(),
        website_read: z.enum(["done", "failed", "queued", "scraping"]).optional().describe("Website enrichment stage."),
        limit: z.number().int().min(0).max(50).optional().describe("Rows to return (default 15)."),
      }),
      execute: async ({ name, industry, country, website_read, limit = 15 }) => {
        const denied = lacks(caller, "leads:read");
        if (denied) return denied;
        // Without organizations:read a member only sees companies that hold one of
        // the leads they can see (their own, unless they hold leads:all).
        const orgAll = can(caller, "organizations:read");
        const leadsAll = canSeeAll(caller.member, "leads");
        let q = caller.db
          .from("organizations")
          .select(
            orgAll
              ? "id, name, domain, industry, employees, country, enrichment_stage, unsubscribed, leads(count)"
              : "id, name, domain, industry, employees, country, enrichment_stage, unsubscribed, leads!inner(id, assigned_to, is_deleted)",
            { count: "exact" },
          );
        if (!orgAll) q = q.eq("leads.is_deleted", false);
        // Lead counts only cover the leads the caller can see.
        if (!leadsAll) q = q.eq("leads.assigned_to", caller.userId).eq("leads.is_deleted", false);
        if (name) q = q.ilike("name", `%${ilikeValue(name)}%`);
        if (industry) q = q.ilike("industry", `%${ilikeValue(industry)}%`);
        if (country) q = q.ilike("country", `%${ilikeValue(country)}%`);
        if (website_read) q = q.eq("enrichment_stage", website_read);
        const { data, count, error } = await q.order("created_at", { ascending: false }).range(0, Math.max(limit, 1) - 1);
        if (error) return { error: error.message };
        return {
          total: count ?? 0,
          companies: (data ?? []).slice(0, limit).map((o) => {
            const leads = (o as { leads?: Array<{ count?: number }> }).leads ?? [];
            return {
              id: o.id, name: o.name, domain: o.domain, industry: o.industry, employees: o.employees, country: o.country,
              website_read: o.enrichment_stage, unsubscribed: o.unsubscribed,
              leads: orgAll ? leads[0]?.count ?? 0 : leads.length,
            };
          }),
        };
      },
    }),

    get_organization: tool({
      description: "One company in full: what it does, who it sells to, size, website status, and its leads with their status.",
      inputSchema: z.object({ organization: z.string().describe("Company id, name or domain.") }),
      execute: async ({ organization }) => {
        const denied = lacks(caller, "leads:read");
        if (denied) return denied;
        const v = organization.trim();
        const orgAll = can(caller, "organizations:read");
        const leadsAll = canSeeAll(caller.member, "leads");
        // Without organizations:read the match itself is limited to companies holding
        // a lead the caller can see, so the "several match" list never names others.
        const cols = "id, name, domain, website, industry, keywords, employees, city, country, company_description, sells_to, unsubscribed, enrichment_stage, last_error, created_at";
        // The extra inner join only narrows rows; typed as the plain column list.
        let q = caller.db.from("organizations").select((orgAll ? cols : `${cols}, leads!inner(id)`) as typeof cols);
        if (!orgAll) q = q.eq("leads.is_deleted", false);
        if (!orgAll && !leadsAll) q = q.eq("leads.assigned_to", caller.userId);
        if (isUuid(v)) q = q.eq("id", v);
        else q = q.or(`name.ilike.%${cleanSearch(v)}%,domain.ilike.%${cleanSearch(v)}%`);
        const { data: orgs } = await q.limit(5);
        if (!orgs?.length) return { error: `No company matches "${v}".` };
        const exact = orgs.filter((o) => (o.name as string)?.toLowerCase() === v.toLowerCase() || o.domain === v.toLowerCase());
        if (orgs.length > 1 && exact.length !== 1) {
          return { ambiguous: true, message: `Several companies match "${v}". Ask which one.`, candidates: orgs.map((o) => ({ id: o.id, name: o.name, domain: o.domain, country: o.country })) };
        }
        const o = exact[0] ?? orgs[0];
        let lq = caller.db.from("leads").select("id, first_name, last_name, title, email, status, assigned_to").eq("organization_id", o.id).eq("is_deleted", false);
        if (!leadsAll) lq = lq.eq("assigned_to", caller.userId);
        const [{ data: leads }, team] = await Promise.all([lq.limit(30), loadTeam(caller.db)]);
        const names = teamNameMap(team);
        return {
          id: o.id, name: o.name, domain: o.domain, website: o.website, industry: o.industry,
          keywords: Array.isArray(o.keywords) ? (o.keywords as string[]).slice(0, 12) : [],
          employees: o.employees, location: [o.city, o.country].filter(Boolean).join(", ") || null,
          description: clip(o.company_description as string | null, 800),
          sells_to: clip(o.sells_to as string | null, 400),
          unsubscribed: o.unsubscribed, website_read: o.enrichment_stage,
          website_error: clip(o.last_error as string | null, 160),
          leads: (leads ?? []).map((l) => ({
            id: l.id, name: personName(l.first_name, l.last_name), title: l.title, email: l.email, status: l.status,
            assigned_to: l.assigned_to ? names.get(l.assigned_to) ?? "someone" : "unassigned", url: `/leads/${l.id}`,
          })),
        };
      },
    }),
  };
}
