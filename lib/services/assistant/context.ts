// Who is asking, and the only database handle the assistant's tools may use.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthedUser } from "@/lib/auth/api-auth";
import { missingScopeMessage, type Member, type Scope } from "@/lib/auth/scopes";

/**
 * Every tool runs AS the signed-in user:
 *   - `db` is company-scoped (createScopedClient), so no tool can read another
 *     company's rows whatever the model asks for;
 *   - `scopes` decide which tools exist for them (tools/index.ts) and `member`
 *     their reach (canSeeAll: without leads:all only leads assigned to them),
 *     the same rules lib/auth/scope.ts applies to the rest of the app;
 *   - `token` + `baseUrl` let a confirmed action call the app's own API routes
 *     as this user, so actions get exactly the checks the UI gets.
 */
export type AssistantCaller = {
  userId: string;
  email?: string;
  /** memberScopes(member), as resolved by requireAuth. */
  scopes: Scope[];
  member: Member;
  companyId: string;
  db: SupabaseClient;
  token: string;
  baseUrl: string;
};

/** null when the caller holds every scope in `needed`, else the tool error naming the first one missing. */
export function lacks(caller: AssistantCaller, ...needed: Scope[]): { error: string } | null {
  const missing = needed.find((s) => !caller.scopes.includes(s));
  return missing ? { error: missingScopeMessage(missing) } : null;
}

/** The caller in the shape lib/auth/scope.ts helpers take. */
export function asAuthedUser(c: AssistantCaller): AuthedUser {
  return { id: c.userId, email: c.email, companyId: c.companyId, isOwner: c.member.isOwner, scopes: c.scopes, member: c.member };
}
