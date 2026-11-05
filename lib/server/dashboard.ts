import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeadStatusCounts, getLeadMonthlyCounts } from "@/lib/server/leads-count";

const ENRICHED_STATUSES = new Set(["enriching", "enriched", "open", "closed"]);

const STAGE_NAMES = ["New", "Input Required", "Enriched", "Won", "Closed"] as const;
// Theme-aware: a primary ramp (tints mixed into the card colour, so they stay
// readable on white and on near-black), amber for "needs input", muted text
// colour for closed. Rendered as SVG fills / legend swatches on the client.
const STAGE_DONUT_COLORS = [
  "color-mix(in oklab, var(--primary) 35%, var(--card))", // New
  "#f59e0b",                                              // Input Required
  "color-mix(in oklab, var(--primary) 65%, var(--card))", // Enriched
  "var(--primary)",                                       // Won
  "var(--muted-foreground)",                              // Closed
];

function dbStatusToStage(status: string): (typeof STAGE_NAMES)[number] {
  if (status === "input_required") return "Input Required";
  if (status === "enriched" || status === "enriching") return "Enriched";
  if (status === "open") return "Won";
  if (status === "closed") return "Closed";
  return "New";
}

/** The six month buckets the growth chart plots (oldest first) plus the start
 *  of next month as the last bucket's end — in the server's local time, as
 *  before. */
function monthBounds(now = new Date()): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - (5 - i), 1));
}

type DashboardStats = {
  total_leads: number;
  by_status: Record<string, number>;
  monthly: number[];
  temperature: Record<string, number>;
};

/** One `dashboard_stats` call (supabase/migrations/2026_11_05_C_stats_rpcs.sql)
 *  instead of ~15 head counts and a campaign_leads dump. null = the function is
 *  not there (migration not run) or failed: callers use the old queries. */
async function loadDashboardStats(db: SupabaseClient, companyId: string, userId: string | null, bounds: Date[]): Promise<DashboardStats | null> {
  const { data, error } = await db.rpc("dashboard_stats", {
    p_company: companyId,
    p_user: userId,
    p_bounds: bounds.map((d) => d.toISOString()),
  });
  if (error || !data) {
    if (error) console.warn("[dashboard] dashboard_stats unavailable, using the old queries:", error.message);
    return null;
  }
  return data as DashboardStats;
}

function temperatureFrom(map: Record<string, number>): DashboardAnalytics["temperatureBreakdown"] {
  const t = { hot: 0, cold: 0, ooo: 0, unsubscribed: 0, unclassified: 0 };
  for (const [k, n] of Object.entries(map)) {
    if (k === "hot" || k === "cold" || k === "ooo" || k === "unsubscribed") t[k] += n;
    else t.unclassified += n;
  }
  return t;
}

function mapPendingRows(rows: Array<Record<string, unknown>> | null): DashboardAnalytics["pendingReplies"] {
  return (rows ?? []).map((p) => {
    const campaign = Array.isArray(p.campaigns) ? p.campaigns[0] : p.campaigns;
    const event = Array.isArray(p.reply_events) ? p.reply_events[0] : p.reply_events;
    return {
      id: p.id as string,
      campaignId: p.campaign_id as string,
      campaignName: (campaign as { name?: string } | null)?.name ?? "Unknown campaign",
      leadEmail: (event as { lead_email?: string | null } | null)?.lead_email ?? null,
      preview: ((event as { reply_body?: string | null } | null)?.reply_body ?? "").slice(0, 100),
      createdAt: p.created_at as string,
    };
  });
}

/** Status / month / temperature numbers → the dashboard shape. */
function buildAnalytics(
  stats: DashboardStats,
  bounds: Date[],
  pendingReplies: DashboardAnalytics["pendingReplies"],
  totalLeads: number,
): DashboardAnalytics {
  let enrichedLeads = 0;
  const stageCounts: Record<(typeof STAGE_NAMES)[number], number> = {
    New: 0, "Input Required": 0, Enriched: 0, Won: 0, Closed: 0,
  };
  for (const [status, n] of Object.entries(stats.by_status)) {
    if (ENRICHED_STATUSES.has(status)) enrichedLeads += n;
    stageCounts[dbStatusToStage(status)] += n;
  }
  const monthLabels = bounds.slice(0, -1).map((d) => d.toLocaleDateString("en-US", { month: "short" }));
  let cumulative = 0;
  const pipelineGrowth = monthLabels.map((label, i) => {
    cumulative += stats.monthly[i] ?? 0;
    return { month: label, leads: cumulative };
  });
  return {
    temperatureBreakdown: temperatureFrom(stats.temperature),
    pendingReplies,
    totalLeads,
    leadsThisMonth: stats.monthly[stats.monthly.length - 1] ?? 0,
    enrichedLeads,
    pipelineGrowth,
    stageDonutData: STAGE_NAMES
      .map((name, i) => ({ name, value: stageCounts[name], color: STAGE_DONUT_COLORS[i] }))
      .filter((d) => d.value > 0),
  };
}

