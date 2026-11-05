import { createAdminClient } from "@/lib/supabase/admin";
import { logLeadEvents } from "@/lib/services/lead-events";
import { canonicalCountryList } from "@/lib/territory";
import { allocateByTerritory, type Coverage } from "@/lib/services/territory-allocator";

// Territory is consulted only AT ASSIGNMENT TIME (review §5.4) — deliberately.
// If an employee's territory changes after leads were already routed to them,
// those existing leads are left alone; only future auto-assignments honor the
// new territory. Retroactively re-territorying an employee's whole book on
// every territory edit would silently move leads out from under whoever is
// actively working them, which is worse than the status quo.
type Db = ReturnType<typeof createAdminClient>;
export type AssignmentStrategy = "manual" | "round_robin" | "territory";

/**
 * Employees ELIGIBLE for automatic assignment (spec §2B/§3): role=employee,
 * is_active=true, AND availability_status='online'. Deactivated users can't be
 * assigned at all; offline users are temporarily excluded from round-robin and
 * territory routing (but can still receive a manual assignment, with a warning).
 *
 * `excludeId` drops one employee who would otherwise qualify. Handover needs it:
 * the person being deactivated is still active and online at the moment their
 * book is redistributed, so without this they would be a candidate to receive
 * their own leads back.
 */
export async function getEligibleEmployees(db: Db, excludeId?: string | null): Promise<string[]> {
  let q = db.from("profiles")
    .select("id")
    .eq("role", "employee")
    .eq("is_active", true)
    .eq("availability_status", "online");
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q.order("id");
  return (data ?? []).map((row) => row.id as string);
}

/**
 * The same eligible employees, each with the countries they cover.
 *
 * Coverage used to be a single `territory` column ('india' | 'foreign') matched
 * with `.eq()` in SQL. It is now a list of countries, and matching happens in
 * JS via canonicalCountry — because lead countries arrive from Apollo spelled
 * inconsistently ('US', 'Czechia', 'Tuerkiye'), and an `= any(array)` in SQL
 * would compare those raw strings and silently match nothing.
 *
 * Employees with an empty territory are dropped here rather than filtered
 * later: they cover nowhere, so they can never be a candidate.
 *
 * `excludeId` behaves as in getEligibleEmployees.
 */
export async function getCoverage(db: Db, excludeId?: string | null): Promise<Coverage[]> {
  let q = db.from("profiles")
    .select("id, territory_countries")
    .eq("role", "employee")
    .eq("is_active", true)
    .eq("availability_status", "online");
  if (excludeId) q = q.neq("id", excludeId);
  const { data } = await q.order("id");

  return (data ?? [])
    .map((row) => ({
      employeeId: row.id as string,
      countries: new Set(canonicalCountryList(row.territory_countries as string[] | null)),
    }))
    .filter((c) => c.countries.size > 0);
}

/** Workspace-level exclusion counts for assignment summaries (spec §3 response). */
async function getExclusionCounts(db: Db): Promise<{ excluded_offline: number; excluded_deactivated: number }> {
  const [{ count: offline }, { count: deactivated }] = await Promise.all([
    db.from("profiles").select("id", { count: "exact", head: true })
      .eq("role", "employee").eq("is_active", true).eq("availability_status", "offline"),
    db.from("profiles").select("id", { count: "exact", head: true })
      .eq("role", "employee").eq("is_active", false),
  ]);
  return { excluded_offline: offline ?? 0, excluded_deactivated: deactivated ?? 0 };
}

/**
 * Round-robin's rotation lane. Territory routing no longer uses a lane — with
 * arbitrary per-employee country lists there is no fixed set of regions to keep
 * cursors for, and the allocator balances within the batch instead.
 */
export type Lane = "global";

/**
 * The next `count` assignees for `lane`, in order — rotation, not load-balancing.
 * Deliberately does not consult how many leads anyone already has: the cursor
 * advances one employee per lead, so N leads across M employees divide evenly and
 * a remainder falls to whoever the cursor reaches first (8 across 3 → 3/3/2).
 *
 * The cursor lives in the database and is advanced under a row lock, so parallel
 * callers (several enrichments finishing at once) cannot read the same position
 * and hand the same employee both leads. One call covers a whole batch, so a
 * 500-lead import costs one round-trip per lane rather than 500.
 *
 * Returns [] only when the lane has no candidates at all; callers treat a short
 * result as "leave in the pool" rather than assigning to undefined.
 */
