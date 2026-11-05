import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { getLeadStatusCounts } from "@/lib/server/leads-count";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  // ?orgs=1: how many organizations have a lead this user sees (the Organization list's "N of M").
  // One head count over the inner join: no rows come back.
  if (new URL(req.url).searchParams.get("orgs") === "1") {
    let oq = db.from("organizations").select("id, leads!inner(id)", { count: "exact", head: true })
      .eq("leads.is_deleted", false).not("leads.email", "is", null);
    if (user.role === "employee") oq = oq.eq("leads.assigned_to", user.id);
    const { count, error } = await oq;
    if (error) return fail(500, "INTERNAL", error.message);
    return ok({ orgs: count ?? 0 });
  }
  // Per-stage totals for the Kanban column headers. The board used to count the
  // ~500 rows the browser had loaded, so the same account showed 999 leads on
  // the Dashboard and 500 across the board's five columns.
  // Same visibility rule as GET /leads (revealed only; employees: their own).
  const byStatus = await getLeadStatusCounts(db, {
    assignedTo: user.role === "employee" ? user.id : undefined,
  });
  // `status` is a NOT NULL enum of exactly these 6 values, so the old 7th
  // exact count (same filters, no status) always equalled this sum.
  const count = Object.values(byStatus).reduce((a, n) => a + n, 0);
  return ok({ total: count, by_status: byStatus });
}
