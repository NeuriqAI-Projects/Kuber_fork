import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { bulkAssignByStrategy } from "@/lib/services/assignment";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

// At most 1,000 ids per request (the Leads page selection; the assistant sends ≤ 500).
// skip_already_assigned (spec §4): when true, leads that already have an owner
// are left untouched — only pool/unassigned leads are processed.
const BulkAssignSchema = z.discriminatedUnion("strategy", [
  z.object({ strategy: z.literal("manual"), ids: z.array(dbId).min(1).max(1000), assigned_to: dbId.nullable(), skip_already_assigned: z.boolean().optional() }),
  z.object({ strategy: z.literal("round_robin"), ids: z.array(dbId).min(1).max(1000), skip_already_assigned: z.boolean().optional() }),
  z.object({ strategy: z.literal("territory"), ids: z.array(dbId).min(1).max(1000), skip_already_assigned: z.boolean().optional() }),
]);

export async function POST(req: NextRequest) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(req); } catch (r) { return r as Response; }

  const body = await req.json().catch(() => null);
  const parsed = BulkAssignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  // Deactivated target is rejected; an offline target is allowed but the
  // returned summary flags manual_target_offline so the UI can warn (spec §2B).
  if (parsed.data.strategy === "manual" && parsed.data.assigned_to) {
    const { data: employee } = await db
      .from("profiles")
      .select("id, is_active")
      .eq("id", parsed.data.assigned_to)
      .maybeSingle();
    if (!employee || !employee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
  }

  try {
    const result = await bulkAssignByStrategy(
      db,
      parsed.data.ids,
      parsed.data.strategy,
      parsed.data.strategy === "manual" ? parsed.data.assigned_to : null,
      parsed.data.skip_already_assigned ?? false,
    );

    // round-robin / territory with zero eligible employees is a hard failure —
    // nothing could be assigned; surface it clearly (spec §3 "block with error").
    if (parsed.data.strategy !== "manual" && result.eligible_employee_count === 0 && result.total > 0) {
      return fail(409, "NO_ELIGIBLE_EMPLOYEES",
        "No eligible employees are available (all are offline, deactivated, or outside the required territory).",
        result);
    }

    return ok(result);
  } catch (e) {
    return fail(500, "INTERNAL", (e as Error).message);
  }
}
