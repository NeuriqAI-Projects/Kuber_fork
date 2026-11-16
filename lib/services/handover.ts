import { createAdminClient } from "@/lib/supabase/admin";
import { logLeadEvents } from "@/lib/services/lead-events";
import { allocateByTerritory } from "@/lib/services/territory-allocator";
import { getEligibleEmployees, getCoverage, pickRoundRobin } from "@/lib/services/assignment";
import { isLeadOwner } from "@/lib/auth/scopes";

type Db = ReturnType<typeof createAdminClient>;

/**
 * Where a departing employee's book goes when their account is deactivated.
 *
 *  - "manual"      one named person inherits everything (the original behaviour)
 *  - "pool"        everything is unassigned and waits in the manager pool
 *  - "round_robin" leads rotate across the eligible team via the shared cursor
 *  - "territory"   leads route by country; whatever nobody covers goes to the pool
 */
export type HandoverStrategy = "manual" | "pool" | "round_robin" | "territory";

export type HandoverSummary = {
  strategy: HandoverStrategy;
  leads_total: number;
  leads_reassigned: number;
  leads_to_pool: number;
  campaigns_total: number;
  campaigns_reassigned: number;
  campaigns_to_pool: number;
  /** Employees who could receive work — active, online, and not the departing user. */
  eligible_employee_count: number;
  /** employee id → what they inherited. Lets the UI show the actual split. */
  per_assignee: { employee_id: string; leads: number; campaigns: number }[];
};

export class NoEligibleEmployeesError extends Error {
  constructor() {
    super("No eligible employees are available to take this work over (all are offline, deactivated, or cover no matching territory).");
    this.name = "NoEligibleEmployeesError";
  }
}

export class InvalidHandoverTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidHandoverTargetError";
  }
}

/** PostgREST caps a single response (1000 rows by default), so every read that
 *  must be COMPLETE has to page. A handover that silently stops at row 1000
 *  strands the rest on a deactivated account.
 *
 *  Paging advances by the number of rows ACTUALLY returned and stops only on an
 *  empty page — never by comparing the page against this constant. The server's
 *  cap is what it is, not what we ask for, so a project configured below this
 *  would make a "short page means last page" test end the loop early and drop
 *  the rest of the book on the floor. */
const PAGE = 1000;
/** Ids per `.in(...)` filter — these travel in the URL, so keep them modest. */
const WRITE_CHUNK = 200;
/** Rows per activity-log insert. */
const EVENT_CHUNK = 500;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type HeldLead = { id: string; country: string | null };

