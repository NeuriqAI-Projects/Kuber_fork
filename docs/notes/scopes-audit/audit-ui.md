# UI permission audit (read-only), Kuber dev repo, 16 Nov 2026

How it works today:
- Client role = JWT `app_metadata.role` (`lib/auth/roles.ts:getUserRole`, exposed as `useApp().role`). Only `"manager" | "employee"`. Super admin is NOT in the JWT. The UI reads `is_super_admin` from `/api/v1/me/settings` (settings-view) or from the users list (team-view).
- Server pages: only `app/(app)/layout.tsx` calls `requireAppSessionContext()` (profiles row: active + company). **`requireManagerSession()` is defined but never used by any page.** No page has a server-side role guard.
- APIs use `profiles.role` (via `requireAuth`/`requireManager`/`requireSuperAdmin`). So the JWT role (UI) and the profiles role (API) can drift until the token refreshes.

## 1. Pages under app/(app)/

| Route / file | Server guard today | Server-side data | Role filter on that data | Client-side role gate | Proposed page scope |
|---|---|---|---|---|---|
| `(app)/layout.tsx` | `requireAppSessionContext()` (logged in, provisioned, `is_active`, has `company_id`) | `getLeadsCount(db)` → sidebar "Leads" count | **No.** Company-wide count, not filtered by `assigned_to` (employee sees company total until the Leads page reloads it) | — | none (any active member). Count must respect `leads:all` (own vs all) |
| `dashboard/page.tsx` | layout only | none (client `DashboardClient`) | API `dashboard/analytics` picks company vs own by role | imports card manager-only (`dashboard-client.tsx:47,56`) | `dashboard:read`; company-wide numbers + imports card = `dashboard:team` |
| `unibox/page.tsx` | layout only | none | API `getUniboxScope` = own threads for employee | none | `unibox:read` (all threads = `unibox:all`) |
| `leads/page.tsx` (client, 1683 lines) | layout only | none | API `leads` filters employee to `assigned_to` | many (see §4) | `leads:read` (all leads = `leads:all`); Organizations tab = `organizations:read`; scored views = `prospects:read` |
| `leads/[id]/page.tsx` (client) | layout + client `isAppUser` check | none (cache / `/api/v1/leads/[id]`) | API 404/403 if employee not owner | none | `leads:read` |
| `leads/add/page.tsx` (client) | layout only | none | — | opens Add-leads only if `role==="manager"`, else redirects to /leads | `leads:import` (or `leads:write` for manual add) |
| `campaigns/page.tsx` | layout only | none | API `campaigns` employee = campaigns they created/are assigned/hold a lead in | owner filter/column manager-only | `campaigns:read` (all = `campaigns:all`) |
| `campaigns/[id]/page.tsx` | layout only | none | same as above + per-lead filter | Credits tab manager-only, settings edit by `canEditSettings` | `campaigns:read` |
| `model-lab/page.tsx` | layout only | none | API returns 403 "Managers only" for employees | **none** (only nav hides it) | `model_lab:read` (generate/vote/save sets = `model_lab:write`) |
| `credits/page.tsx` (client) | layout only | none | APIs `requireManager` | `credits-view.tsx:33` shows "Only managers…" text | `credits:read` (key panels `keys:read`, edits `keys:write`) |
| `settings/page.tsx` (client) | layout only | none | — | per section (see §3) | none (personal tabs are for everyone); sections gated individually |

## 2. NAV_ITEMS (`app/(app)/app-shell.tsx:52-63`, filter at `:92`)

| href | label | managerOnly today | Proposed scope |
|---|---|---|---|
| /dashboard | Dashboard | false | `dashboard:read` |
| /unibox | Unibox | false | `unibox:read` |
| /leads | Leads | false | `leads:read` (or `organizations:read`, either opens the page) |
| /campaigns | Campaigns | false | `campaigns:read` |
| /model-lab | Model Lab | **true** | `model_lab:read` |
| /credits | Credits | **true** | `credits:read` |
| /settings | Settings | false | none (always shown) |

The ⌘K "Go to" list reuses `visibleNavItems`, so it follows the same rule.

## 3. Settings sections (`components/app/settings-view.tsx`)

Top nav: employees get `NAV_ITEMS` (profile, ai, knowledge, appearance, account). Managers get `MANAGER_NAV_ITEMS` + team + email (`:243`). The sidebar groups are at `:345-355`.

