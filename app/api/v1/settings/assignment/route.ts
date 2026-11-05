import { NextRequest } from "next/server";
import { z } from "zod";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const PatchAssignmentSchema = z.object({
  strategy: z.enum(["manual", "round_robin", "territory"]),
});

// The auto-assignment default for newly-enriched pool leads (planning.md
// Phase 4.4 — previously frozen: nothing in the app could change it).
// "manual" = off; leads wait in the manager pool.
export async function GET(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const db = dbForUser(user);
  const { data, error } = await db
    .from("assignment_settings")
    .select("strategy")
    .limit(1)
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ strategy: (data?.strategy as string | undefined) ?? "manual" });
}

export async function PATCH(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = PatchAssignmentSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  const { data: existing } = await db.from("assignment_settings").select("id").limit(1).maybeSingle();

  if (existing) {
    const { error } = await db
      .from("assignment_settings")
      .update({ strategy: parsed.data.strategy, updated_at: new Date().toISOString() })
      .eq("id", existing.id);
    if (error) return fail(500, "INTERNAL", error.message);
  } else {
    const { error } = await db.from("assignment_settings").insert({ strategy: parsed.data.strategy });
    if (error) return fail(500, "INTERNAL", error.message);
  }

  return ok({ strategy: parsed.data.strategy });
}
