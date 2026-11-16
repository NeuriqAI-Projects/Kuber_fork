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
  const companyView = canSeeAll(user.member, "dashboard");
  const analytics = companyView
    ? await getDashboardAnalytics(db, user.companyId)
    : await getEmployeeDashboard(db, user.id, user.companyId);
  // The pending-replies card shows reply text (Unibox content): it needs unibox:read,
  // and the company-wide list needs unibox:all too (security review 16 Nov 2026).
  // Both templates hold what they need, so nobody loses the card today.
  const seesReplies = user.scopes.includes("unibox:read") && (!companyView || canSeeAll(user.member, "unibox"));
  return ok(seesReplies ? analytics : { ...analytics, pendingReplies: [] });
}
