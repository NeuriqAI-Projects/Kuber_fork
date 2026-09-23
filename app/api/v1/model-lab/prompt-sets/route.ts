import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

const Schema = z.object({
  id: dbId.optional(),
  name: z.string().trim().min(1).max(80),
  scope: z.enum(["personal", "company"]).default("personal"),
  template: z.string().max(20000).nullable().optional(),
  prompt: z.string().max(20000).nullable().optional(),
});

/** Save a wording to try, or update one. Never writes to Settings — promoting a
 *  winner is a deliberate, separate act in Settings itself. */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");
  if (!user.companyId) return fail(400, "VALIDATION_ERROR", "No company on this account");

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const now = new Date().toISOString();
  const fields = {
    name: parsed.data.name,
    scope: parsed.data.scope,
    template: parsed.data.template ?? null,
    prompt: parsed.data.prompt ?? null,
    updated_at: now,
  };

  if (parsed.data.id) {
    const { data, error } = await db.from("model_lab_prompt_sets")
      .update(fields).eq("id", parsed.data.id).select("id, name, scope, template, prompt").single();
    if (error) return fail(500, "INTERNAL", error.message);
    return ok({ prompt_set: data });
  }

  const { data, error } = await db.from("model_lab_prompt_sets")
    .insert({ ...fields, company_id: user.companyId, created_by: user.id, created_at: now })
    .select("id, name, scope, template, prompt").single();
  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ prompt_set: data });
}

export async function DELETE(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return fail(400, "VALIDATION_ERROR", "id required");

  // Emails keep their prompt_set_id as NULL once the set is gone (ON DELETE SET
  // NULL), so past votes survive as "Live settings" rather than vanishing.
  const db = dbForUser(user);
  const { error } = await db.from("model_lab_prompt_sets").delete().eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ deleted: id });
}
