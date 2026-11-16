import { createAdminClient } from "@/lib/supabase/admin";
import { fail } from "@/lib/api-response";
import type { AuthedUser } from "@/lib/auth/api-auth";
import { canSeeAll, isLeadOwner } from "@/lib/auth/scopes";

type Db = ReturnType<typeof createAdminClient>;

// Access model (spec §5 / §7 — the multi-employee campaign container):
//   • Members holding an area's :all reach scope (leads:all, campaigns:all,
//     unibox:all — lib/auth/scopes.ts) see everything in their company.
//   • A campaign is a CONTAINER that may hold leads owned by several
//     people. WITHOUT the reach scope, access is uniformly LEAD-ASSIGNMENT based:
//       - a lead: they see/work it only if it is assigned to them;
//       - a campaign: they can open it if it contains ≥1 lead assigned to them
//         (or, for back-compat, it was assigned to / created by them), but the
//         detail view still shows only THEIR leads within it;
//       - a thread / draft / reply-draft: only if the underlying lead is
//         assigned to them — never merely because they can see the campaign.
//   This keeps one consistent rule across Leads, Campaigns and Unibox, and
//   prevents an employee from seeing a co-worker's leads inside a shared
//   campaign.

/**
 * The single source of truth for "which live campaigns can this employee see":
 * any campaign they created, OR that's assigned to them, OR that contains at
 * least one lead currently assigned to them (spec §5/§7). Every employee-facing
 * campaign surface (list page, dashboard, detail page, API) must go through
 * this — previously the server list/detail pages used narrower ad-hoc rules
 * (created_by only), so an employee with a lead inside a manager-created
 * campaign never saw that campaign even though the detail/API allowed it.
 */
export async function employeeCampaignIds(db: Db, userId: string): Promise<string[]> {
  // Paged: PostgREST returns at most 1000 rows, and an employee easily holds
  // more campaign_leads than that (deleted campaigns keep theirs), which
  // silently dropped whole campaigns from their list.
  const viaLeadsPages = async () => {
    const rows: { campaign_id: unknown }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("campaign_leads").select("campaign_id, leads!lead_id!inner(assigned_to, is_deleted)")
        .eq("leads.assigned_to", userId).eq("leads.is_deleted", false).order("id").range(from, from + 999);
      rows.push(...(data ?? []));
      if ((data?.length ?? 0) < 1000) return rows;
    }
  };
  const [{ data: owned }, viaLeads] = await Promise.all([
    db.from("campaigns").select("id").eq("is_deleted", false).or(`created_by.eq.${userId},assigned_to.eq.${userId}`),
    viaLeadsPages(),
  ]);

  const ids = new Set<string>();
  for (const c of owned ?? []) ids.add(c.id as string);
  for (const cl of viaLeads ?? []) if (cl.campaign_id) ids.add(cl.campaign_id as string);
  return [...ids];
}

/** Campaign ids an employee may access: contains a lead assigned to them, OR (back-compat) created by / assigned to them. */
export async function getAccessibleCampaignIds(db: Db, user: AuthedUser): Promise<string[]> {
  if (canSeeAll(user.member, "campaigns")) {
    const { data } = await db.from("campaigns").select("id").eq("is_deleted", false);
    return (data ?? []).map((c) => c.id as string);
  }
  return employeeCampaignIds(db, user.id);
}

/** Throws a 404 unless the campaign exists and (for employees) is accessible per the model above.
 *  Returns the campaign row; `cols` adds columns to it, so a route that needs
 *  the row anyway does not read it a second time. */
export async function assertCampaignAccess(
  db: Db, user: AuthedUser, campaignId: string, cols?: string,
): Promise<Record<string, unknown>> {
  const { data } = await db
    .from("campaigns")
    .select(cols ? `created_by, assigned_to, ${cols}` : "created_by, assigned_to")
    .eq("id", campaignId)
    .maybeSingle<Record<string, unknown>>();
  if (!data) throw fail(404, "NOT_FOUND", "Campaign not found");
  if (canSeeAll(user.member, "campaigns")) return data;
  if (data.created_by === user.id || data.assigned_to === user.id) return data;

  // Otherwise: accessible only if it holds at least one lead assigned to them.
  const { data: cl } = await db
    .from("campaign_leads")
    .select("id, leads!lead_id!inner(assigned_to, is_deleted)")
    .eq("campaign_id", campaignId)
    .eq("leads.assigned_to", user.id)
    .eq("leads.is_deleted", false)
    .limit(1)
    .maybeSingle();
  if (cl) return data;

  throw fail(404, "NOT_FOUND", "Campaign not found");
}

/**
 * The lead owners a campaign belongs to (isLeadOwner: the old "employees"): every
 * lead owner who owns a lead in it, plus its creator and its assignee when those
 * are lead owners — a campaign someone built but has not put leads in yet is still theirs.
 *
 * Members who see every lead (leads:all, the old managers) are deliberately NOT
 * counted. They administer every campaign, so counting them would make every
 * admin-created container permanently "multi-owner" and lock out the one person
 * actually working it.
 *
 * Batched (a map per campaign id) because the campaigns list needs this for
 * every row it renders, not one campaign at a time.
 */
