import { NextRequest } from "next/server";
import { requireScope } from "@/lib/auth/api-auth";
import { canGrant, isLeadOwner, parseScopes } from "@/lib/auth/scopes";
import { ok, fail } from "@/lib/api-response";
import { CreateUserSchema } from "@/lib/validators/users";
import { canonicalCountryList } from "@/lib/territory";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireScope>>;
  try { user = await requireScope(req, "team:read"); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name, territory_countries, is_active, availability_status, sending_email, created_at, is_owner, scopes")
    .order("created_at", { ascending: true });

  if (error) return fail(500, "INTERNAL", error.message);
  return ok(data ?? []);
}

export async function POST(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireScope>>;
  try { caller = await requireScope(req, "team:write"); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { email, password, full_name, territory_countries } = parsed.data;

  const scopes = parseScopes(parsed.data.scopes);
  if (!scopes.ok) return fail(400, "VALIDATION_ERROR", scopes.error);
  // No escalation (lib/auth/scopes.ts canGrant): a non-owner may only hand out
  // scopes they hold themselves, and only the owner gives out team:write — the
  // old "only the Super Admin creates managers" rule.
  const verdict = canGrant(caller.member, { id: "new", isOwner: false, active: true, scopes: [] }, scopes.scopes);
  if (!verdict.ok) return fail(403, "FORBIDDEN", verdict.error);
  const leadOwner = isLeadOwner({ id: "new", isOwner: false, active: true, scopes: scopes.scopes });

  const db = dbForUser(caller);

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) {
    return fail(400, "USER_CREATE_FAILED", createError?.message ?? "Could not create user");
  }

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .insert({
      id: created.user.id,
      email,
      full_name,
      scopes: scopes.scopes,
      territory_countries: leadOwner ? canonicalCountryList(territory_countries) : [],
      is_active: true,
    })
    .select("id, email, full_name, territory_countries, is_active, availability_status, sending_email, created_at, is_owner, scopes")
    .single();

  if (profileError) {
    await db.auth.admin.deleteUser(created.user.id);
    return fail(500, "INTERNAL", profileError.message);
  }

  return ok(profile);
}
