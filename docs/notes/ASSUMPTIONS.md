# Role / Assignment / Campaign Logic — Assumptions & Needs-Confirmation

Implementation notes for the spec covering roles, availability, assignment
methods, multi-employee campaigns, counts, and Unibox visibility. Where the
brief was ambiguous, the safest interpretation was chosen and is documented
here. **No full UI redesign was done** — only the minimal UI needed to expose
the new logic.

## What was implemented

### §1 Roles
- Three roles: Super Admin, Manager, Employee (unchanged model, already enforced).
- **Employees can no longer create campaigns** — `POST /api/v1/campaigns` is now
  manager/super-admin only, and the "Create campaign" button is hidden from
  employees on the Leads page.
- Super Admin lock (no deactivate / no role change) and manager-can't-manage-manager
  were already in place.

### §2B Online / Offline availability (NEW)
- New `profiles.availability_status` column: `'online' | 'offline'`, default `'online'`.
  **Separate from `is_active`.**
  - `is_active = false` (deactivated): forced logout, cannot log in, excluded from
    **all** assignment.
  - `availability_status = 'offline'` (away/leave): still exists, can still log in,
    excluded from **automatic** assignment (round-robin/territory), and receives a
    **manual** assignment only **with a warning** (see decision below).
- Managers set an employee's availability from the Team page; employees can set
  their own from Settings → Profile (`PATCH /api/v1/me/availability`).

### §3 / §4 Assignment overhaul
- `bulkAssignByStrategy` now returns a full **summary**: `total`, `newly_assigned`,
  `reassigned`, `skipped_already_assigned`, `unmatched`, `eligible_employee_count`,
  `excluded_offline`, `excluded_deactivated`, `manual_target_offline`.
- Round-robin / territory candidates = active **and online** employees (offline
  excluded). Territory routing keeps its region-scoped least-loaded fairness.
- **Skip-already-assigned** option (`skip_already_assigned`): when set, leads that
  already have an owner are left untouched; only pool leads are processed. Wired into
  the Leads-page bulk-assign modal as a checkbox (shown when the selection includes
  already-owned leads), alongside the existing "reassign anyway" warning.
- Round-robin / territory with **zero eligible employees** is a hard `409
  NO_ELIGIBLE_EMPLOYEES` error (nothing is assigned) rather than a silent no-op.
- A manual target that is **offline** is allowed but the summary flags
  `manual_target_offline` so the UI warns.

### Deactivation handover (NEW)
Deactivating an employee who still holds work used to demand a single named
successor — leaving a one-employee workspace unable to deactivate anyone at all
("No other active employee is available to reassign to", with the confirm button
dead). `PATCH /api/v1/settings/users/[id]` now takes a `handover_strategy`:

| Strategy | Leads | Campaigns |
| --- | --- | --- |
| `manual` | all → the named `reassign_to` | all → the same person |
| `pool` | all unassigned | all unassigned |
| `round_robin` | rotated via the shared `assignment_cursors` lane | see below |
| `territory` | routed by lead country; anything uncovered → pool | see below |

- A bare `reassign_to` with no strategy still means `manual` — the pre-existing
  contract is unchanged, so nothing that already worked broke.
- `pool` is the only strategy with no eligibility requirement, and is therefore
  the escape hatch when the departing employee is the last one standing. The UI
  defaults to it (and disables round-robin/territory) when nobody is eligible.
- `round_robin` / `territory` with **zero eligible employees** is a hard `409
  NO_ELIGIBLE_EMPLOYEES`, matching the bulk-assign contract — silently pooling
  a book the manager asked to *distribute* would be a surprise.
- **Campaigns follow their own leads**: a campaign goes to whoever inherited the
  most of its leads in this handover (ties break on employee id, so a rerun lands
  the same way). Round-robining campaigns independently of their leads would
  manufacture the §2.7 ownership drift on every single handover. A campaign with
  no signal — none of the moved leads, or all of them pooled — falls back to a
  round-robin draw under `round_robin`, and to the pool under `territory` (a
  campaign has no country of its own to route on).

