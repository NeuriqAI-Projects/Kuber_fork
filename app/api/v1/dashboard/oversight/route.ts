import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);

  // Per-employee counts come from one GROUP BY (team_oversight_counts,
  // supabase/migrations/2026_11_05_C_stats_rpcs.sql). The old way downloaded
  // every campaign_leads row — capped at 1,000 by PostgREST, so campaign counts
  // were too low — plus one head-count per employee.
  const [{ data: campaigns, error: campaignsError }, { data: profiles }, rpc] = await Promise.all([
    db
      .from("campaigns")
      .select("id, name, status, created_by, total_leads, sent_count, opened_count, replied_count, hot_count, created_at")
      .eq("is_deleted", false)
      .order("created_at", { ascending: false }),
    db.from("profiles").select("id, email, full_name, role, territory_countries, is_active, availability_status, is_super_admin"),
    user.companyId
      ? db.rpc("team_oversight_counts", { p_company: user.companyId })
      : Promise.resolve({ data: null, error: { message: "no company" } }),
  ]);

  if (campaignsError) return fail(500, "INTERNAL", campaignsError.message);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));
  const assignedLeadCounts = new Map<string, number>();
  const campaignCounts = new Map<string, number>();
  if (!rpc.error && rpc.data) {
    for (const r of rpc.data as Array<{ user_id: string; assigned_lead_count: number; campaign_count: number }>) {
      assignedLeadCounts.set(r.user_id, Number(r.assigned_lead_count));
      campaignCounts.set(r.user_id, Number(r.campaign_count));
    }
  } else {
    // Function missing (migration not run): the old per-employee counts.
    console.warn("[oversight] team_oversight_counts unavailable, using the old queries:", rpc.error?.message);
    await legacyCounts(db, profiles ?? [], new Set((campaigns ?? []).map((c) => c.id as string)), assignedLeadCounts, campaignCounts);
  }

  const campaignsWithOwner = (campaigns ?? []).map((c) => ({
    ...c,
    owner: profileMap.get(c.created_by) ?? null,
  }));

  const employees = (profiles ?? [])
    .filter((p) => p.role === "employee")
    .map((p) => ({
      ...p,
      assigned_lead_count: assignedLeadCounts.get(p.id) ?? 0,
      campaign_count: campaignCounts.get(p.id) ?? 0,
    }));

  return ok({ campaigns: campaignsWithOwner, employees });
}

/** The pre-RPC counting, kept as the fallback. Its campaign count reads the
 *  campaign_leads rows, which PostgREST caps at 1,000. */
async function legacyCounts(
  db: ReturnType<typeof dbForUser>,
  profiles: Array<{ id: string; role: string }>,
  liveCampaignIds: Set<string>,
  assignedLeadCounts: Map<string, number>,
  campaignCounts: Map<string, number>,
) {
  const employeeIds = profiles.filter((p) => p.role === "employee").map((p) => p.id);
  const [{ data: memberships }, counted] = await Promise.all([
    db.from("campaign_leads").select("campaign_id, leads!lead_id!inner(assigned_to, is_deleted)").eq("leads.is_deleted", false),
    Promise.all(employeeIds.map(async (id) => {
      const { count } = await db.from("leads").select("id", { count: "exact", head: true }).eq("assigned_to", id).eq("is_deleted", false);
      return [id, count ?? 0] as const;
    })),
  ]);
  for (const [id, n] of counted) assignedLeadCounts.set(id, n);
  const byEmployee = new Map<string, Set<string>>();
  for (const m of memberships ?? []) {
    const owner = (m.leads as { assigned_to?: string | null } | null)?.assigned_to;
    if (!owner || !m.campaign_id || !liveCampaignIds.has(m.campaign_id as string)) continue;
    if (!byEmployee.has(owner)) byEmployee.set(owner, new Set());
    byEmployee.get(owner)!.add(m.campaign_id as string);
  }
  for (const [id, set] of byEmployee) campaignCounts.set(id, set.size);
}