/** Every non-deleted lead the user still holds. */
async function fetchHeldLeads(db: Db, userId: string): Promise<HeldLead[]> {
  const rows: HeldLead[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await db
      .from("leads")
      .select("id, country")
      .eq("assigned_to", userId)
      .eq("is_deleted", false)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Could not read the leads to hand over: ${error.message}`);
    const page = data ?? [];
    if (page.length === 0) return rows;
    rows.push(...page.map((r) => ({ id: r.id as string, country: (r.country as string | null) ?? null })));
    from += page.length;
  }
}

/** Every non-deleted campaign the user still owns. */
async function fetchHeldCampaigns(db: Db, userId: string): Promise<string[]> {
  const { data, error } = await db
    .from("campaigns")
    .select("id")
    .eq("assigned_to", userId)
    .eq("is_deleted", false);
  if (error) throw new Error(`Could not read the campaigns to hand over: ${error.message}`);
  return (data ?? []).map((r) => r.id as string);
}

/**
 * Which campaign each handed-over lead belongs to.
 *
 * Only campaigns the departing user owns are looked up, and only leads that are
 * actually moving — a campaign can hold leads owned by other people, and those
 * must not influence where the campaign lands.
 */
async function fetchCampaignMembership(
  db: Db,
  campaignIds: string[],
  movedLeadIds: Set<string>,
): Promise<Map<string, string[]>> {
  const byCampaign = new Map<string, string[]>();
  if (campaignIds.length === 0 || movedLeadIds.size === 0) return byCampaign;

  for (const ids of chunk(campaignIds, WRITE_CHUNK)) {
    // Ordered by the table's own primary key: `lead_id` alone is not unique
    // here (one lead can sit in several campaigns), and an unstable sort key
    // makes paged reads skip and repeat rows.
    for (let from = 0; ; ) {
      const { data, error } = await db
        .from("campaign_leads")
        .select("id, campaign_id, lead_id")
        .in("campaign_id", ids)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`Could not read campaign membership: ${error.message}`);
      const page = data ?? [];
      if (page.length === 0) break;
      for (const row of page) {
        const leadId = row.lead_id as string;
        if (!movedLeadIds.has(leadId)) continue;
        const campaignId = row.campaign_id as string;
        const list = byCampaign.get(campaignId) ?? [];
        list.push(leadId);
        byCampaign.set(campaignId, list);
      }
      from += page.length;
    }
  }
  return byCampaign;
}

/**
 * Redistributes everything one employee holds, then leaves their account ready
 * to be deactivated by the caller.
 *
 * ─── Why this does not reuse bulkAssignByStrategy ────────────────────────────
 * That function refuses to assign a lead unless it is `enriched`/`input_required`
 * with an email — the right rule for routine routing, because a half-enriched
 * lead may still be archived and must not be handed to anyone yet. A handover is
 * the opposite situation: the lead ALREADY belongs to someone and that someone
 * is leaving. Applying the readiness gate here would quietly skip every `open`
 * and `closed` lead in their book and strand it on a deactivated account, which
 * is the exact orphaning this whole flow exists to prevent. So every held lead
 * moves, whatever its status.
 *
 * The departing user is excluded from every candidate list. At this point they
 * are still active and online, so otherwise round-robin and territory would
 * happily hand their own leads straight back to them.
 */
export async function handoverEmployeeWork(
  db: Db,
  fromUserId: string,
  strategy: HandoverStrategy,
  manualTarget: string | null,
  actorId: string,
): Promise<HandoverSummary> {
  const [leads, campaignIds] = await Promise.all([
    fetchHeldLeads(db, fromUserId),
    fetchHeldCampaigns(db, fromUserId),
  ]);

  // lead id → new owner (null = manager pool). Same shape for every strategy,
  // so the write/logging half below is strategy-agnostic.
  const leadOwner = new Map<string, string | null>();
  // Campaigns with no signal of their own, resolved after the leads are placed.
  const campaignOwner = new Map<string, string | null>();
  let eligibleCount = 0;

  if (strategy === "manual") {
    if (!manualTarget) throw new InvalidHandoverTargetError("Pick the employee who takes this work over.");
    if (manualTarget === fromUserId) throw new InvalidHandoverTargetError("Cannot hand work over to the account being deactivated.");
    const { data: target } = await db
      .from("profiles")
      .select("id, is_owner, scopes, is_active")
      .eq("id", manualTarget)
      .maybeSingle();
    // Lead owner = the old "employee" (leads:read without leads:all), see lib/auth/scopes.ts.
    const owner = target && isLeadOwner({ id: target.id as string, isOwner: !!target.is_owner, active: !!target.is_active, scopes: (target.scopes as string[] | null) ?? [] });
    if (!target || !target.is_active || !owner) {
      throw new InvalidHandoverTargetError("Handover target must be an active member who receives leads.");
    }
    eligibleCount = 1;
    for (const lead of leads) leadOwner.set(lead.id, manualTarget);
    for (const id of campaignIds) campaignOwner.set(id, manualTarget);
  } else if (strategy === "pool") {
    // Nothing to validate and nobody to pick — this is the escape hatch that
    // works even when the departing user is the last employee standing.
    for (const lead of leads) leadOwner.set(lead.id, null);
    for (const id of campaignIds) campaignOwner.set(id, null);
  } else if (strategy === "territory") {
    const coverage = await getCoverage(db, fromUserId);
    eligibleCount = coverage.length;
    if (eligibleCount === 0) throw new NoEligibleEmployeesError();

    // One batch, priorInBatch empty: this handover starts from zero and nobody's
    // lifetime book is consulted (see territory-allocator.ts on why that matters).
    const { assignments } = allocateByTerritory(
      leads.map((l) => ({ id: l.id, country: l.country })),
      coverage,
    );
    for (const lead of leads) leadOwner.set(lead.id, assignments.get(lead.id) ?? null);
  } else {
    const candidates = await getEligibleEmployees(db, fromUserId);
    eligibleCount = candidates.length;
    if (eligibleCount === 0) throw new NoEligibleEmployeesError();

    // One RPC for the whole book — the cursor advances once and picks up where
    // the last assignment run left it, so a handover does not restart rotation.
    const picks = await pickRoundRobin(db, "global", candidates, leads.length);
    for (const [i, lead] of leads.entries()) leadOwner.set(lead.id, picks[i] ?? null);
  }

  // ─── Campaigns follow their own leads ──────────────────────────────────────
  // A campaign goes to whoever just inherited most of its leads. Splitting a
  // campaign's owner away from its leads' owners is the drift documented in
  // EDGE_CASES §2.7, and round-robining campaigns independently would cause it
  // on every single handover. Ties break on employee id so a rerun with the
  // same inputs lands the same way.
  if (strategy === "round_robin" || strategy === "territory") {
    const movedLeadIds = new Set(leads.map((l) => l.id));
    const membership = await fetchCampaignMembership(db, campaignIds, movedLeadIds);
    const orphaned: string[] = [];

    for (const campaignId of campaignIds) {
      const tally = new Map<string, number>();
      for (const leadId of membership.get(campaignId) ?? []) {
        const owner = leadOwner.get(leadId);
        if (!owner) continue; // pooled leads cast no vote
        tally.set(owner, (tally.get(owner) ?? 0) + 1);
      }
      if (tally.size === 0) { orphaned.push(campaignId); continue; }

      let winner = "";
      let best = -1;
      for (const [employeeId, count] of [...tally].sort(([a], [b]) => a.localeCompare(b))) {
        if (count > best) { winner = employeeId; best = count; }
      }
      campaignOwner.set(campaignId, winner);
    }

    // A campaign whose leads all pooled (or that holds none of the moved leads)
    // has no signal to follow. Round-robin still has a rotation to draw from;
    // territory does not — a campaign has no country of its own — so it waits in
    // the pool for the manager rather than being routed on a guess.
    if (orphaned.length > 0) {
      if (strategy === "round_robin") {
        const candidates = await getEligibleEmployees(db, fromUserId);
        const picks = await pickRoundRobin(db, "global", candidates, orphaned.length);
        for (const [i, campaignId] of orphaned.entries()) campaignOwner.set(campaignId, picks[i] ?? null);
      } else {
        for (const campaignId of orphaned) campaignOwner.set(campaignId, null);
      }
    }
  }

  // ─── Apply ─────────────────────────────────────────────────────────────────
  const now = new Date().toISOString();

  // Grouped by destination so a 1000-lead book is a handful of UPDATEs rather
  // than 1000 round-trips — which would not finish inside a serverless request.
  const leadsByOwner = new Map<string | null, string[]>();
  for (const [leadId, owner] of leadOwner) {
    const list = leadsByOwner.get(owner) ?? [];
    list.push(leadId);
    leadsByOwner.set(owner, list);
  }

  for (const [owner, ids] of leadsByOwner) {
    for (const batch of chunk(ids, WRITE_CHUNK)) {
      const { error } = await db
        .from("leads")
        .update({ assigned_to: owner, assigned_at: owner ? now : null })
        .in("id", batch);
      if (error) throw new Error(`Could not hand the leads over: ${error.message}`);
    }
  }

  for (const [campaignId, owner] of campaignOwner) {
    const { error } = await db
      .from("campaigns")
      .update({ assigned_to: owner, assigned_at: owner ? now : null, updated_by: actorId })
      .eq("id", campaignId);
    if (error) throw new Error(`Could not hand the campaigns over: ${error.message}`);
  }

  if (campaignIds.length > 0) {
    // Append-only history, same as the campaign assign endpoint writes.
    for (const batch of chunk([...campaignOwner], WRITE_CHUNK)) {
      await db.from("campaign_assignments").insert(
        batch.map(([campaignId, owner]) => ({
          campaign_id: campaignId,
          assigned_to: owner,
          assigned_by: actorId,
          previous_assignee: fromUserId,
        })),
      );
    }
  }

  // Activity log — fire-and-forget by contract, so a logging failure can never
  // undo a handover that already happened.
  const events = [...leadOwner].map(([leadId, owner]) => ({
    leadId,
    event: owner ? ("reassigned" as const) : ("unassigned" as const),
    detail: owner
      ? "Reassigned during an account handover"
      : "Returned to the pool during an account handover",
    actorId,
    metadata: { from: fromUserId, to: owner, via: `handover_${strategy}` },
  }));
  for (const batch of chunk(events, EVENT_CHUNK)) await logLeadEvents(db, batch);

  // ─── Summarise ─────────────────────────────────────────────────────────────
  const perAssignee = new Map<string, { leads: number; campaigns: number }>();
  const bump = (id: string, key: "leads" | "campaigns") => {
    const row = perAssignee.get(id) ?? { leads: 0, campaigns: 0 };
    row[key]++;
    perAssignee.set(id, row);
  };

  let leadsToPool = 0;
  for (const owner of leadOwner.values()) {
    if (owner) bump(owner, "leads"); else leadsToPool++;
  }
  let campaignsToPool = 0;
  for (const owner of campaignOwner.values()) {
    if (owner) bump(owner, "campaigns"); else campaignsToPool++;
  }

  return {
    strategy,
    leads_total: leads.length,
    leads_reassigned: leads.length - leadsToPool,
    leads_to_pool: leadsToPool,
    campaigns_total: campaignIds.length,
    campaigns_reassigned: campaignIds.length - campaignsToPool,
    campaigns_to_pool: campaignsToPool,
    eligible_employee_count: eligibleCount,
    per_assignee: [...perAssignee]
      .map(([employee_id, counts]) => ({ employee_id, ...counts }))
      .sort((a, b) => b.leads - a.leads || a.employee_id.localeCompare(b.employee_id)),
  };
}
