import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

/**
 * Service-role client — bypasses RLS. Only use in server-side route handlers.
 *
 * One shared client per server instance: a service-role client holds no
 * per-user session (server code only calls `auth.admin.*` on it), so sharing it
 * across concurrent requests is safe. `autoRefreshToken: false` matters: with
 * the default, every client started a 30 s refresh timer that was never
 * cleared, so a client built per call leaked for the life of the instance.
 */
export function createAdminClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
  }
  return client;
}