export async function pickRoundRobin(db: Db, lane: Lane, candidateIds: string[], count: number): Promise<string[]> {
  if (candidateIds.length === 0 || count < 1) return [];

  // The cursor is per-company (assignment_cursors is keyed on company_id, lane),
  // so each tenant rotates over its own employees independently. Resolve the
  // company from a candidate rather than taking it as a parameter: candidates
  // are always profiles of one company, and this stays correct whether the
  // caller handed us a company-scoped client or the enrichment relay's
  // unscoped admin client. One lookup per batch, not per lead.
  const { data: owner } = await db
    .from("profiles")
    .select("company_id")
    .eq("id", candidateIds[0])
    .maybeSingle();
  if (!owner?.company_id) return [];

  const { data, error } = await db.rpc("assignment_pick_round_robin", {
    p_company_id: owner.company_id,
    p_lane: lane,
    p_candidate_ids: candidateIds,
    p_count: count,
  });
  // Surfaced rather than silently falling back to a local pick: a broken cursor
  // that quietly degrades to "always the same employee" is the exact failure this
  // function replaced, and it is invisible until someone audits the lead counts.
  if (error) throw new Error(`Round-robin pick failed: ${error.message}`);
  return (data as string[] | null) ?? [];
}

/** Ids per PostgREST .in() filter: ~400+ uuids make the URL too long for the gateway. */
const ID_CHUNK = 200;

/** Rich result summary for a bulk assignment (spec §3/§4). */
export type AssignmentSummary = {
  total: number;                    // leads processed
  newly_assigned: number;           // were unassigned (pool), now assigned
  reassigned: number;               // were assigned to someone else, now moved
  skipped_already_assigned: number; // left untouched because they were already assigned
  skipped_not_ready: number;        // still enriching (New) → can't be worked yet, left alone
  unmatched: number;                // territory/RR: no eligible employee (or no country) → left in pool
  eligible_employee_count: number;  // distinct eligible employees available for this run
  excluded_offline: number;         // active employees skipped for being offline
  excluded_deactivated: number;     // deactivated employees (never eligible)
  manual_target_offline: boolean;   // manual: chosen target is offline (allowed, but warned)
};

/**
 * A lead is workable — and therefore assignable to an employee — only once it
 * has an email AND enrichment has concluded (enriched, or input_required with a
 * usable email via the generic template). "New"/"enriching" leads are still in
 * the pipeline and must NOT be handed to an employee (they may still be
 * archived out entirely if Apollo never returns an email). Unassigning (moving
 * back to the pool) is always allowed regardless of readiness.
 */
function leadIsAssignable(row: { email: string | null; status: string | null }): boolean {
  return !!row.email && (row.status === "enriched" || row.status === "input_required");
}

/**
 * Assigns a specific set of leads under an explicitly-chosen strategy (the
 * bulk "Assign" action on the Leads page, or the picker on Apollo/Excel
 * imports). Returns a full summary (spec §3).
 *
 * - "manual": every eligible lead goes to `assignedTo` (or the pool when null).
 *   A deactivated target is rejected upstream; an offline target is allowed but
 *   flagged (`manual_target_offline`).
 * - "round_robin": distributed least-loaded first across all ELIGIBLE (active +
 *   online) employees.
 * - "territory": each region gets its own least-loaded picker seeded with
 *   region-scoped loads (review §3.7); a lead whose region has no eligible rep,
 *   or no country at all, is left unmatched in the pool.
 *
 * When `skipAlreadyAssigned` is true, any lead that already has an owner is
 * left completely untouched (spec §4) — the safeguard against silently
 * yanking a lead out from under whoever is working it.
 */
