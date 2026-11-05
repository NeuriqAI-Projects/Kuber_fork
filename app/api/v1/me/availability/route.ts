import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchMyAvailabilitySchema } from "@/lib/validators/users";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const SERVICE_ROLE_USER_ID = "00000000-0000-0000-0000-000000000000";

// Self-service online/offline toggle (spec §2B). Any signed-in user can mark
// THEMSELVES available/unavailable — e.g. an employee going on leave who wants
// to stop receiving new automatic assignments without being deactivated.
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.id === SERVICE_ROLE_USER_ID) return fail(400, "NO_PROFILE", "The service-role caller has no availability");

  const db = dbForUser(user);
  const { data } = await db.from("profiles").select("availability_status").eq("id", user.id).maybeSingle();
  return ok({ availability_status: (data?.availability_status as string) ?? "online" });
}

export async function PATCH(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.id === SERVICE_ROLE_USER_ID) return fail(400, "NO_PROFILE", "The service-role caller has no availability");

  const body = await req.json().catch(() => null);
  const parsed = PatchMyAvailabilitySchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const { error } = await db
    .from("profiles")
    .update({ availability_status: parsed.data.availability_status, updated_at: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return fail(500, "INTERNAL", error.message);

  return ok({ availability_status: parsed.data.availability_status });
}
