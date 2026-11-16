# Permission audit: settings / me / user-signature / assistant / model-lab + Kuber AI

Repo: `C:\Users\rudra\Desktop\Kuber-Polyplast\Kuber` (read-only audit, 16 Nov 2026).

Guards today (`lib/auth/api-auth.ts`):
- `requireAuth`: valid JWT + active profile + company. Role comes from `profiles.role` (cached 30 s per instance), not the JWT. The service-role bearer comes back as `role:"manager", isSuperAdmin:true, companyId:null`.
- `requireManager`: `requireAuth` plus `role === "manager"`.
- `requireSuperAdmin`: `requireManager` plus `is_super_admin`. **Only one route uses it** (`PUT settings/keys/sending-accounts`). Its doc comment says "provider API keys", but every other keys route uses `requireManager`.
- Row rules (`lib/auth/scope.ts`) test only `role === "employee"` (or `!== "employee"`). They never look at `isSuperAdmin`.

Counts: **37 route files, 57 exported handlers** (settings 33, me 4, user-signature 2, assistant 10, model-lab 8). **21 Kuber AI tools** (14 read, 7 propose_*).

Abbreviations: Auth = requireAuth, Mgr = requireManager, SA = requireSuperAdmin.

---

## Part A: routes

### settings/ (core)