export async function bulkAssignByStrategy(
  db: Db,
  leadIds: string[],
  strategy: AssignmentStrategy,
  assignedTo: string | null,
  skipAlreadyAssigned = false,
): Promise<AssignmentSummary> {
  const now = new Date().toISOString();

  // Read in chunks: one .in() of ~400+ uuids is rejected by the gateway (the
  // URL gets too long), which used to make a big selection silently assign
  // nothing. The route caps the request at 1,000 ids.
  const rows: Array<{ id: string; country: string | null; assigned_to: string | null; email: string | null; status: string | null }> = [];
  for (let i = 0; i < leadIds.length; i += ID_CHUNK) {
    const { data: leads, error } = await db.from("leads").select("id, country, assigned_to, email, status").in("id", leadIds.slice(i, i + ID_CHUNK));
    if (error) throw new Error(error.message);
    rows.push(...((leads ?? []) as typeof rows));
  }
  const exclusions = await getExclusionCounts(db);

  const summary: AssignmentSummary = {
    total: rows.length,
    newly_assigned: 0,
    reassigned: 0,
    skipped_already_assigned: 0,
    skipped_not_ready: 0,
    unmatched: 0,
    eligible_employee_count: 0,
    excluded_offline: exclusions.excluded_offline,
    excluded_deactivated: exclusions.excluded_deactivated,
    manual_target_offline: false,
  };

  // Guard used by every strategy: block assigning a not-ready lead TO an
  // employee. `target` null (manual → pool) is always allowed.
  function blockedNotReady(row: { email: string | null; status: string | null }, target: string | null): boolean {
    if (!target) return false;
    if (leadIsAssignable(row)) return false;
    summary.skipped_not_ready++;
    return true;
  }

  // Records one lead move and updates the summary tallies. Nothing is written
  // here: moves are grouped by new owner and written by flush() — one UPDATE
  // per owner (chunked) and one lead_events insert — instead of 2 trips per lead.
  const moves = new Map<string | null, string[]>();
  const events: Parameters<typeof logLeadEvents>[1] = [];
  function applyAssignment(leadId: string, prior: string | null, next: string | null) {
    const ids = moves.get(next);
    if (ids) ids.push(leadId); else moves.set(next, [leadId]);
    if (next && !prior) {
      summary.newly_assigned++;
      events.push({ leadId, event: "assigned", detail: "Assigned to an employee", metadata: { assignee_id: next } });
    } else if (next && prior && prior !== next) {
      summary.reassigned++;
      events.push({ leadId, event: "reassigned", detail: "Reassigned to a different employee", metadata: { from: prior, to: next } });
    } else if (!next && prior) {
      events.push({ leadId, event: "unassigned", detail: "Returned to the pool", metadata: { from: prior } });
    }
  }
  async function flush() {
    for (const [next, ids] of moves) {
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        await db.from("leads").update({ assigned_to: next, assigned_at: next ? now : null }).in("id", ids.slice(i, i + ID_CHUNK));
      }
    }
    await logLeadEvents(db, events);
  }

  if (strategy === "manual") {
    if (assignedTo) {
      const { data: target } = await db
        .from("profiles")
        .select("id, is_active, availability_status")
        .eq("id", assignedTo)
        .maybeSingle();
      if (!target || !target.is_active) throw new Error("Employee not found or inactive");
      summary.manual_target_offline = target.availability_status === "offline";
      summary.eligible_employee_count = 1;
    }
    for (const lead of rows) {
      const prior = (lead.assigned_to as string | null) ?? null;
      if (skipAlreadyAssigned && prior) { summary.skipped_already_assigned++; continue; }
      if (prior === assignedTo) { summary.skipped_already_assigned++; continue; } // already theirs
      if (blockedNotReady(lead, assignedTo)) continue;
      applyAssignment(lead.id, prior, assignedTo);
    }
    await flush();
    return summary;
  }

  // Both rotating strategies settle which leads are actually in play BEFORE
  // drawing assignees, so a skipped lead never burns a cursor position and
  // leaves a gap in the rotation.
  type Target = { id: string; prior: string | null; country: string | null };
  const eligibleForRotation: Target[] = [];
  for (const lead of rows) {
    const prior = (lead.assigned_to as string | null) ?? null;
    if (skipAlreadyAssigned && prior) { summary.skipped_already_assigned++; continue; }
    if (blockedNotReady(lead, "pending")) continue;
    eligibleForRotation.push({
      id: lead.id as string,
      prior,
      country: (lead.country as string | null) ?? null,
    });
  }

  if (strategy === "territory") {
    // The whole selection is one batch, so the allocator can see every lead at
    // once — forced regions settle before contested ones and the split comes
    // out even. priorInBatch is empty: this run starts from zero and nobody's
    // lifetime book is consulted (see territory-allocator.ts).
    const coverage = await getCoverage(db);
    const { assignments, unmatched } = allocateByTerritory(
      eligibleForRotation.map((t) => ({ id: t.id, country: t.country })),
      coverage,
    );

    summary.unmatched += unmatched.length;
    summary.eligible_employee_count = new Set(assignments.values()).size;

    for (const target of eligibleForRotation) {
      const assigneeId = assignments.get(target.id);
      if (!assigneeId) continue; // already tallied in unmatched
      applyAssignment(target.id, target.prior, assigneeId);
    }
    await flush();
    return summary;
  }

  // round_robin: territory is intentionally ignored — every eligible employee is
  // in one rotation regardless of which region the lead belongs to.
  const candidates = await getEligibleEmployees(db);
  summary.eligible_employee_count = candidates.length;
  const picks = await pickRoundRobin(db, "global", candidates, eligibleForRotation.length);
  for (const [i, target] of eligibleForRotation.entries()) {
    const assigneeId = picks[i];
    if (!assigneeId) { summary.unmatched++; continue; }
    applyAssignment(target.id, target.prior, assigneeId);
  }
  await flush();
  return summary;
}

