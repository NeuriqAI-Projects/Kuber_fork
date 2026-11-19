import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api-response";
import { safeSecretEqual } from "@/lib/auth/secret";
import { ATTACHMENT_BUCKET } from "@/lib/services/attachment-upload";

export const maxDuration = 60;

/**
 * Daily (pg_cron 'attachment-cleanup'): delete attachment files nothing uses any
 * more. The keep/delete rule is SQL, public.attachment_cleanup_candidates()
 * (supabase/migrations/2026_11_19_B_attachment_cleanup.sql). Cross-company by
 * design: it only removes files no row of any company points at.
 * ?dry=1 lists without deleting.
 */
export async function POST(req: NextRequest) {
  if (!safeSecretEqual(req.headers.get("x-internal-secret"), process.env.INTERNAL_SECRET)) {
    return fail(401, "UNAUTHORIZED", "Internal secret required");
  }
  const db = createAdminClient();
  const { data, error } = await db.rpc("attachment_cleanup_candidates", { p_limit: 500 });
  if (error) return fail(500, "CLEANUP_FAILED", error.message);
  const names = (data ?? []) as string[];
  if (req.nextUrl.searchParams.get("dry") === "1") return ok({ would_delete: names });

  let deleted = 0;
  for (let i = 0; i < names.length; i += 100) {
    const { data: gone, error: rmErr } = await db.storage.from(ATTACHMENT_BUCKET).remove(names.slice(i, i + 100));
    if (rmErr) return fail(500, "CLEANUP_FAILED", rmErr.message, { deleted });
    deleted += gone?.length ?? 0;
  }
  return ok({ deleted });
}
