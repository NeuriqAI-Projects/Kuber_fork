import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { ProspectDecisionSchema } from "@/lib/validators/leads";
import { decide } from "@/lib/services/prospects/decisions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const { id } = await params;

  const parsed = ProspectDecisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  try {
    const changed = await decide(dbForUser(user), user.id, [id], parsed.data.action);
    if (!changed.length) return fail(409, "STATE_CHANGED", "This company has already moved on. Refresh the list.");
    return ok({ id, action: parsed.data.action });
  } catch (err) {
    return fail(500, "INTERNAL", (err as Error).message);
  }
}