Two things this deliberately does **not** reuse from normal assignment:
- **The readiness gate.** `bulkAssignByStrategy` refuses to assign a lead that is
  not `enriched`/`input_required` — correct for routine routing, wrong here: the
  lead already belongs to someone who is leaving, so skipping it would strand it
  on a deactivated account. Every held lead moves, whatever its status.
- **The candidate list.** The departing user is still `is_active`/`online` at
  handover time, so `getEligibleEmployees`/`getCoverage` take an `excludeId` —
  without it, round-robin and territory would hand their own leads back to them.

Reads are **paged** (a book larger than PostgREST's row cap would otherwise be
half-transferred) and writes are **batched by destination** (1700 single-row
updates would not finish inside a serverless request). The handover runs
**before** the account is deactivated: if it fails, nothing moved and the account
is still active — visible and retryable, never orphaned.

The modal's "still holds N leads and M campaigns" now comes from the server's
`REASSIGN_REQUIRED` response rather than the Team roster, because the roster's
`campaign_count` means "campaigns *containing* their leads" (§6 below) while a
handover moves "campaigns *assigned to* them" — different numbers.

### §5 Campaign = multi-employee container (REVERSAL)
- Reversed the earlier "force one campaign = one employee at creation" behavior.
  A campaign is now a **container**: its leads keep their existing owners, and
  assigning the whole campaign to one employee is an **optional** action in the
  create modal ("Assign entire campaign to (optional)" → "Keep current lead owners"
  by default).
- Employee access is now **uniformly lead-assignment based** (`lib/auth/scope.ts`):
  - a **lead**: visible only if assigned to them;
  - a **campaign**: listed if it contains ≥1 lead assigned to them (or, back-compat,
    created-by/assigned-to them); the detail view shows **only their own leads** in it;
  - **threads / drafts / reply-drafts**: only when the underlying lead is assigned to
    them — never merely because the campaign is visible.
- This also resolves the §2.8 / §2.9 asymmetry (draft vs reply-draft access) — both
  are now lead-based for employees.

### §6 Manager counts
- Team/oversight `campaign_count` now = **distinct campaigns containing at least one
  lead assigned to that employee** (previously it counted campaigns they *created*).
  An employee with leads but none in any campaign correctly shows 0.

### §7 Unibox visibility
- Employee Unibox scope is now **strictly their assigned-lead threads** (dropped the
  campaign-level broadening that could reveal a co-worker's threads inside a shared
  campaign). Managers/super-admins see everything.

## Decisions taken where the brief was ambiguous (safest interpretation)

1. **Manual assignment to an offline employee: ALLOWED with a warning** (the spec's
   stated preference). It is not blocked. Deactivated targets remain blocked.
2. **Availability model = enum `availability_status`** (`online`/`offline`) rather than
   a bare `isOffline` boolean — more self-documenting and future-proof (room for
   `away`/`busy` later) without changing today's semantics.
3. **Campaign-level "assign whole campaign to X" kept** as an optional convenience.
   Under the container model it simply reassigns every lead in the campaign to that
   one employee (via the existing assign-with-reassign flow). Default is "keep current
   owners".
4. **Managers are NOT siloed from each other** — every manager sees all campaigns and
   all inboxes (spec §5/§7: "Manager … sees all"). Cross-manager isolation was
   previously reviewed and confirmed intentional.

## Needs confirmation from the client

- **Territory handling** (flagged in the brief itself): currently `india` / `foreign`
  only. Europe was folded into `foreign` in a prior change. Confirm whether more
  granular regions are wanted, and whether territory should ever be re-evaluated
  retroactively (today it is consulted only at assignment time — existing owners are
  never auto-moved when an employee's territory changes).
- **Offline + manual**: confirm "allow with warning" is preferred over "block".
- **Campaign container UX**: confirm the optional "assign entire campaign to one
  employee" control should remain, or whether campaigns should never carry a single
  owner at all.
- **Round-robin scope**: round-robin distributes across **all** eligible employees
  company-wide (not territory-filtered). Confirm that's intended, vs. a territory
  filter also applying to round-robin.
