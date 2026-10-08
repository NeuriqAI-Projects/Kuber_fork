import { NextRequest } from "next/server";
import { requireManager } from "@/lib/auth/api-auth";
import { fail, ok } from "@/lib/api-response";
import { dbForUser } from "@/lib/supabase/scoped";
import { ProspectDecisionSchema } from "@/lib/validators/leads";

/** What each client decision is allowed to act on, and what it moves the company to. */
const RULES = {
  approve: { from: ["review", "flagged", "hidden"], to: "approved" },   // reveal one contact
  reject: { from: ["review", "flagged", "site_down", "good", "waiting_credits"], to: "rejected" },
  retry: { from: ["site_down"], to: "queued" },                         // spend 1 Firecrawl credit again
} as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }
  const { id } = await params;

  const parsed = ProspectDecisionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const rule = RULES[parsed.data.action];

  // Conditional update = atomic: it only applies if the company is still in an
  // allowed state, so a double click or a stale screen can't double-act.
  const { data, error } = await dbForUser(user).from("prospect_companies")
    .update({ status: rule.to, attempts: 0, last_error: null, locked_until: null, decided_by: user.id, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id).in("status", [...rule.from])
    .select("id, status");
  if (error) return fail(500, "INTERNAL", error.message);
  if (!data?.length) return fail(409, "STATE_CHANGED", "This company is no longer in a state where that action applies. Refresh the list.");
  return ok(data[0]);
}