type ImportLeadRow = { id: string; country: string | null; assigned_to: string | null };

/**
 * Per-call memo for autoAssignEnrichedLeads. One org's leads usually share one
 * import, so the workspace default, a manual target's status, coverage, the
 * eligible employees and the import's lead rows are read ONCE per call instead
 * of once per lead. The import rows are kept current in memory as leads are
 * assigned (autoAssignEnrichedLeads updates them), which is exactly what the
 * per-lead re-read used to see. Lives for one call only (seconds).
 */
type AssignMemo = {
  defaultStrategy?: Promise<AssignmentStrategy>;
  targetActive: Map<string, Promise<boolean>>;
  coverage?: Promise<Coverage[]>;
  eligible?: Promise<string[]>;
  importLeads: Map<string, Promise<ImportLeadRow[] | null>>;
};

function memoGet<K, V>(map: Map<K, Promise<V>>, key: K, load: () => Promise<V>): Promise<V> {
  let p = map.get(key);
  if (!p) { p = load(); map.set(key, p); }
  return p;
}

/**
 * Resolves who a ready lead should auto-assign to, or null to leave it in the
 * Manager's pool. Strategy comes from `strategyOverride` when supplied (the
 * lead's import-time choice — deferred assignment), otherwise the workspace
 * `assignment_settings` default. `manualTarget` is only consulted for the
 * "manual" strategy.
 */
export async function resolveAssignee(
  db: Db,
  leadCountry: string | null | undefined,
  strategyOverride?: AssignmentStrategy,
  manualTarget?: string | null,
  /** Territory routing balances across the whole import, so it needs to know which lead this is. */
  lead?: { id: string; importId: string | null },
  memo?: AssignMemo,
): Promise<string | null> {
  let strategy = strategyOverride;
  if (!strategy) {
    const load = async () => {
      const { data: settings } = await db
        .from("assignment_settings")
        .select("strategy")
        .limit(1)
        .maybeSingle();
      return (settings?.strategy as AssignmentStrategy) ?? "manual";
    };
    strategy = await (memo ? (memo.defaultStrategy ??= load()) : load());
  }

  if (strategy === "manual") {
    // Global manual = leave in pool. Import-time manual = the chosen employee
    // (validated active; a since-deactivated target falls back to the pool).
    if (!manualTarget) return null;
    const load = async () => {
      const { data: target } = await db
        .from("profiles").select("id, is_active").eq("id", manualTarget).maybeSingle();
      return !!target?.is_active;
    };
    const active = await (memo ? memoGet(memo.targetActive, manualTarget, load) : load());
    return active ? manualTarget : null;
  }

  if (strategy === "territory") {
    const coverage = await (memo ? (memo.coverage ??= getCoverage(db)) : getCoverage(db));
    if (coverage.length === 0) return null;

    // Leads assign one at a time as enrichment finishes, so there is no batch
    // in hand — but the import IS the batch, and all of its lead rows exist
    // from the moment of import even while they are still enriching. Recover
    // it, run the same allocator over the whole import, and take this lead's
    // answer. That is what lets a lead in a contested region wait for someone
    // who is not already buried under a region only they can serve.
    //
    // Recomputed per lead rather than stored: it self-corrects when leads are
    // archived or countries edited. A stored plan would go stale invisibly.
    // Within one autoAssignEnrichedLeads call the import's rows are read once
    // and kept current in memory (see AssignMemo).
    if (lead?.importId) {
      const importId = lead.importId;
      const load = async () => {
        const { data } = await db
          .from("leads")
          .select("id, country, assigned_to")
          .eq("import_id", importId)
          .eq("is_deleted", false);
        return (data as ImportLeadRow[] | null) ?? null;
      };
      const importLeads = await (memo ? memoGet(memo.importLeads, importId, load) : load());

      if (importLeads && importLeads.length > 0) {
        // Leads already handed out from THIS IMPORT — never anyone's lifetime
        // book, which is the distinction that keeps 69062e2's pile-up away.
        const priorInBatch = new Map<string, number>();
        const pending: { id: string; country: string | null }[] = [];
        for (const row of importLeads) {
          const owner = row.assigned_to as string | null;
          if (owner) priorInBatch.set(owner, (priorInBatch.get(owner) ?? 0) + 1);
          else pending.push({ id: row.id as string, country: (row.country as string | null) ?? null });
        }

        const { assignments } = allocateByTerritory(pending, coverage, priorInBatch);
        return assignments.get(lead.id) ?? null;
      }
    }

    // No import to balance against (a hand-added lead): allocate this one lead
    // on its own — still correctly scoped to whoever covers its country.
    const { assignments } = allocateByTerritory(
      [{ id: lead?.id ?? "one", country: leadCountry ?? null }],
      coverage,
    );
    return assignments.get(lead?.id ?? "one") ?? null;
  }

  const candidates = await (memo ? (memo.eligible ??= getEligibleEmployees(db)) : getEligibleEmployees(db));
  const [assigneeId] = await pickRoundRobin(db, "global", candidates, 1);
  return assigneeId ?? null;
}