const PENDING_SELECT = `
  id, subject, created_at, campaign_id,
  campaigns:campaign_id ( name ),
  reply_events:reply_event_id ( lead_email, reply_body )
`;

/** Manager dashboard: 2 requests (stats RPC + the 8 newest pending replies). */
export async function getDashboardAnalytics(db: SupabaseClient, companyId?: string | null): Promise<DashboardAnalytics> {
  if (!companyId) return legacyDashboardAnalytics(db);
  const bounds = monthBounds();
  const [stats, { data: pending }] = await Promise.all([
    loadDashboardStats(db, companyId, null, bounds),
    db.from("reply_drafts").select(PENDING_SELECT).eq("status", "draft").order("created_at", { ascending: false }).limit(8),
  ]);
  if (!stats) return legacyDashboardAnalytics(db);
  return buildAnalytics(stats, bounds, mapPendingRows(pending as never), stats.total_leads);
}

/**
 * Employee-scoped dashboard (planning.md Phase 7 / Q9): the same shape as the
 * manager view, but every number derives from what the employee can actually
 * see — their assigned leads, plus campaigns they created or were assigned.
 * Temperature comes from the DB now, so it is no longer capped at 1,000 rows.
 */
export async function getEmployeeDashboard(db: SupabaseClient, userId: string, companyId?: string | null): Promise<DashboardAnalytics> {
  if (!companyId) return legacyEmployeeDashboard(db, userId);
  const bounds = monthBounds();
  const [stats, { data: accessibleCampaigns }] = await Promise.all([
    loadDashboardStats(db, companyId, userId, bounds),
    db.from("campaigns").select("id").eq("is_deleted", false).or(`created_by.eq.${userId},assigned_to.eq.${userId}`),
  ]);
  if (!stats) return legacyEmployeeDashboard(db, userId);
  const campaignIds = (accessibleCampaigns ?? []).map((c) => c.id as string);

  // Pending replies: drafts in campaigns they can work, plus drafts on threads
  // of their own leads (joined, not an id list — no 1,000-row / URL cap). The
  // old code asked for "own-lead rows outside my campaigns"; asking for all
  // own-lead rows gives the same top 8 after the merge below.
  const [{ data: inMine }, { data: ofMine }] = await Promise.all([
    campaignIds.length > 0
      ? db.from("reply_drafts").select(PENDING_SELECT).eq("status", "draft").in("campaign_id", campaignIds)
          .order("created_at", { ascending: false }).limit(8)
      : Promise.resolve({ data: [] as unknown[] }),
    db.from("reply_drafts").select(`${PENDING_SELECT}, campaign_leads!campaign_lead_id!inner(leads!lead_id!inner(assigned_to))`)
      .eq("status", "draft").eq("campaign_leads.leads.assigned_to", userId)
      .order("created_at", { ascending: false }).limit(8),
  ]);
  const byId = new Map<string, DashboardAnalytics["pendingReplies"][number]>();
  for (const r of [...mapPendingRows(inMine as never), ...mapPendingRows(ofMine as never)]) byId.set(r.id, r);
  const pendingReplies = [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);

  const totalLeads = Object.values(stats.by_status).reduce((a, b) => a + b, 0);
  return buildAnalytics(stats, bounds, pendingReplies, totalLeads);
}

export type DashboardAnalytics = {
  temperatureBreakdown: { hot: number; cold: number; ooo: number; unsubscribed: number; unclassified: number };
  pendingReplies: Array<{
    id: string;
    campaignId: string;
    campaignName: string;
    leadEmail: string | null;
    preview: string;
    createdAt: string;
  }>;
  totalLeads: number;
  /** Leads created in the CURRENT calendar month. The Monthly Goals card was
   *  measuring an all-time total against a monthly target, so it read
   *  "1000/50" and pinned at 100% forever. */
  leadsThisMonth: number;
  enrichedLeads: number;
  pipelineGrowth: Array<{ month: string; leads: number }>;
  stageDonutData: Array<{ name: string; value: number; color: string }>;
};

