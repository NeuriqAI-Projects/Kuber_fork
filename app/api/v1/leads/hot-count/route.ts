import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { canSeeAll } from "@/lib/auth/scopes";
import { ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "leads:read"); } catch (r) { return r as Response; }
  const db = dbForUser(user);

  // Members without leads:all only count hot leads assigned to them; with it, all.
  const q = !canSeeAll(user.member, "leads")
    ? db.from("campaign_leads")
        .select("id, leads!lead_id!inner(assigned_to)", { count: "exact", head: true })
        .eq("lead_temperature", "hot")
        .eq("leads.assigned_to", user.id)
    : db.from("campaign_leads")
        .select("id", { count: "exact", head: true })
        .eq("lead_temperature", "hot");

  const { count } = await q;
  return ok({ hotCount: count ?? 0 });
}