/** The deferred import choice for a lead, or null when it has no import / no stored choice. */
async function importChoiceFor(
  db: Db,
  importId: string | null,
): Promise<{ strategy: AssignmentStrategy; target: string | null } | null> {
  if (!importId) return null;
  const { data } = await db
    .from("imports")
    .select("assignment_strategy, assignment_target")
    .eq("id", importId)
    .maybeSingle();
  if (!data?.assignment_strategy) return null;
  return {
    strategy: data.assignment_strategy as AssignmentStrategy,
    target: (data.assignment_target as string | null) ?? null,
  };
}

/**
 * Auto-assigns still-unassigned leads under an org once they are ready to work —
 * that is, either fully enriched OR input_required (the company had no usable
 * website / enrichment failed, but the lead has an email and can be worked with
 * the generic template). New/enriching leads are intentionally left in the pool.
 *
 * Each lead is routed by its own import's stored choice (deferred assignment,
 * planning.md Phase 4 / Q5) — this is the ONLY place an Apollo/Excel import's
 * assignment actually takes effect, so an employee never receives a raw "New"
 * shell that might still get archived. Falls back to the workspace default for
 * leads with no import-time choice.
 */
export async function autoAssignEnrichedLeads(db: Db, orgId: string): Promise<void> {
  const { data: leads } = await db
    .from("leads")
    .select("id, country, import_id")
    .eq("organization_id", orgId)
    .eq("is_deleted", false)
    .in("status", ["enriched", "input_required"])
    .is("assigned_to", null);
  if (!leads?.length) return;

  // Decide every lead first (same order, same rules as one-by-one), then write
  // one UPDATE per assignee and one lead_events insert. The memo replaces the
  // per-lead reads; the in-memory import rows stand in for the re-read that
  // used to see the previous lead's assignment.
  const memo: AssignMemo = { targetActive: new Map(), importLeads: new Map() };
  const choices = new Map<string, Promise<Awaited<ReturnType<typeof importChoiceFor>>>>();
  const byAssignee = new Map<string, string[]>();
  const events: Parameters<typeof logLeadEvents>[1] = [];

  try {
    for (const lead of leads) {
      const importId = (lead.import_id as string | null) ?? null;
      const choice = await (importId ? memoGet(choices, importId, () => importChoiceFor(db, importId)) : null);
      const assigneeId = await resolveAssignee(
        db,
        lead.country as string | null,
        choice?.strategy,
        choice?.target,
        { id: lead.id as string, importId },
        memo,
      );
      if (!assigneeId) continue;
      const ids = byAssignee.get(assigneeId);
      if (ids) ids.push(lead.id as string); else byAssignee.set(assigneeId, [lead.id as string]);
      events.push({
        leadId: lead.id as string, event: "assigned", detail: "Assigned to an employee",
        metadata: { assignee_id: assigneeId, via: choice ? `import_${choice.strategy}` : "auto" },
      });
      if (importId) {
        const row = (await memo.importLeads.get(importId))?.find((r) => r.id === lead.id);
        if (row) row.assigned_to = assigneeId;
      }
    }
  } finally {
    // Written even when a later lead threw (e.g. a round-robin cursor error),
    // so leads already decided are not lost — as when each was written in turn.
    const now = new Date().toISOString();
    for (const [assigneeId, ids] of byAssignee) {
      await db.from("leads").update({ assigned_to: assigneeId, assigned_at: now }).in("id", ids);
    }
    await logLeadEvents(db, events);
  }
}
