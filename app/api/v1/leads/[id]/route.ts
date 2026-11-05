import { NextRequest } from "next/server";
import { requireAuth, requireManager } from "@/lib/auth/api-auth";
import { ok, fail } from "@/lib/api-response";
import { PatchLeadSchema } from "@/lib/validators/leads";
import { logLeadEvent } from "@/lib/services/lead-events";
import { LEAD_STATUS_MAP } from "@/lib/mappers";
import { dbForUser } from "@/lib/supabase/scoped";

export const maxDuration = 60;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(_req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  // The campaign rows do not need the lead first: both in one round trip
  // (they are only returned after the lead and the employee check pass).
  const [{ data: lead, error }, { data: cls }] = await Promise.all([
    db
      .from("leads")
      .select("*, organizations(id, name, domain, unsubscribed, has_scraped, enrichment_stage, company_description, sells_to, last_error), imports(id, label, color)")
      .eq("id", id)
      .maybeSingle(),
    db
      .from("campaign_leads")
      .select("crm_status, campaign_id, created_at, campaigns(id, name)")
      .eq("lead_id", id)
      .order("created_at", { ascending: false }),
  ]);

  if (error) return fail(500, "INTERNAL", error.message);
  if (!lead) return fail(404, "NOT_FOUND", "Lead not found");
  // Employees see only their own assigned leads (spec §5).
  if (user.role === "employee" && lead.assigned_to !== user.id) {
    return fail(404, "NOT_FOUND", "Lead not found");
  }

  const campaignList = (cls ?? []).map((cl) => {
    const camp = Array.isArray(cl.campaigns) ? cl.campaigns[0] : cl.campaigns as { id: string; name: string } | null;
    return camp ? { id: camp.id, name: camp.name, crm_status: cl.crm_status, added_at: cl.created_at } : null;
  }).filter(Boolean) as { id: string; name: string; crm_status: string; added_at: string }[];

  // Org-level enrichment fans out to every lead under that org regardless of
  // owner (review §3.4) — surface a lightweight "shared" signal (counts only,
  // no other owners' lead details) so the viewer isn't blindsided by data
  // that changed underneath them from someone else's trigger.
  let orgShared: { other_lead_count: number; other_owner_count: number } | null = null;
  if (lead.organization_id) {
    const { data: orgLeads } = await db
      .from("leads")
      .select("assigned_to")
      .eq("organization_id", lead.organization_id)
      .eq("is_deleted", false)
      .neq("id", id);
    const otherOwners = new Set((orgLeads ?? []).map((l) => l.assigned_to).filter(Boolean));
    orgShared = { other_lead_count: (orgLeads ?? []).length, other_owner_count: otherOwners.size };
  }

  return ok({ ...lead, campaign_list: campaignList, org_shared: orgShared });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireManager>>;
  try { user = await requireManager(_req); } catch (r) { return r as Response; }

  const { id } = await params;
  const db = dbForUser(user);

  const { error } = await db.from("leads").update({ is_deleted: true }).eq("id", id);
  if (error) return fail(500, "INTERNAL", error.message);

  // Deleting must actually stop outreach: remove from Instantly (kills
  // follow-ups) and clean campaign memberships (planning.md Phase 5 / Q7).
  const { removeLeadFromOutreach } = await import("@/lib/services/lead-removal");
  const removal = await removeLeadFromOutreach(db, id);

  return ok({ deleted: id, ...removal });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user: Awaited<ReturnType<typeof requireAuth>>;
  try { user = await requireAuth(req); } catch (r) { return r as Response; }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = PatchLeadSchema.safeParse(body);
  if (!parsed.success) return fail(400, "VALIDATION_ERROR", "Invalid request", parsed.error.flatten());

  const db = dbForUser(user);

  // Prior state, read before the update: gates the employee scope check and lets
  // the activity log report real transitions ("from X to Y") rather than echoing
  // whatever the client submitted.
  const { data: before } = await db
    .from("leads")
    .select("status, assigned_to")
    .eq("id", id)
    .maybeSingle();
  if (!before) return fail(404, "NOT_FOUND", "Lead not found");
  if (user.role === "employee" && before.assigned_to !== user.id) {
    return fail(404, "NOT_FOUND", "Lead not found");
  }

  const { email, assigned_to, ...rest } = parsed.data;

  // Single-lead reassignment is a manager-only action (review §3.2) — the
  // only prior path was bulk-assign or a campaign-assign side effect.
  // manualTargetOffline mirrors bulkAssignByStrategy's own flag (assignment.ts)
  // so this path warns too instead of silently parking a lead on someone away.
  let manualTargetOffline = false;
  if (assigned_to !== undefined) {
    if (user.role !== "manager") return fail(403, "FORBIDDEN", "Only managers can reassign leads");
    if (assigned_to) {
      const { data: assignee } = await db
        .from("profiles")
        .select("id, is_active, availability_status")
        .eq("id", assigned_to)
        .maybeSingle();
      if (!assignee || !assignee.is_active) return fail(400, "INVALID_ASSIGNEE", "Employee not found or inactive");
      manualTargetOffline = assignee.availability_status === "offline";
    }
  }

  // Email dedup check if email is being changed
  if (email) {
    const { data: conflict } = await db
      .from("leads")
      .select("id")
      .eq("email", email.toLowerCase())
      .eq("is_deleted", false)
      .neq("id", id)
      .maybeSingle();
    if (conflict) return fail(409, "DUPLICATE", "Another lead with this email already exists");
  }

  const { data, error } = await db
    .from("leads")
    .update({
      ...rest,
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(assigned_to !== undefined ? { assigned_to, assigned_at: assigned_to ? new Date().toISOString() : null } : {}),
      updated_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .maybeSingle();

  if (error) return fail(500, "INTERNAL", error.message);
  if (!data) return fail(404, "NOT_FOUND", "Lead not found");

  // Log only what genuinely moved — a PATCH that re-sends the current status or
  // assignee is a no-op edit, and logging it would bury the real events.
  const statusLabel = (s: string | null) => (s ? LEAD_STATUS_MAP[s] ?? s : "none");
  if (rest.status && rest.status !== before.status) {
    await logLeadEvent(
      db, id, "status_changed",
      `Status changed from ${statusLabel(before.status)} to ${statusLabel(rest.status)}`,
      { actorId: user.id, metadata: { from: before.status, to: rest.status } },
    );
  }
  if (assigned_to !== undefined && assigned_to !== before.assigned_to) {
    if (assigned_to && !before.assigned_to) {
      await logLeadEvent(db, id, "assigned", "Assigned to an employee", { actorId: user.id, metadata: { assignee_id: assigned_to } });
    } else if (assigned_to && before.assigned_to) {
      await logLeadEvent(db, id, "reassigned", "Reassigned to a different employee", { actorId: user.id, metadata: { from: before.assigned_to, to: assigned_to } });
    } else if (!assigned_to && before.assigned_to) {
      await logLeadEvent(db, id, "unassigned", "Returned to the pool", { actorId: user.id, metadata: { from: before.assigned_to } });
    }
  }

  return ok({ ...data, manual_target_offline: manualTargetOffline });
}