| Section id | Sub-tab | Who sees it today | Saves to | Per-user or company | Proposed scope |
|---|---|---|---|---|---|
| profile | — | all. Role badge `:811`. "Assignment / Availability" card only `role==="employee"` (`:825`) | `/me/availability` | per-user | none. Availability card: show to "members who can own leads", not by role |
| ai | my-writing | all | `/me/settings` (draft prompt/template, reply prompt) | per-user | none (or `assistant:use`-style "own writing" — keep open) |
| ai | my-signature | all | `/me/settings` (signature, sender name) | per-user | none |
| ai | template | manager (`:917`) | `/settings` `system_prompt` | company | `settings:write` |
| ai | default | manager (`:935`) | `/settings` generic subject/body | company | `settings:write` |
| ai | followup | manager (`:964`) | `/settings` `followup_fallback_body` | company | `settings:write` |
| ai | html | manager (`:991`) | `/settings` `allow_html_emails` | company | `settings:write` |
| ai | replies | manager (`:1010`) | `/settings` `reply_drafter_prompt` | company | `settings:write` |
| ai | footer | manager (`:1023`) | `/settings` `signature_contact` | company | `settings:write` |
| knowledge | company | manager (`:249`, fallback `:332`) | `/settings` sender name, industry, context (`:541` only sent when manager) + `/settings/logo` (requireManager) | company | `settings:write` |
| knowledge | products | **all** | `/settings` `product_offerings` (API allows employees: `KNOWLEDGE_SETTINGS_KEYS`) | company | needs its own scope (see gaps) — today any member |
| knowledge | industry-segments | **all** | `/settings` `industry_keyword_groups` + `/settings/industry-keywords` (requireAuth) | company | same as products |
| appearance | — | all | `/me/settings` theme, theme_mode | per-user | none |
| account | — | all | Supabase `auth.updateUser` (password) | per-user | none |
| team | — | manager (`:1360`, plus TeamView self-guard) | `/settings/users` | company | `team:read` to see, `team:write` to change |
| email | — | manager (`:1362`) | `/settings/keys/sending-accounts` GET = manager, PUT = **super admin** | company | `sending_accounts:write` (read = `keys:read`) |

Deep links: `?section=team` or `?section=email` as an employee sets the section, then renders an empty page (no fallback).

## 4. Role-based UI checks

