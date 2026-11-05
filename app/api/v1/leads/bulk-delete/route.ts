import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { removeLeadsFromOutreach } from "@/lib/services/lead-removal";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 120;

const BulkDeleteSchema = z.object({
  ids: z.array(dbId).min(1).max(500),
});

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = BulkDeleteSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "ids must be a non-empty array of lead IDs", parsed.error.flatten());

  const db = dbForUser(user);
  const { error, count } = await db
    .from("leads")
    .update({ is_deleted: true }, { count: "exact" })
    .in("id", parsed.data.ids);

  if (error) return fail(500, "INTERNAL", error.message);

  // Deleting must actually stop outreach (planning.md Phase 5 / Q7). All
  // leads in one set-based pass (was ~6 queries per membership, one lead at a
  // time, and up to 500 leads could time out).
  const removal = await removeLeadsFromOutreach(db, parsed.data.ids);

  return ok({
    deleted: count ?? parsed.data.ids.length,
    instantly_removed: removal.instantly_removed,
    instantly_errors: removal.instantly_errors,
  });
}
