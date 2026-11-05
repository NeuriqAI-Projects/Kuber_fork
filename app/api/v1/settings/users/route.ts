import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { CreateUserSchema } from "@/lib/validators/users";
import { canonicalCountryList } from "@/lib/territory";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data, error } = await db
    .from("profiles")
    .select("id, email, full_name, role, territory_countries, is_active, availability_status, is_super_admin, sending_email, created_at")
    .order("created_at", { ascending: true });

  if (error) return fail(500, "INTERNAL", error.message);
  return ok(data ?? []);
}

export async function POST(req: NextRequest) {
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { email, password, full_name, role, territory_countries } = parsed.data;

  // Only the Super Admin creates other manager accounts — regular managers
  // may only bring on employees (mirrors the PATCH-side restriction below).
  if (role === "manager" && !caller.isSuperAdmin) {
    return fail(403, "FORBIDDEN", "Only the Super Admin can create manager accounts.");
  }

  const db = dbForUser(caller);

  const { data: created, error: createError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role },
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
      role,
      territory_countries: role === "employee" ? canonicalCountryList(territory_countries) : [],
      is_active: true,
    })
    .select("id, email, full_name, role, territory_countries, is_active, availability_status, is_super_admin, sending_email, created_at")
    .single();

  if (profileError) {
    await db.auth.admin.deleteUser(created.user.id);
    return fail(500, "INTERNAL", profileError.message);
  }

  return ok(profile);
}