export async function campaignEmployeeOwners(
  db: Db,
  campaignIds: string[],
): Promise<Map<string, Set<string>>> {
  const owners = new Map<string, Set<string>>(campaignIds.map((id) => [id, new Set<string>()]));
  if (campaignIds.length === 0) return owners;

  const [{ data: camps }, { data: cls }] = await Promise.all([
    db.from("campaigns").select("id, created_by, assigned_to").in("id", campaignIds),
    db.from("campaign_leads")
      .select("campaign_id, leads!lead_id!inner(assigned_to, is_deleted)")
      .in("campaign_id", campaignIds)
      .eq("leads.is_deleted", false),
  ]);

  const add = (campaignId: string | null, userId: string | null) => {
    if (!campaignId || !userId) return;
    owners.get(campaignId)?.add(userId);
  };

  for (const c of camps ?? []) {
    add(c.id as string, c.created_by as string | null);
    add(c.id as string, (c as { assigned_to?: string | null }).assigned_to ?? null);
  }
  type OwnerRow = { campaign_id: string | null; leads: { assigned_to: string | null } | null };
  for (const cl of (cls ?? []) as unknown as OwnerRow[]) {
    add(cl.campaign_id, cl.leads?.assigned_to ?? null);
  }

  // Keep only the lead owners among the ids gathered above.
  const everyone = [...new Set([...owners.values()].flatMap((s) => [...s]))];
  if (everyone.length === 0) return owners;
  const { data: profiles } = await db
    .from("profiles").select("id, is_owner, scopes").in("id", everyone);
  const isEmployee = new Set((profiles ?? [])
    .filter((p) => isLeadOwner({ id: p.id as string, isOwner: !!p.is_owner, active: true, scopes: (p.scopes as string[] | null) ?? [] }))
    .map((p) => p.id as string));

  for (const set of owners.values()) {
    for (const id of set) if (!isEmployee.has(id)) set.delete(id);
  }
  return owners;
}

/**
 * Of the given campaigns, the ones whose shared Options/Sequences this employee
 * may edit: those no OTHER employee is part of (spec §5 — a campaign is a
 * container). Alone in a campaign, editing only ever changes their own leads'
 * sending, so there is nobody to surprise. Share it with a teammate and it goes
 * back to manager-only.
 */
export async function campaignsEditableByEmployee(
  db: Db,
  userId: string,
  campaignIds: string[],
): Promise<Set<string>> {
  const owners = await campaignEmployeeOwners(db, campaignIds);
  const editable = new Set<string>();
  for (const [campaignId, involved] of owners) {
    if ([...involved].every((id) => id === userId)) editable.add(campaignId);
  }
  return editable;
}

/**
 * Throws unless the caller may edit campaign-wide settings — Options (sender
 * identity, daily limit, sending window, send days) and Sequences (step
 * subject/body). Both propagate live to every Instantly sub-campaign, i.e. to
 * every lead in the container.
 *
 * Members with campaigns:all always may. Others only when they are the sole lead
 * owner in the campaign — otherwise they'd silently change what a teammate's
 * leads send under. See docs/notes/EDGE_CASES.md §2.10. Since the scopes rework
 * this guards EVERY campaign-wide change (delete, pause, resume, edit, AI drafts,
 * default drafts, sync, regeneration cancel), not only Options/Sequences. The
 * action's own scope (campaigns:write / :send / ...) is checked by the route.
 */
export async function assertCampaignSettingsAccess(
  db: Db,
  user: AuthedUser,
  campaignId: string,
): Promise<void> {
  await assertCampaignAccess(db, user, campaignId);
  if (canSeeAll(user.member, "campaigns")) return;

  const editable = await campaignsEditableByEmployee(db, user.id, [campaignId]);
  if (editable.has(campaignId)) return;
  throw fail(
    403,
    "FORBIDDEN",
    "This campaign holds another teammate's leads, so only someone who can see all campaigns can change it.",
  );
}

/**
 * Throws a 404 unless the caller may act on ONE lead inside a campaign: the
 * campaign_lead exists and (without campaigns:all) its lead is assigned to them.
 * For per-lead actions in shared campaigns (approve, follow-up, kanban status,
 * attachment) — campaign access alone is not enough.
 */
export async function assertCampaignLeadAccess(db: Db, user: AuthedUser, campaignLeadId: string): Promise<void> {
  if (canSeeAll(user.member, "campaigns")) {
    const { data } = await db.from("campaign_leads").select("id").eq("id", campaignLeadId).maybeSingle();
    if (data) return;
  } else if (await ownsCampaignLead(db, user.id, campaignLeadId)) {
    return;
  }
  throw fail(404, "NOT_FOUND", "Lead not found in this campaign");
}