| Method + path | Guard today + inline checks | Does | Proposed scope(s) | Odd? |
|---|---|---|---|---|
| GET /settings | Auth. No role check: everyone reads all `SETTINGS_KEYS` (prompts, templates, signature, context) | read | open to all members (UI shows company default prompt as fallback). Could be `settings:read` | Employees can read every company prompt. That is intended |
| PATCH /settings | Auth. If `role !== "manager"` only `KNOWLEDGE_SETTINGS_KEYS` = `product_offerings`, `industry_keyword_groups` are allowed (403 lists the other keys). **Manager-only keys:** default_sender_name, system_prompt, client_industry, company_context, email_signature, brand_logo_path, signature_name/title/contact/company, email_subject_template, reply_classifier_prompt, reply_drafter_prompt, generic_email_subject, generic_email_body, followup_fallback_body, allow_html_emails. Optional `industry_keyword_groups_base` gives an optimistic-lock save (409 on conflict) | write (company) | knowledge keys → **new `knowledge:write`** (today every member has it); the rest → `settings:write` | `brand_logo_path` can be set to any string here, which skips the logo upload checks |
| GET /settings/usage | Mgr. `remaining` is set only when `isSuperAdmin`, else null. `status` and `message` go to every manager | read (calls provider credit checks) | `credits:read`. Exact numbers → new `credits:exact` (or keep it inside `keys:read`) | **The SA trim leaks.** `message` holds the number when a balance is low ("Firecrawl is out of credits (N left)", "OpenRouter … ($X left)", "Apollo is low … (N left)"). The keys/usage/* routes and the AI tool `usage_and_credits` also give exact numbers to every manager |
| GET /settings/logo | Auth | read (7-day signed URL) | open | – |
| POST /settings/logo | Mgr | write (storage + settings) | `settings:write` | – |
| DELETE /settings/logo | Mgr | delete | `settings:write` | – |
| GET /settings/assignment | Mgr | read | `settings:write` (or `leads:assign`) | No read-only scope covers it. Today read needs manager |
| PATCH /settings/assignment | Mgr | write (auto-assign strategy) | `settings:write` | – |
| POST /settings/industry-keywords | **Auth only** | **write, company-wide** (adds a keyword to the shared Industry Segments group, used by Prospects search) | `knowledge:write` (or `prospects:run`) | Yes, a company write that any member can do. It matches PATCH, where `industry_keyword_groups` is a knowledge key. Under the draft list (knowledge in `settings:write`) employees would lose it |
| GET /settings/prompt-meta | Auth | read (system_prompt updated_at) | open | – |
| GET /settings/signature | Auth, own `user_id` | read own | open (me/*) | Two routes write the same table, see below |
| PUT /settings/signature | Auth, own `user_id`. Needs full_name. Writes email = caller's email | write own | open | This is the one the UI uses (`lib/api-client.ts:1634/1638`) |

### settings/users

| Method + path | Guard + inline checks | Does | Proposed | Odd? |
|---|---|---|---|---|
| GET /settings/users | Mgr | read every profile in the company (role, is_super_admin, territory, sending_email) | `team:read` | – |
| POST /settings/users | Mgr. `role:"manager"` only when `caller.isSuperAdmin` | write (Supabase auth user + profile) | `team:write` + no-escalation | see rules below |
| PATCH /settings/users/[id] | Mgr + rules below | write (role, password, active, territory, sender, availability) + handover | `team:write` + no-escalation | see rules below |

**Exact rules today (these become the no-escalation rules):**

POST /settings/users (create):
1. The caller must be a manager.
2. `role` is `manager` or `employee`. **Only a super admin may create a manager.** A plain manager may only create employees (403 "Only the Super Admin can create manager accounts.").
3. An employee needs ≥1 territory country (zod). A manager is saved with `territory_countries = []`.
4. The auth user is created with `email_confirm:true` and `app_metadata.role = role`. The profile is inserted with `is_active:true`. If the profile insert fails, the auth user is deleted.
5. `is_super_admin` can never be set through the API. It is DB only.

PATCH /settings/users/[id] (edit). Checks run in this order:
1. The caller must be a manager. The target must exist in the caller's company (scoped read), else 404.
2. **Super admin target lock** (applies to every caller, the SA too): if the target `is_super_admin`, a `role` different from the current one gives 400 "role cannot be changed", and `is_active:false` gives 400 "cannot be deactivated". Every other field (password, name, territory, sender, availability) can still be changed.
3. **No self-deactivate:** if the target is a manager AND target == caller AND `is_active:false`, the call returns 400. (An employee cannot reach this route, so in practice nobody can deactivate themselves.)
4. **When the caller is not a super admin:**
   a. The target is a manager other than the caller → 403 "Only the Super Admin can manage manager accounts." This covers every field, including password, name, active and availability.
   b. Any `role` change (on anyone, the caller included) → 403 "Only the Super Admin can change a user's role."
   → So a plain manager can edit **themselves** (password, name, territory, sender, availability, but not role or self-deactivate) and **any employee** (password reset, name, territory, sender mailbox, availability, deactivate/reactivate).
5. **A super admin caller** can change the role of any non-SA user (promote or demote), edit or deactivate any non-SA manager, reset any password (another SA's too), and cannot deactivate self or any SA.
6. **Handover on deactivate** (`is_active:false`, the target holds non-deleted assigned leads or campaigns):
   - With no `handover_strategy` and no `reassign_to` → 400 `REASSIGN_REQUIRED` with held counts.
   - `reassign_to` alone means `manual`. Strategies: `manual` (the target must be an active **employee** in the company and not the departing user, else 400 INVALID_ASSIGNEE), `pool` (everything unassigned), `round_robin`, `territory` (no eligible employees → 409 NO_ELIGIBLE_EMPLOYEES).
   - The handover runs **before** the account is banned. If the later auth update fails, the work has moved and the account stays active.
   - Handover applies to any target that holds work, managers included.
7. Side effects: `password`/`role`/`is_active` → `auth.admin.updateUserById` (role goes into `app_metadata.role`, deactivate = ban for 876000h, reactivate = ban "none"). `sending_email` must be a connected Instantly mailbox with status 1. `territory_countries` is saved only when `role` is `employee` or not given (so a manager target can be given territories). `availability_status` is a separate online/offline flag.

No-escalation rules to carry into scopes: you cannot grant a scope you lack. Only the holder of a "team:admin"-type power can grant or edit `team:write` holders. The super admin can never be locked or demoted. Nobody can deactivate themselves. A password reset on someone counts as taking over that account, so it needs at least the same power as editing that person's scopes.

### settings/keys/*

| Method + path | Guard | Does | Proposed | Odd? |
|---|---|---|---|---|
| GET /settings/keys | Mgr | read key list (last4, status, errors, model, tier order). Never secrets | `keys:read` | – |
| POST /settings/keys | Mgr | write (Vault secret + row). Kicks drafting/scrape work | `keys:write` | Any manager can add keys. The doc comment says super admin |
| PATCH /settings/keys/[id] | Mgr | write (label/active/status/priority) | `keys:write` | – |
| DELETE /settings/keys/[id] | Mgr | delete (Vault trigger) | `keys:write` | Returns ok even if the id does not exist |
| POST /settings/keys/[id]/check | Mgr | reads the secret from the Vault, calls the provider live, updates status | `keys:write` (it changes status) | – |
| PUT /settings/keys/model | Mgr | write provider_settings.selected_model | `keys:write` (or `settings:write` "AI settings") | – |
| GET /settings/keys/models | Mgr | read (live provider catalog using the active key) | `keys:read` | – |
| PUT /settings/keys/reorder | Mgr | write priorities | `keys:write` | – |
| PUT /settings/keys/tier | Mgr | write llm_tier_config primary/fallback | `keys:write` / `settings:write` | – |
| GET /settings/keys/sending-accounts | Mgr | read Instantly mailboxes + the company default sender | `keys:read` (or `sending_accounts:write` holders) | – |
| PUT /settings/keys/sending-accounts | **SA** | write the company default sender (settings key) | `sending_accounts:write` | The only `requireSuperAdmin` route. Instantly is one shared workspace, so a company can pick another company's mailbox |
| GET /settings/keys/usage/ai | Mgr | read (LLM key checks with **exact `remaining`**) + draft volume | `credits:read` | Exact balance shown to every manager |
| GET /settings/keys/usage/apollo | Mgr | read Apollo credits, ledger, history | `credits:read` | – |
| PATCH /settings/keys/usage/apollo | Mgr | write `system_state` allowance (a **global, cross-company** table) | `keys:write` (platform-level) | **A manager of any company changes the Apollo budget that every company shares** |
| GET /settings/keys/usage/firecrawl | Mgr | read (exact remaining) | `credits:read` | Exact balance |
| GET /settings/keys/usage/instantly | Mgr | read | `credits:read` | – |
| GET /settings/keys/usage/jev | Mgr | read token/$ usage | `credits:read` | – |
| GET /settings/keys/usage/tavily | Mgr | read (exact remaining) | `credits:read` | Exact balance |
| (`?refresh=1` on usage GETs) | – | fresh credit checks hit the provider APIs | – | – |

### me/ and user-signature

| Method + path | Guard | Does | Proposed | Odd? |
|---|---|---|---|---|
| GET /me/availability | Auth (400 for the service role) | read own | open | – |
| PATCH /me/availability | Auth, own row | write own online/offline (affects auto-assignment) | open | – |
| GET /me/settings | Auth. Returns `is_super_admin: user.isSuperAdmin` + company default prompt/signature/sender | read own | open | The UI reads `is_super_admin` from here. Replace it with the scope list |
| PATCH /me/settings | Auth, own `user_settings` row: draft_prompt, draft_template, reply_prompt, signature, sender_name, theme, theme_mode | write own | open, but see gap: a **personal draft/reply prompt** changes what goes out to customers | An employee can fully override the AI prompt for their own leads. No scope covers it |
| GET /user-signature | Auth, own row | read own | open | **Looks dead.** No client code calls it (only a query-cache key with that name) |
| PATCH /user-signature | Auth, own row. Missing fields are saved as `""` | write own | open | Duplicates PUT /settings/signature. A partial PATCH blanks title/contact. Nothing in lib reads `user_signatures`. Candidate for deletion |

### assistant/

| Method + path | Guard | Does | Proposed | Odd? |
|---|---|---|---|---|
| POST /assistant/chat | Auth + `callerFromRequest` (needs companyId). Role only passes into the tools and the prompt | **spend** (LLM per turn) + read via tools | `assistant:use`. Tools filtered per scope (Part B) | – |
| POST /assistant/actions | Auth + caller. Token must match user+company, 30 min TTL, single use per instance. Runs by calling the app's own routes with the user's bearer | write / spend (depends on the kind) | `assistant:actions` + the target route's own scope (already enforced, because it calls the route) | `usedTokens` is held in memory per server instance, so a double confirm that hits two Vercel instances runs twice |
| GET /assistant/models | Mgr | read model overrides | `assistant:admin` | – |
| PUT /assistant/models | Mgr | write settings `assistant_models` | `assistant:admin` | – |
| GET /assistant/overview | Auth. Runs the `pipeline_overview` tool (employee filter) | read | `dashboard:read` (+ `dashboard:team`/`leads:all` for company-wide) | – |
| GET /assistant/threads | Auth, own user_id | read own | open (own chats) | – |
| GET /assistant/threads/[id] | Auth, own | read own | open | – |
| DELETE /assistant/threads/[id] | Auth, own | delete own | open | – |
| PATCH /assistant/threads/[id] | Auth, own (refuses another user's id, creates if missing) | write own | open | – |
| GET /assistant/usage | Mgr | read AI $ by purpose, model and **person** | `assistant:admin` (or `credits:read` + per-person under `assistant:admin`) | – |

### model-lab/

| Method + path | Guard | Does | Proposed | Odd? |
|---|---|---|---|---|
| GET /model-lab | Auth + inline `role !== "manager"` → 403 | read bench leads (no employee filter), models, prompt sets, scoreboard | `model_lab:read` | Inline check instead of requireManager |
| PUT /model-lab | Auth + inline manager | write bench/models (settings) | `model_lab:write` | – |
| POST /model-lab/generate | Auth + inline manager | **spend** (1 LLM email per model, up to 8) | `model_lab:write` (spends) | – |
| GET /model-lab/generate | Auth + inline manager | read last run + own votes | `model_lab:read` | – |
| POST /model-lab/prompt-sets | Auth + inline manager | write (insert/update by id) | `model_lab:write` | `scope:"personal"` is not enforced. Any manager can update, delete or list another manager's personal set |
| DELETE /model-lab/prompt-sets | Auth + inline manager | delete | `model_lab:write` | same |
| POST /model-lab/vote | Auth + inline manager | write own vote | `model_lab:read` (voting = judging) or `model_lab:write` | – |
| DELETE /model-lab/vote | **Auth only, no manager check** | delete own vote | same as POST | Not the same guard as POST. Harmless (own rows only) |

---

## Part B: Kuber AI

### How it works today
- `caller.ts` `callerFromRequest(req, user)` → `AssistantCaller {userId, email, role, companyId, db (company-scoped), token (user's bearer), baseUrl}`. **There is no `isSuperAdmin` on the caller.** Helpers that call scope.ts hard-code `isSuperAdmin:false` (shared.ts:87, inbox.ts:9, overview.ts:60).
- `context.ts`: `isManager(c) = c.role === "manager"`.
- `prompt.ts`: the dynamic block tells the model `(<role> — sees only their own assigned leads | sees the whole company)`. The static prompt says "managers see everything; employees see only leads assigned to them" and names the manager-only tools.
- **Registration:** `tools/index.ts` `buildAssistantTools(caller)` spreads `overviewTools, leadTools, organizationTools, campaignTools, inboxTools, actionTools` (all bound to the caller) into one object. `agent.ts` passes it to `streamText({tools})` and to `convertToModelMessages(..., {tools})`. **That function is the one place to filter the tool list per caller** (drop keys the caller lacks a scope for). Today nothing is dropped: manager-only tools stay visible and return an error at run time.
  - Watch-outs if you filter there: (1) the key order is kept fixed so the prompt cache stays warm, so each scope combination gets its own cache entry (filter, never reorder). (2) Saved chats can hold parts for a tool that has since been removed. `ignoreIncompleteToolCalls` is set, but check that `convertToModelMessages` accepts a finished part for an unknown tool. (3) `/assistant/overview` calls `overviewTools(caller).pipeline_overview` directly, so it skips any filter in index.ts.
- The employee filter is applied **inside each tool** with `caller.role === "employee"` (via `leadSelect` in lead-filter.ts:108, `accessibleCampaignIds`, `getUniboxScope`, or inline). To swap to scopes, replace `role === "employee"` with "lacks X:all" for the matching area.
- Actions (`actions.ts`): the model only proposes. `propose_*` signs a JWT (`sub` = user, `cid` = company, 30 min). Confirm → POST /assistant/actions → `executeAction` → `callApi` with the **user's own bearer** to the normal routes. So the target route's guard is the real check. The proposal-time manager checks only shape the UX.

### Tools

| Tool | Does | Today (role) | Proposed scope(s) | Confirm needs |
|---|---|---|---|---|
| pipeline_overview | read: lead/campaign-lead/campaign counts, needs-reply, unread, drafts waiting, failures | employee: own assigned leads, own campaigns, own unibox | `dashboard:read`. Company-wide needs `dashboard:team` (or leads:all + campaigns:all + unibox:all) | – |
| team_overview | read: per-teammate workload, campaigns owned, replies waiting | manager-only (returns MANAGER_ONLY error) | `dashboard:team` (or `team:read` + `leads:all`) | – |
| recent_activity | read: lead_events counts + latest rows, filter by teammate | employee: events on own leads only. Teammate names still resolve | `leads:read` (+ `leads:all` for company-wide) | – |
| drafts_overview | read: email/reply drafts per campaign | employee: own leads' drafts | `campaigns:read` (+ `campaigns:all`) and `unibox:read` for reply drafts | – |
| usage_and_credits | read: AI $ by purpose, model and **person** + last known credit balances with **exact remaining** | manager-only (any manager, not SA) | `assistant:admin` for per-person $, `credits:read` for balances (exact numbers behind whatever scope replaces the SA trim) | – |
| search_leads | read | employee: assigned_to = self (lead-filter.ts:108) | `leads:read` (+ `leads:all`) | – |
| lead_breakdown | read (group counts) | same filter | `leads:read` (+ `leads:all`) | – |
| get_lead | read: contact, company, campaigns, replies, notes, events | employee: own lead only | `leads:read` (+ `leads:all`). Replies part needs `unibox:read` | – |
| search_organizations | read | employee: only orgs that hold one of their leads | `organizations:read` (+ `leads:all` to see all) | – |
| get_organization | read + its leads | employee: leads filtered. "Not found" if none of theirs | `organizations:read` | Leak: the ambiguous-match branch returns up to 5 candidate org names **before** the employee check |
| list_campaigns | read | employee: `getAccessibleCampaignIds` | `campaigns:read` (+ `campaigns:all`) | – |
| get_campaign | read: settings, steps, breakdown, drafts, latest replies | employee: counts and replies filtered to own leads. Campaign settings/steps shown in full | `campaigns:read` (+ `campaigns:all`) | – |
| search_inbox | read threads | employee: unibox scope assigned_to = self | `unibox:read` (+ `unibox:all`) | – |
| get_thread | read messages (fenced) | employee: checks the thread's lead is theirs | `unibox:read` (+ `unibox:all`) | – |
| propose_create_campaign | proposes write (campaign + add leads) **+ spend** (it starts AI drafts) | any role. Lead set filtered for employees | `assistant:actions` + `campaigns:write` | POST /campaigns (Auth) + POST /campaigns/[id]/leads (assertCampaignAccess, employee leads only) + generate-drafts → `campaigns:write` (+ AI spend). Note: create starts drafting automatically |
| propose_add_to_campaign | proposes write | any role | `assistant:actions` + `campaigns:write` | POST /campaigns/[id]/leads → `campaigns:write` (+ access to that campaign and the leads) |
| propose_assign_leads | proposes write | **manager-only at proposal** (`!manager` → error) | `assistant:actions` + `leads:assign` | POST /leads/bulk-assign (requireManager) → `leads:assign` |
| propose_campaign_state | proposes pause / resume / **generate_drafts** (spend) | any role | `assistant:actions` + `campaigns:send` (pause/resume) / `campaigns:write` (drafts) | POST /campaigns/[id]/pause\|resume\|generate-drafts use **only assertCampaignAccess**, not assertCampaignSettingsAccess. So today an employee can pause or resume a shared campaign that holds teammates' leads → `campaigns:send` |
| propose_reveal_emails | proposes **spend** (1 Apollo credit per lead, ≤200) | **manager-only at proposal** | `assistant:actions` + `leads:import` (or a new `leads:enrich`/`credits:spend`) | POST /leads/enrich (requireManager) → same scope |
| propose_lead_note | proposes write (comment) | any role. Employee: own leads | `assistant:actions` + `leads:write` | POST /leads/[id]/comments (assertLeadAccess) → `leads:write` |
| propose_reply_draft | proposes write + spend (AI reply draft, never sent) | any role. Employee: thread must be on their lead | `assistant:actions` + `unibox:write` (or `unibox:reply`) | POST /reply-drafts/generate (assertThreadAccess) → `unibox:write` |

Rule for confirming: since `executeAction` goes through the real routes with the user's token, **confirming needs `assistant:actions` plus the target route's scope**. Check both again at confirm time, not only at propose time, because a scope can be taken away during the 30 min token life. Today only the route check runs at confirm. That is correct as long as the routes move to scopes.

---

## Odd findings
1. **The super-admin "exact credits" trim leaks**: `settings/usage` nulls `remaining` but `message` still holds the number when low. `keys/usage/{ai,firecrawl,tavily}` and the AI tool `usage_and_credits` give exact balances to every manager.
2. **The `requireSuperAdmin` comment does not match the code**: it says the provider-keys route family needs it, but all `settings/keys/*` routes use requireManager except `PUT sending-accounts`.
3. **Cross-company writes from a company manager**: `PATCH keys/usage/apollo` writes `system_state` (global table, scoped client exempts it) → one company's manager changes the shared Apollo allowance. `sending-accounts PUT` and `users PATCH sending_email` accept any mailbox in the shared Instantly workspace.
4. **`POST settings/industry-keywords` is Auth-only and writes company data.** It matches PATCH /settings treating `industry_keyword_groups` and `product_offerings` as employee-editable "knowledge". The draft scope list puts knowledge under `settings:write`, which would take this away from employees.
5. **`PATCH /settings` can set `brand_logo_path` to any string**, skipping the logo upload checks (manager only).
6. **Duplicate signature routes**: `/user-signature` (GET/PATCH) looks unused and blanks fields on a partial PATCH. `/settings/signature` is the live one. Nothing in `lib/` reads `user_signatures`, so it may not reach emails at all (company signature keys in settings do).
7. **Model lab**: inline `role !== "manager"` instead of a guard. `DELETE /model-lab/vote` has no manager check. "personal" prompt sets are visible to and editable by every manager.
8. **AssistantCaller has no isSuperAdmin**. Helpers pass a hard-coded `isSuperAdmin:false` into scope.ts. That is harmless today (scope.ts ignores it) but would break if scope.ts started reading it.
9. **`get_organization` leaks names to employees**: the ambiguous branch returns candidate orgs before the employee filter. Teammate names also leak to employees through `resolveAssignee` error text ("Team: …").
10. **Campaign pause/resume/generate-drafts** (target of `propose_campaign_state`) check only `assertCampaignAccess`, so an employee can pause a shared campaign holding teammates' leads. Campaign settings edits use the stricter `assertCampaignSettingsAccess`.
11. **Action replay**: `usedTokens` is held in memory per instance, so it is not a real single-use guard on Vercel.
12. **Users PATCH**: a plain manager can **reset any employee's password**. `territory_countries` is saved for a manager target when `role` is omitted. Handover runs before the auth ban, so a failed ban leaves the work moved and the account active.
13. **The role lives in `app_metadata.role` too**: `lib/auth/roles.ts` `isAppUser` (used by app/page.tsx, app-context.tsx, leads/[id]/page.tsx) signs out anyone whose JWT has no `app_metadata.role`. Removing roles must keep a "member" marker there or change those checks.
14. The 30 s profile cache means scope changes and revokes take up to 30 s per instance (the same holds for roles today).

## Scope list gaps
- **`knowledge:write`** (product_offerings, industry_keyword_groups, + `POST settings/industry-keywords`): today every member has it, and the draft folds it into manager-only `settings:write`.
- **Personal AI prompt override** (`me/settings` draft_prompt / draft_template / reply_prompt / sender_name): this changes customer-facing output. It needs a scope (e.g. `prompts:personal`), or say clearly that it is open.
- **Exact credit balances**: the SA-only "remaining" number has no scope. Add `credits:exact` or put it under `keys:read`, and apply it in keys/usage/* and `usage_and_credits` too.
- **Spending Apollo credits on reveal** (`leads/enrich`, `propose_reveal_emails`): `leads:import` may not fit. Consider `leads:enrich` / `credits:spend`.
- **Team admin vs team edit**: today there are three levels (manager edits employees and self; SA also creates and edits managers and changes roles; nobody touches the SA's role or active flag). One `team:write` cannot express "edit employees but not peers". Add something like `team:admin` (grant scopes / edit `team:write` holders), plus the rule "you may only grant scopes you hold".
- **Platform-level (cross-company) settings**: the Apollo allowance in `system_state` and the shared Instantly mailbox choice. These need a platform scope or a block, not a company scope.
- **Assignment strategy read**: `GET settings/assignment` has no read scope (`settings:read` or under `leads:assign`).
- **Company settings read**: `GET /settings` is open today. Decide if `settings:read` exists or it stays open.
- **AI provider config** (`keys/model`, `keys/tier`, `assistant/models`): decide between `keys:write`, `settings:write` and `assistant:admin`. Today all three are any-manager.
- **Model lab voting**: is judging `model_lab:read` or `:write`?
- **Kuber AI tool filter**: `buildAssistantTools` needs the scope set on `AssistantCaller` (and `/assistant/overview` needs the same check, since it bypasses index.ts).
