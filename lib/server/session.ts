import { cache } from "react";
import { redirect } from "next/navigation";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { isAppUser } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createScopedClient } from "@/lib/supabase/scoped";

/** Cookie session validated via getUser — redirects if not a provisioned manager/employee. */
export async function requireAppSession(): Promise<Session> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user || !isAppUser(user)) {
    redirect("/");
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/");

  return session;
}

/**
 * Session, role and a COMPANY-SCOPED client for server components.
 *
 * Server components fetch their own data and never pass through the API layer's
 * requireAuth, so without this they would run on the unscoped admin client and
 * render every tenant's rows. Anything a page renders should come from the `db`
 * returned here.
 */
// Wrapped in React cache(): the (app) layout and the page both call this in the
// same request, and each call is a getUser + getSession + profiles round trip.
// cache() dedupes per request only — every request still runs the full check.
export const requireAppSessionContext = cache(async function requireAppSessionContext(): Promise<{
  session: Session;
  userId: string;
  role: "manager" | "employee";
  companyId: string;
  db: SupabaseClient;
}> {
  const session = await requireAppSession();
  const { data: profile } = await createAdminClient()
    .from("profiles")
    .select("role, is_active, company_id")
    .eq("id", session.user.id)
    .maybeSingle();

  if (!profile || !profile.is_active || !profile.company_id) redirect("/");

  return {
    session,
    userId: session.user.id,
    role: profile.role as "manager" | "employee",
    companyId: profile.company_id as string,
    db: createScopedClient(profile.company_id as string),
  };
});

/**
 * Server guard for manager-only pages. Resolves the role from `profiles`
 * (the same authoritative source as the API's requireAuth), so a demoted user
 * loses access immediately. Redirects employees to /dashboard.
 */
export async function requireManagerSession(): Promise<Session> {
  const session = await requireAppSession();
  const db = createAdminClient();
  const { data: profile } = await db
    .from("profiles")
    .select("role, is_active")
    .eq("id", session.user.id)
    .maybeSingle();
  if (!profile || !profile.is_active || profile.role !== "manager") {
    redirect("/dashboard");
  }
  return session;
}
