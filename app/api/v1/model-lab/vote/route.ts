import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireAuth } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";

const Schema = z.object({
  run_group: dbId,
  email_id: dbId,
  verdict: z.enum(["best", "worst"]),
});

/**
 * Record one verdict. Re-voting replaces the earlier one rather than adding a
 * second — uq_model_lab_vote_per_voter allows one best and one worst per person
 * per run, and changing your mind is the ordinary case, not an error.
 */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  if (user.role !== "manager") return fail(403, "FORBIDDEN", "Managers only");
  if (!user.companyId) return fail(400, "VALIDATION_ERROR", "No company on this account");

  const parsed = Schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);
  await db.from("model_lab_votes").delete()
    .eq("run_group", parsed.data.run_group)
    .eq("verdict", parsed.data.verdict)
    .eq("voted_by", user.id);

  const { error } = await db.from("model_lab_votes").insert({
    company_id: user.companyId,
    run_group: parsed.data.run_group,
    email_id: parsed.data.email_id,
    verdict: parsed.data.verdict,
    voted_by: user.id,
  });
  if (error) return fail(500, "INTERNAL", error.message);
  return ok({ recorded: true });
}

/** Take a verdict back entirely (clicking the same card again). */
export async function DELETE(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }
  const url = new URL(req.url);
  const runGroup = url.searchParams.get("run_group");
  const verdict = url.searchParams.get("verdict");
  if (!runGroup || !verdict) return fail(400, "VALIDATION_ERROR", "run_group and verdict required");

  const db = dbForUser(user);
  await db.from("model_lab_votes").delete()
    .eq("run_group", runGroup).eq("verdict", verdict).eq("voted_by", user.id);
  return ok({ cleared: true });
}