| file:line | What it hides / shows | Proposed `can(...)` |
|---|---|---|
| `app/(app)/app-shell.tsx:92` | nav items with `managerOnly` | per item, §2 |
| `app/(app)/app-shell.tsx:256` | polls `/api/v1/prospects?summary=badge` → "N to review" badge on Leads | `prospects:read` |
| `app/(app)/app-shell.tsx:639` | Org drawer "Add lead" button (opens Add-leads in edit mode) | `leads:write` (+ `organizations:write`, it PATCHes the org) |
| `app/(app)/app-shell.tsx:459` (not role-gated) | Apollo credits pill shown to everyone | `credits:read` (today: everyone) |
| `app/(app)/dashboard/dashboard-client.tsx:47,56` | loads + shows Imports card | `dashboard:team` (or `leads:import`) |
| `app/(app)/campaigns/campaigns-client.tsx:66` | loads users list | `team:read` (or `campaigns:all`) |
| `app/(app)/campaigns/campaigns-client.tsx:120,154` | Owner filter select | `campaigns:all` |
| `app/(app)/campaigns/campaigns-client.tsx:203,245` | Owner column | `campaigns:all` |
| `app/(app)/campaigns/campaigns-client.tsx:270-297` (not gated) | Pause / Resume / Delete row buttons for everyone | `campaigns:send` (pause/resume), `campaigns:delete` |
| `app/(app)/leads/page.tsx:583-591` | loads users list for Assign dialog | `leads:assign` |
| `app/(app)/leads/page.tsx:992` | "Assign" toolbar button (bulk assign dialog) | `leads:assign` |
| `app/(app)/leads/page.tsx:1006` | Create campaign button style only (primary for employees) | cosmetic; button itself = `campaigns:write` |
| `app/(app)/leads/page.tsx:1013` | "Add leads" button | `leads:import` |
| `app/(app)/leads/page.tsx:1120` | bulk "Delete (N)" | `leads:delete` |
| `app/(app)/leads/page.tsx:1290` | Kanban "Retry all failed" enrichment | `leads:import` (spends Firecrawl) |
| `app/(app)/leads/page.tsx:641,978,1155,1174,1245,1267,1507` (not gated) | scored-orgs fetch, Running-searches pill/bar, Approve/Decline cells, scored drawer | `prospects:read`; decide = `prospects:run` (or new `prospects:decide`) |
| `app/(app)/leads/add/page.tsx:18` | opens Add-leads modal | `leads:import` |
| `components/app/add-leads-drawer.tsx:52-72` | non-managers forced to "manual" section, no source rail | Apollo/Excel/Company/Scored = `leads:import`, `prospects:run`; manual = `leads:write` |
| `components/app/lead-drawer.tsx:613-614` | loads users list for Owner select | `leads:assign` |
| `components/app/lead-drawer.tsx:879` | "Owner" reassign select | `leads:assign` |
| `components/app/lead-drawer.tsx:1009` | Retry / Enrich (rescrape org) button | `organizations:write` (spends credits; maybe `leads:import`) |
| `components/app/lead-drawer.tsx:1041-1056` (not gated) | inline edit org "What they do" / "Who they sell to" | `organizations:write` |
| `components/app/org-drawer.tsx:325-332` (not gated) | "Edit" organization button | `organizations:write` |
| `components/app/campaign-drawer.tsx:1176` | `canEditSettings` = manager OR server `can_edit_settings` → Sequences/Options edit, write draft rows (`:2348,2426,5687,5903-6140`) | `campaigns:write` + (sole owner OR `campaigns:all`) |
| `components/app/campaign-drawer.tsx:3151,6132` | Campaign "Credits" tab | `credits:read` |
| `components/app/campaign-drawer.tsx:5157` (not gated) | Outbox "Add as lead" | `leads:write` |
| `components/app/create-campaign-modal.tsx:224-227` | loads employee list | `campaigns:assign` |
| `components/app/create-campaign-modal.tsx:319,378` | "Assign entire campaign to" select + `assignCampaign` call | `campaigns:assign` |
| `components/app/credits-view.tsx:33` | whole Credits page | `credits:read` |
| `components/app/assistant/assistant-panel.tsx:251` | manager vs employee suggestion chips | `leads:all` / `dashboard:team` (team wording) |
| `components/app/assistant/assistant-panel.tsx:350` | show AI cost per answer | `credits:read` |
| `components/app/assistant/assistant-skills.tsx:33` | "Team workload" skill | `dashboard:team` |
| `components/app/assistant/assistant-skills.tsx:34` | "AI spend" skill | `credits:read` |
| `components/app/assistant/assistant-skills.tsx:40` | "Assign leads" skill | `leads:assign` (+ `assistant:actions`) |
| `components/app/assistant/assistant-skills.tsx:43` | "Reveal emails" skill | `leads:import` (+ `assistant:actions`) |
| `components/app/assistant/assistant-skills.tsx:83` | filter by `managerOnly` | per skill |
| `components/app/keys-usage-assistant.tsx:112,139` | Credits > AI model picks + AI spend per person (inside Credits) | `keys:write` (models), `credits:read` (spend) |
| `components/app/lead-forms.tsx:146` | `useAssignableEmployees` (import "assign to") | see §5 |
| `components/app/settings-view.tsx:237-249` | nav / AI tabs / knowledge tabs by role | §3 |
| `components/app/settings-view.tsx:332` | employee on "company" tab falls back to products | `settings:write` |
| `components/app/settings-view.tsx:348,352` | "Company defaults" and "Workspace" nav groups | `settings:write`; `team:read`, `sending_accounts:write` |
| `components/app/settings-view.tsx:391` | sets `isSuperAdmin` from `/me/settings` (only used for badge) | drop; badge shows scope summary |
| `components/app/settings-view.tsx:541` | sends Company Details keys only if manager | `settings:write` |
| `components/app/settings-view.tsx:811` | role badge text (Super Admin / Manager / Employee) | show role template name |
| `components/app/settings-view.tsx:825` | Availability card only for employees | "can own leads" flag, not a permission |
| `components/app/settings-view.tsx:917,935,964,991,1010,1023` | 6 company AI tabs | `settings:write` |
| `components/app/settings-view.tsx:1360` | Team tab | `team:read` |
| `components/app/settings-view.tsx:1362` | Email & sending tab | `sending_accounts:write` |
| `components/app/team-view.tsx` | whole file, see below | `team:read` / `team:write` |