async function legacyDashboardAnalytics(db: SupabaseClient): Promise<DashboardAnalytics> {
  const now = new Date();
  // The six month buckets the growth chart plots, oldest first.
  const monthStarts = Array.from({ length: 6 }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth() - (5 - i), 1),
  );

  const [
    { count: totalLeads },
    { data: tempRows },
    { data: pending },
    statusRows,
    monthlyLeadCounts,
  ] = await Promise.all([
    db.from("leads").select("id", { count: "exact", head: true }).eq("is_deleted", false),
    db.from("campaign_leads").select("lead_temperature"),
    db
      .from("reply_drafts")
      .select(`
        id, subject, created_at, campaign_id,
        campaigns:campaign_id ( name ),
        reply_events:reply_event_id ( lead_email, reply_body )
      `)
      .eq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(8),
    getLeadStatusCounts(db),
    getLeadMonthlyCounts(db, monthStarts),
  ]);

  const temperatureBreakdown = { hot: 0, cold: 0, ooo: 0, unsubscribed: 0, unclassified: 0 };
  for (const row of tempRows ?? []) {
    const t = row.lead_temperature;
    if (t === "hot") temperatureBreakdown.hot++;
    else if (t === "cold") temperatureBreakdown.cold++;
    else if (t === "ooo") temperatureBreakdown.ooo++;
    else if (t === "unsubscribed") temperatureBreakdown.unsubscribed++;
    else temperatureBreakdown.unclassified++;
  }

  const pendingReplies = (pending ?? []).map((p) => {
    const campaign = Array.isArray(p.campaigns) ? p.campaigns[0] : p.campaigns;
    const event = Array.isArray(p.reply_events) ? p.reply_events[0] : p.reply_events;
    return {
      id: p.id,
      campaignId: p.campaign_id,
      campaignName: (campaign as { name?: string } | null)?.name ?? "Unknown campaign",
      leadEmail: (event as { lead_email?: string | null } | null)?.lead_email ?? null,
      preview: ((event as { reply_body?: string | null } | null)?.reply_body ?? "").slice(0, 100),
      createdAt: p.created_at,
    };
  });

  let enrichedLeads = 0;
  const stageCounts: Record<(typeof STAGE_NAMES)[number], number> = {
    New: 0,
    "Input Required": 0,
    Enriched: 0,
    Won: 0,
    Closed: 0,
  };

  // statusRows is now a {status: count} map from the database, not a row dump
  // that PostgREST silently truncated at 1,000 (which is why this panel and the
  // Kanban board disagreed on the same account).
  for (const [status, n] of Object.entries(statusRows ?? {}) as [string, number][]) {
    if (ENRICHED_STATUSES.has(status)) enrichedLeads += n;
    stageCounts[dbStatusToStage(status)] += n;
  }

  const monthLabels = monthStarts.map((d) => d.toLocaleDateString("en-US", { month: "short" }));
  let cumulative = 0;
  const pipelineGrowth = monthLabels.map((label, i) => {
    cumulative += monthlyLeadCounts[i] ?? 0;
    return { month: label, leads: cumulative };
  });

  const stageDonutData = STAGE_NAMES
    .map((name, i) => ({
      name,
      value: stageCounts[name],
      color: STAGE_DONUT_COLORS[i],
    }))
    .filter((d) => d.value > 0);

  return {
    temperatureBreakdown,
    pendingReplies,
    totalLeads: totalLeads ?? 0,
    leadsThisMonth: monthlyLeadCounts[monthlyLeadCounts.length - 1] ?? 0,
    enrichedLeads,
    pipelineGrowth,
    stageDonutData,
  };
}

/**
 * Employee-scoped dashboard (planning.md Phase 7 / Q9): the same shape as the
 * manager view, but every number derives from what the employee can actually
 * see — their assigned leads, plus campaigns they created or were assigned.
 */
