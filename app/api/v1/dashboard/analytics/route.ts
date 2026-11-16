import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { ok } from "@/lib/api-response";
import { getDashboardAnalytics, getEmployeeDashboard } from "@/lib/server/dashboard";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// Members with dashboard:all see company-wide analytics; others get the same
// shape scoped to their own leads and campaigns (planning.md Phase 7 — previously a 403).
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "dashboard:read"); } catch (r) { return r as Response; }
  const db = dbForUser(user);
  const analytics = canSeeAll(user.member, "dashboard")
    ? await getDashboardAnalytics(db, user.companyId)
    : await getEmployeeDashboard(db, user.id, user.companyId);
  return ok(analytics);
}