### team-view.tsx rules (all of them)

| Line | Rule today | Proposed |
|---|---|---|
| `:55-58` `roleLabel` | `is_super_admin` → "Super Admin", else Manager/Employee | template name or "Custom" |
| `:91-93` | non-manager → `router.replace("/dashboard")` | `team:read` |
| `:95-96` | load users + oversight + sending accounts only for managers | `team:read` (oversight needs `dashboard:team`; mailboxes `keys:read`) |
| `:122-131` | Add user: employee must have ≥1 territory country; manager gets `[]` | territory required only if member can own leads |
| `:258` | "Add user" button for every manager | `team:write` |
| `:336-341` | Role select in Add user offers Employee **and Manager** to every manager | only scopes the caller holds (API: only super admin may create managers) |
| `:174-177` `openHandover` | eligible = employee, active, online, not target | "members who can own leads" |
| `:228` | `isSuperAdmin` from users list (`me.is_super_admin`) | owner flag |
| `:229-232` | counts: Active (all), Managers (`role==="manager"`, incl. super admin and inactive), Employees (incl. inactive), Away (employee, active, offline) | Managers/Employees tiles become per-template or "can own leads" |
| `:239-248` | territory gaps counted only from active employees | lead-owners |
| `:250` | render nothing unless manager | `team:read` |
| `:389` `canEditRole` | only super admin, never on a super-admin row | `team:write` + cannot change owner + cannot grant scopes you lack |
| `:390` `canToggleActive` | never on super admin row; super admin → anyone; manager → employees only. Own row hidden for managers (role is manager) | `team:write`; never owner; never self; never someone with more scopes than you |
| `:395` `canEditMailbox` | super admin → anyone; manager → employees only (own row disabled) | `sending_accounts:write` (or `team:write`) |
| `:401-403` | "Away" status only for employees | lead-owners |
| `:422,453-464` | Workload column / mobile counts only for employees | lead-owners |
| `:495-503` | Territory editor only on employee rows, any manager can edit | `team:write`, lead-owners only |
| `:507-521` | Availability toggle only active employees; managers show "Always available" | `team:write`, lead-owners only |
| `:523-538` | Deactivate / Reactivate button per `canToggleActive`; deactivate asks server, REASSIGN_REQUIRED opens handover | `team:write` |
| `:552-564` | Handover modal; manual target list = active employees except target (offline allowed) | lead-owners |

Server rules behind it (`app/api/v1/settings/users/[id]/route.ts:38-65`, `users/route.ts:33-36`): super admin role + active locked; nobody deactivates self; non-super-admin can't touch other managers, can't change roles, can't create managers.

## 5. "Employee" pickers (who can RECEIVE work, not permissions)

| file:line | Picker | Filter today | What it really needs |
|---|---|---|---|
| `app/(app)/leads/page.tsx:586-588` | Bulk Assign dialog target (manual / round robin / territory) | `role==="employee" && is_active` | active members who can own leads |
| `components/app/lead-drawer.tsx:614` | Lead "Owner" select | same | active members who can own leads |
| `components/app/create-campaign-modal.tsx:227` | "Assign entire campaign to" | same | active members who can own campaigns/leads |
| `components/app/lead-forms.tsx:139-147` `useAssignableEmployees` (used by `lead-forms.tsx:803,1179,1578`, `company-lookup-form.tsx:734`, `prospect-finder-form.tsx:481`) | "Assign imported leads to" on Apollo / Excel / Manual / Company lookup / Scored import | same | active members who can own leads |
| `components/app/team-view.tsx:176` | handover default strategy (any eligible?) | employee, active, online, not target | online lead-owners |
| `components/app/team-view.tsx:243` | territory coverage warning | employee, active | active lead-owners |
| `components/app/team-view.tsx:556` | handover manual target list | employee, active, not target | active lead-owners |
| Server: `lib/services/assignment.ts:29,54,72,74`, `lib/auth/scope.ts:137` | round-robin/territory pools, campaign "employee owners" | `.eq("role","employee")` | same flag server-side (must change together with the UI) |

Suggestion: a separate boolean on the member (e.g. `receives_leads`) or derive "has `leads:read` but not `leads:all`". Do not tie it to `leads:assign`.

## 6. Mismatches (UI vs API)