/** True when the underlying lead of a campaign_lead is assigned to this employee. */
async function ownsCampaignLead(db: Db, userId: string, campaignLeadId: string): Promise<boolean> {
  const { data } = await db
    .from("campaign_leads")
    .select("id, leads!lead_id!inner(assigned_to)")
    .eq("id", campaignLeadId)
    .eq("leads.assigned_to", userId)
    .maybeSingle();
  return !!data;
}

/**
 * Unibox visibility boundary for an employee: threads whose campaign_lead's lead
 * is assigned to them (spec §7). Null for managers (see everything).
 *
 * Returns the employee's id and lets the Unibox queries join through to it.
 * This used to materialise every campaign_lead id they own and hand that list
 * over to be expanded into a URL filter — which broke outright once someone was
 * assigned enough leads (see UniboxScope in lib/services/unibox.ts).
 */
export function getUniboxScope(user: AuthedUser): { assigned_to: string } | null {
  return canSeeAll(user.member, "unibox") ? null : { assigned_to: user.id };
}

/**
 * Throws a 404 unless the caller may see a thread. Employees: only when the
 * thread's campaign_lead resolves to a lead assigned to them (spec §7) — campaign
 * access alone is NOT enough, so co-workers' threads in a shared campaign stay hidden.
 */
export async function assertThreadAccess(
  db: Db,
  user: AuthedUser,
  thread: { campaignId?: string | null; campaignLeadId?: string | null },
): Promise<void> {
  if (canSeeAll(user.member, "unibox")) return;
  if (thread.campaignLeadId && await ownsCampaignLead(db, user.id, thread.campaignLeadId)) return;
  throw fail(404, "NOT_FOUND", "Thread not found");
}

/** assertThreadAccess, resolving the campaign_lead(s) from a unibox thread id. */
export async function assertThreadAccessById(db: Db, user: AuthedUser, threadId: string): Promise<void> {
  if (canSeeAll(user.member, "unibox")) return;
  const { data: rows } = await db
    .from("unibox_emails")
    .select("campaign_lead_id")
    .eq("thread_id", threadId)
    .not("campaign_lead_id", "is", null)
    .limit(20);
  if (!rows || rows.length === 0) throw fail(404, "NOT_FOUND", "Thread not found");

  for (const row of rows) {
    if (row.campaign_lead_id && await ownsCampaignLead(db, user.id, row.campaign_lead_id as string)) return;
  }
  throw fail(404, "NOT_FOUND", "Thread not found");
}

/** Throws a 404 unless the lead exists and (for employees) is assigned to them (spec §5: own assigned leads only). */
export async function assertLeadAccess(db: Db, user: AuthedUser, leadId: string): Promise<void> {
  const { data } = await db.from("leads").select("assigned_to").eq("id", leadId).maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Lead not found");
  if (canSeeAll(user.member, "leads")) return;
  if (data.assigned_to === user.id) return;
  throw fail(404, "NOT_FOUND", "Lead not found");
}

/** Throws a 404 unless the email_drafts row exists and (for employees) its lead is assigned to them (spec §2.8 consistency). */
export async function assertDraftAccess(db: Db, user: AuthedUser, draftId: string): Promise<void> {
  const { data } = await db.from("email_drafts").select("campaign_id, lead_id").eq("id", draftId).maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Draft not found");
  if (canSeeAll(user.member, "campaigns")) return;
  const { data: lead } = await db.from("leads").select("assigned_to").eq("id", data.lead_id).maybeSingle();
  if (lead?.assigned_to === user.id) return;
  throw fail(404, "NOT_FOUND", "Draft not found");
}

/** Throws a 404 unless the reply_drafts row exists and (for employees) its lead is assigned to them (spec §2.9 consistency). */
export async function assertReplyDraftAccess(db: Db, user: AuthedUser, replyDraftId: string): Promise<void> {
  const { data } = await db
    .from("reply_drafts")
    .select("campaign_id, campaign_lead_id")
    .eq("id", replyDraftId)
    .maybeSingle();
  if (!data) throw fail(404, "NOT_FOUND", "Reply draft not found");
  if (canSeeAll(user.member, "unibox")) return;
  if (data.campaign_lead_id && await ownsCampaignLead(db, user.id, data.campaign_lead_id)) return;
  throw fail(404, "NOT_FOUND", "Reply draft not found");
}

/**
 * Who an import is assigned to. A member with leads:assign chooses (a person, a
 * strategy, or the pool), exactly as before. Anyone else — e.g. an employee allowed
 * to import their own Excel — gets every lead they import assigned to themselves:
 * the "assign to" choice is not theirs to make (and the UI hides that step).
 * Whatever the body asked for is ignored in that case, so a member without
 * leads:assign can never hand leads to someone else or into the pool.
 */
export function importAssignment<S extends string>(
  user: AuthedUser,
  requested: { assigned_to?: string | null; assignment_strategy?: S | null },
): { assigned_to: string | null; assignment_strategy: S | null; self: boolean } {
  if (user.scopes.includes("leads:assign")) {
    return { assigned_to: requested.assigned_to ?? null, assignment_strategy: requested.assignment_strategy ?? null, self: false };
  }
  return { assigned_to: user.id, assignment_strategy: null, self: true };
}