async function legacyEmployeeDashboard(db: SupabaseClient, userId: string): Promise<DashboardAnalytics> {
  const now = new Date();
  const monthStarts = Array.from({ length: 6 }, (_, i) =>
    new Date(now.getFullYear(), now.getMonth() - (5 - i), 1),
  );

  const { data: accessibleCampaigns } = await db
    .from("campaigns")
    .select("id")
    .eq("is_deleted", false)
    .or(`created_by.eq.${userId},assigned_to.eq.${userId}`);

  const campaignIds = (accessibleCampaigns ?? []).map((c) => c.id as string);

  // Campaign-lead rows in scope: my campaigns' rows ∪ rows of my leads.
  const clById = new Map<string, { id: string; lead_temperature: string | null; campaign_id: string | null }>();
  if (campaignIds.length > 0) {
    const { data } = await db.from("campaign_leads")
      .select("id, lead_temperature, campaign_id")
      .in("campaign_id", campaignIds);
    for (const r of data ?? []) clById.set(r.id as string, r as never);
  }
  // Filtered by joining leads, not by feeding an `.in()` a list of this
  // employee's lead ids. That list came from a plain select, which PostgREST
  // caps at 1,000 rows without erroring — an employee holding 1,769 leads lost
  // every campaign_lead row belonging to lead 1,001 onward, so their
  // temperature breakdown and pending replies quietly under-reported. Same
  // inner-join filter the campaigns route already uses.
  {
    const { data } = await db.from("campaign_leads")
      .select("id, lead_temperature, campaign_id, leads!lead_id!inner(assigned_to)")
      .eq("leads.assigned_to", userId);
    for (const r of data ?? []) clById.set(r.id as string, r as never);
  }
  // ponytail: clRows is still a JS tally over a fetch — fine at today's volume,
  // but it caps at 1,000 campaign_lead rows. Move to head-counts per temperature
  // if a single employee ever exceeds that many campaign leads.
  const clRows = [...clById.values()];

  const temperatureBreakdown = { hot: 0, cold: 0, ooo: 0, unsubscribed: 0, unclassified: 0 };
  for (const row of clRows) {
    const t = row.lead_temperature;
    if (t === "hot") temperatureBreakdown.hot++;
    else if (t === "cold") temperatureBreakdown.cold++;
    else if (t === "ooo") temperatureBreakdown.ooo++;
    else if (t === "unsubscribed") temperatureBreakdown.unsubscribed++;
    else temperatureBreakdown.unclassified++;
  }

  // Pending replies for campaigns they can work, or threads of their own leads.
  const pendingById = new Map<string, DashboardAnalytics["pendingReplies"][number]>();
  const mapPending = (rows: Array<Record<string, unknown>> | null) => {
    for (const p of rows ?? []) {
      const campaign = Array.isArray(p.campaigns) ? p.campaigns[0] : p.campaigns;
      const event = Array.isArray(p.reply_events) ? p.reply_events[0] : p.reply_events;
      pendingById.set(p.id as string, {
        id: p.id as string,
        campaignId: p.campaign_id as string,
        campaignName: (campaign as { name?: string } | null)?.name ?? "Unknown campaign",
        leadEmail: (event as { lead_email?: string | null } | null)?.lead_email ?? null,
        preview: ((event as { reply_body?: string | null } | null)?.reply_body ?? "").slice(0, 100),
        createdAt: p.created_at as string,
      });
    }
  };

  const pendingSelect = `
    id, subject, created_at, campaign_id, campaign_lead_id,
    campaigns:campaign_id ( name ),
    reply_events:reply_event_id ( lead_email, reply_body )
  `;
  if (campaignIds.length > 0) {
    const { data } = await db.from("reply_drafts")
      .select(pendingSelect)
      .eq("status", "draft")
      .in("campaign_id", campaignIds)
      .order("created_at", { ascending: false })
      .limit(8);
    mapPending(data as never);
  }
  const myClIds = clRows.filter((r) => r.campaign_id && !campaignIds.includes(r.campaign_id)).map((r) => r.id);
  if (myClIds.length > 0) {
    const { data } = await db.from("reply_drafts")
      .select(pendingSelect)
      .eq("status", "draft")
      .in("campaign_lead_id", myClIds)
      .order("created_at", { ascending: false })
      .limit(8);
    mapPending(data as never);
  }
  const pendingReplies = [...pendingById.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);

  // Counted by the database, not tallied from `myLeads` — that fetch is capped
  // at 1,000 rows by PostgREST with no error, and this employee already holds
  // 999. One more lead and every number on their dashboard would have started
  // silently under-reporting.
  const [statusCounts, monthlyLeadCounts] = await Promise.all([
    getLeadStatusCounts(db, { assignedTo: userId }),
    getLeadMonthlyCounts(db, monthStarts, { assignedTo: userId }),
  ]);

  let enrichedLeads = 0;
  const stageCounts: Record<(typeof STAGE_NAMES)[number], number> = {
    New: 0, "Input Required": 0, Enriched: 0, Won: 0, Closed: 0,
  };
  for (const [status, n] of Object.entries(statusCounts) as [string, number][]) {
    if (ENRICHED_STATUSES.has(status)) enrichedLeads += n;
    stageCounts[dbStatusToStage(status)] += n;
  }

  const monthLabels = monthStarts.map((d) => d.toLocaleDateString("en-US", { month: "short" }));
  let cumulative = 0;
  const pipelineGrowth = monthLabels.map((label, i) => {
    cumulative += monthlyLeadCounts[i] ?? 0;
    return { month: label, leads: cumulative };
  });

  const stageDonutData = STAGE_NAMES
    .map((name, i) => ({ name, value: stageCounts[name], color: STAGE_DONUT_COLORS[i] }))
    .filter((d) => d.value > 0);

  return {
    temperatureBreakdown,
    pendingReplies,
    // NOT myLeadIds.length — that array is the same PostgREST fetch the comment
    // above warns about, silently capped at 1,000 rows, which is exactly why an
    // employee past 1k leads saw a flat "1000". statusCounts is DB-counted.
    totalLeads: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    leadsThisMonth: monthlyLeadCounts[monthlyLeadCounts.length - 1] ?? 0,
    enrichedLeads,
    pipelineGrowth,
    stageDonutData,
  };
}