Shown in UI, API refuses:

| UI | Who sees it | API | Result |
|---|---|---|---|
| Team > Add user > Role "Manager" (`team-view.tsx:336-341`) | every manager | `users/route.ts:35` only super admin may create managers | 403 for regular managers |
| Settings > Email & sending "Use account" (`email-sending-view.tsx:149-155`) | every manager | PUT `settings/keys/sending-accounts` = `requireSuperAdmin` | 403 for regular managers |
| Lead drawer "What they do" / "Who they sell to" inline edit (`lead-drawer.tsx:1041-1056`) | employees too | PATCH `organizations/[id]` = `requireManager` | 403 for employees |
| Org drawer "Edit" (`org-drawer.tsx:325-332`) | employees too | same | 403 for employees |
| "Add as lead" in Unibox (`unibox-thread-view.tsx:614`) and campaign Outbox (`campaign-drawer.tsx:5157`) | employees too | POST `unibox/threads/[id]/add-lead` = `requireManager` | 403 for employees |
| Leads > Organizations tab: scored kanban, scored filters, Running searches, Approve/Decline (`leads/page.tsx:641` fetch is enabled for everyone on the tab) | employees too | `/api/v1/prospects*` = `requireManager` | employee gets errors; scored views break |
| /model-lab page (no client or server gate, only nav hidden) | employees via URL | all model-lab routes 403 "Managers only" | page loads, every action errors |
| Add-leads drawer "manual" path for employees (`add-leads-drawer.tsx:52-72`) | dead today (every opener is manager-gated) | POST `/api/v1/leads` = `requireManager` | would 403; code comment says employees may add by hand, API says no |

API allows, UI hides (UI stricter):

| UI hidden | API |
|---|---|
| Campaign Credits tab (manager only) | `campaigns/[id]/credits` = `requireAuth`, no role check |
| Dashboard Imports card (manager only) | `/api/v1/imports` = `requireAuth`, employee-filtered |
| Team mailbox on a manager's own row (disabled for non-super-admin) | `users/[id]` PATCH lets a manager edit their own row |

Both allow, but worth a policy decision:

| UI | API |
|---|---|
| Campaign list Pause / Resume / Delete shown to every member with access (`campaigns-client.tsx:270-297`) | `pause`, `resume`, `hold`, DELETE `campaigns/[id]`, PATCH `campaigns/[id]` only use `assertCampaignAccess`. An employee who holds ONE lead in a shared campaign can delete / pause the whole campaign (incl. teammates' leads and the Instantly campaign). Only `config` and `steps` use `assertCampaignSettingsAccess`. |

## Odd findings

1. `requireManagerSession()` (`lib/server/session.ts:65`) is unused. No page has a server role guard; Model Lab, Credits, Team are hidden only on the client.
2. Layout sidebar "Leads" count is company-wide for employees (`layout.tsx:12` → `getLeadsCount(db)` has no `assigned_to` filter). Leaks the company total until the Leads page refreshes it.
3. Role source split: UI = JWT `app_metadata.role`, API = `profiles.role`. After a role change the UI is wrong until the token refreshes. Super admin is not in the JWT at all; two components fetch it separately.
4. Employee with one lead in a shared campaign can DELETE / pause / resume / hold / PATCH the whole campaign (API uses `assertCampaignAccess`, not `assertCampaignSettingsAccess`). The UI's `canEditSettings` idea is not applied to these.
5. Knowledge "Products" and "Industry segments" are company-wide writes open to every member (by design, `KNOWLEDGE_SETTINGS_KEYS`). The draft scope list has no scope for this; `settings:write` would either over-grant or lock employees out. Needs e.g. `knowledge:write`.
6. Draft list gaps: no scope for scored-company Approve/Decline (`prospects/decide`), email reveal / retry-enrich (`leads/enrich`, `rescrape`), assistant model picks (`assistant/models`), Apollo allowance (`setApolloCreditAllowance`). Map them before building `can()`.
7. "Managers" tile counts super admin and inactive managers; "Employees" tile counts inactive ones.
8. `/api/v1/settings/assignment` (company assignment strategy) has no UI caller.
9. Settings deep-link `?section=team|email` as an employee renders an empty page.
10. Scope escalation: today the "only super admin manages managers" rule is the only guard. With scopes, `team:write` must not let a member grant scopes they lack, or edit/deactivate the owner.
