import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { ProspectBulkDecisionSchema } from "@/lib/validators/leads";
import { decide } from "@/lib/services/prospects/decisions";

/** Approve / Decline / Retry several scored companies at once ("Approve all"). */
export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const parsed = ProspectBulkDecisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  try {
    const changed = await decide(dbForUser(user), user.id, parsed.data.ids, parsed.data.action);
    return ok({ changed: changed.length, skipped: parsed.data.ids.length - changed.length });
  } catch (err) {
    return fail(500, "INTERNAL", (err as Error).message);
  }
}
