import { NextRequest } from "next/server";
import { z } from "zod";
import { dbId } from "@/lib/validators/id";
import { requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { logLeadEvents } from "@/lib/services/lead-events";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

const AssignCampaignSchema = z.object({
  assigned_to: dbId.nullable(),   // null = return to the manager pool
  reassign_leads: z.boolean().optional().default(false),
});

/**
 * Assign (or reassign, or unassign) a whole campaign to one employee
 * (planning.md Phase 2 / Q2). The campaign row holds the single current
 * assignee; campaign_assignments keeps the append-only history so repeated
 * reassignment can never pile up or become ambiguous.
 *
 * With reassign_leads=true the campaign's leads move to the assignee too, so
 * the Leads table and the inbox tell the same story.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let caller: Awaited<ReturnType<typeof requireManager>>;
  try { caller = await requireManager(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = AssignCampaignSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());
  const { assigned_to, reassign_leads } = parsed.data;

  const db = dbForUser(caller);

  const { data: campaign, error: campaignErr } = await db
    .from("campaigns")
    .select("id, assigned_to, is_deleted")
    .eq("id", id)
    .maybeSingle();
  if (campaignErr) return fail(500, "INTERNAL", campaignErr.message);
  if (!campaign || campaign.is_deleted) return fail(404, "NOT_FOUND", "Campaign not found");

  // manualTargetOffline mirrors bulkAssignByStrategy's own flag (assignment.ts)
  // so this path warns too instead of silently parking the campaign/leads on
  // someone away.
  let manualTargetOffline = false;
  if (assigned_to) {
    const { data: assignee } = await db
      .from("profiles")
      .select("id, is_active, availability_status")
      .eq("id", assigned_to)
      .maybeSingle();
    if (!assignee || !assignee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
    manualTargetOffline = assignee.availability_status === "offline";
  }

  const previous = (campaign.assigned_to as string | null) ?? null;
  const unchanged = previous === assigned_to;

  const now = new Date().toISOString();
  let leadsReassigned = 0;

  if (!unchanged) {
    const { error: updateErr } = await db
      .from("campaigns")
      .update({ assigned_to, assigned_at: assigned_to ? now : null, updated_by: caller.id })
      .eq("id", id);
    if (updateErr) return fail(500, "INTERNAL", updateErr.message);

    const { error: historyErr } = await db.from("campaign_assignments").insert({
      campaign_id: id,
      assigned_to,
      assigned_by: caller.id,
      previous_assignee: previous,
    });
    if (historyErr) return fail(500, "INTERNAL", historyErr.message);
  }

  // Lead reassignment is allowed even on an unchanged assignee — "assign the
  // stragglers too" is a legitimate second click.
  if (reassign_leads && assigned_to) {
    const { data: memberships } = await db
      .from("campaign_leads")
      .select("lead_id")
      .eq("campaign_id", id);
    const leadIds = [...new Set((memberships ?? []).map((m) => m.lead_id as string))];
    if (leadIds.length > 0) {
      // Prior owners, read before the write: lets the activity log name who each
      // lead moved away from, and keeps leads the assignee already owned out of
      // the log entirely rather than reporting a move that never happened.
      const { data: priorRows } = await db
        .from("leads")
        .select("id, assigned_to")
        .in("id", leadIds)
        .eq("is_deleted", false);

      const { error: leadsErr, count } = await db
        .from("leads")
        .update({ assigned_to, assigned_at: now }, { count: "exact" })
        .in("id", leadIds)
        .eq("is_deleted", false);
      if (leadsErr) return fail(500, "INTERNAL", leadsErr.message);
      leadsReassigned = count ?? leadIds.length;

      await logLeadEvents(db, (priorRows ?? [])
        .filter((r) => r.assigned_to !== assigned_to)
        .map((r) => ({
          leadId: r.id as string,
          event: r.assigned_to ? ("reassigned" as const) : ("assigned" as const),
          detail: r.assigned_to
            ? "Reassigned to a different employee with the campaign"
            : "Assigned to an employee with the campaign",
          actorId: caller.id,
          metadata: { campaign_id: id, from: r.assigned_to, to: assigned_to },
        })));
    }
  }

  return ok({
    campaign_id: id,
    assigned_to,
    previous_assignee: previous,
    changed: !unchanged,
    leads_reassigned: leadsReassigned,
    manual_target_offline: manualTargetOffline,
  });
}
