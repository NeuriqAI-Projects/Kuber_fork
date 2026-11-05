import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

/** GET — returns the calling admin's signature (or empty defaults). */
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data } = await db
    .from("user_signatures")
    .select("full_name, title, contact, email")
    .eq("user_id", user.id)
    .maybeSingle();

  return ok(data ?? { full_name: "", title: "", contact: "", email: "" });
}

/** PUT — upsert the calling admin's signature. */
export async function PUT(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  if (!body || typeof body.full_name !== "string" || !body.full_name.trim()) {
    return fail(400, "VALIDATION_ERROR", "full_name is required");
  }

  const db = dbForUser(user);
  const { error } = await db.from("user_signatures").upsert(
    {
      user_id: user.id,
      full_name: body.full_name.trim(),
      title: body.title?.trim() ?? null,
      contact: body.contact?.trim() ?? null,
      email: user.email ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ saved: true });
}
