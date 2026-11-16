import { cache } from "react";
import { redirect } from "next/navigation";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";
import { memberScopes, type Member, type Scope } from "@/lib/auth/scopes";

/** What the browser gets to decide what to show (AccessProvider). Never read from the JWT. */
export type MemberAccess = { id: string; isOwner: boolean; active: boolean; scopes: Scope[]; companyId: string };

/**
 * The caller's profile as a Member, or null when they are not a provisioned,
 * active member of a company. "Provisioned" is the profile row — not the JWT.
 */
export async function loadMemberAccess(userId: string): Promise<MemberAccess | null> {
  const { data: profile } = await createAdminClient()
    .from("profiles")
    .select("is_active, is_owner, scopes, company_id")
    .eq("id", userId)
    .maybeSingle();
  if (!profile || !profile.is_active || !profile.company_id) return null;
  const member: Member = { id: userId, isOwner: !!profile.is_owner, active: true, scopes: (profile.scopes as string[] | null) ?? [] };
  return { id: userId, isOwner: member.isOwner, active: true, scopes: memberScopes(member), companyId: profile.company_id as string };
}

/**
 * Session, access and a COMPANY-SCOPED client for server components.
 *
 * Server components fetch their own data and never pass through the API layer's
 * requireAuth, so without this they would run on the unscoped admin client and
 * render every tenant's rows. Anything a page renders should come from the `db`
 * returned here. Redirects to the login page unless the caller is an active member.
 */
// Wrapped in React cache(): the (app) layout and the page both call this in the
// same request, and each call is a getUser + getSession + profiles round trip.
// cache() dedupes per request only — every request still runs the full check.
export const requireAppSessionContext = cache(async function requireAppSessionContext(): Promise<{
  session: Session;
  userId: string;
  access: MemberAccess;
  member: Member;
  companyId: string;
  db: SupabaseClient;
}> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) redirect("/");

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/");

  const access = await loadMemberAccess(user.id);
  if (!access) redirect("/");

  return {
    session,
    userId: user.id,
    access,
    member: { id: user.id, isOwner: access.isOwner, active: true, scopes: access.scopes },
    companyId: access.companyId,
    db: createScopedClient(access.companyId),
  };
});

/** Server page guard: redirects to /settings (open to every member, so no redirect loop) unless the caller holds `scope`. */
export async function requirePageScope(scope: Scope) {
  const ctx = await requireAppSessionContext();
  if (!ctx.access.scopes.includes(scope)) redirect("/settings");
  return ctx;
}
