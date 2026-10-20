// Who is asking, and the only database handle the assistant's tools may use.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "@/lib/auth/roles";

/**
 * Every tool runs AS the signed-in user:
 *   - `db` is company-scoped (createScopedClient), so no tool can read another
 *     company's rows whatever the model asks for;
 *   - `role` decides the employee filter (only leads assigned to them), the
 *     same rule lib/auth/scope.ts applies to the rest of the app;
 *   - `token` + `baseUrl` let a confirmed action call the app's own API routes
 *     as this user, so actions get exactly the checks the UI gets.
 */
export type AssistantCaller = {
  userId: string;
  email?: string;
  role: AppRole;
  companyId: string;
  db: SupabaseClient;
  token: string;
  baseUrl: string;
};

export const isManager = (c: AssistantCaller) => c.role === "manager";
