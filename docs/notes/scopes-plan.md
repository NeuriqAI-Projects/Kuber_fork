# Scopes plan: replace Manager / Employee / Super Admin with per-member scopes

Status: **Decisions taken 16 Nov 2026. Building.** Branch `feat/scopes`.

## Decisions (16 Nov 2026, Rudraksh)
1. One owner per company. Dev: Lakshit = owner, Rudraksh = Manager template. Client: kuber@admin.com = owner.
2. Team: owner + `team:write` with the no-escalation rules in §3.
3. Templates: Manager / Employee presets only (no saved custom templates).
4. Lead owners = active members with `leads:read` and not `leads:all` (§4).
5. Odd rows: fix **A, B, C**. Keep D (Apollo allowance stays `keys:write`) and E (dead code stays). Owner-only list stays **empty**.
6. Drop `role` / `is_super_admin` in this work, as a second migration file run **after** the new code is live (migration A adds + backfills + makes `role` nullable; migration B drops). Only `team_oversight_counts` and `employee_campaign_stats` read them in the DB (checked 16 Nov); both are rewritten in A.
7. Tests: HTTP + Playwright on the Dev company (no local Postgres). Test agents are separate from the build.

Full audit tables (one row per handler, page, nav item, settings section, button, AI tool):
- [scopes-audit/audit-leads.md](scopes-audit/audit-leads.md): leads, orgs, prospects, imports, dashboard, enrich, internal (43 + 12 handlers)
- [scopes-audit/audit-campaigns.md](scopes-audit/audit-campaigns.md): campaigns, campaign-leads, drafts, reply-drafts, unibox, webhook (66 handlers)
- [scopes-audit/audit-settings-ai.md](scopes-audit/audit-settings-ai.md): settings, keys, me, assistant, model-lab (57 handlers) + 21 Kuber AI tools
- [scopes-audit/audit-ui.md](scopes-audit/audit-ui.md): 10 pages, 7 nav items, 16 settings tabs, ~55 role checks, 7 "assign to" pickers

## 1. Facts the audit found (differences from the brief)

- 136 route files (not 135).
- Live DB: Dev company has **2** super admins (Rudraksh, Lakshit). **Decided 16 Nov:** Lakshit = Dev owner, Rudraksh = member with the Manager template. Client company has 1 super admin (kuber@admin.com) → owner. Ruby Singh (manager) → Manager template. 4 client employees + 2 Dev employees → Employee template.
- `role = 'employee'` is also used in 2 DB functions (`team_oversight_counts`, `employee_campaign_stats`) and in the auto-assign pools (`lib/services/assignment.ts`, `lib/services/handover.ts`). Those decide **who receives leads**, not permissions. See §4.
- `requireManagerSession` is never used. Model Lab / Credits / Team are hidden only in the browser today.
- The client signs out anyone whose JWT lacks `app_metadata.role` (`isAppUser`). That gate moves to the profile row (server layout + `/me/access`), never the JWT.
- No local Postgres. The throwaway-cluster test is replaced by HTTP + Playwright tests on the Dev company (decided 16 Nov).

## 2. Final scope list (36, in `SCOPES` order)

| Area | Scope | Box label | What it allows |
|---|---|---|---|
| Dashboard | `dashboard:read` | See | Dashboard with their own numbers |
| | `dashboard:all` | See all | Company-wide numbers, team oversight, imports card, AI "team workload" |
| Leads | `leads:read` | See | Leads page, their own assigned leads |
| | `leads:all` | See all | Every lead in the company (reach) |
| | `leads:write` | Edit | Edit lead fields, status, comments, reactions |
| | `leads:assign` | Assign | Assign / reassign leads |
| | `leads:delete` | Delete | Delete leads |
| | `leads:import` | Import | Apollo search, company search, Excel, manual add, add from inbox, email reveal, retry enrich (spends Apollo / Firecrawl) |
| Organizations | `organizations:read` | See all | Organizations list and any org. Without it a member sees an org only through their own leads |
| | `organizations:write` | Edit | Edit org, rescrape / retry (spends Firecrawl) |
| Prospects | `prospects:read` | See | Scored companies, estimates |
| | `prospects:run` | Run | Search, run, approve / decline (spends Apollo / Firecrawl / LLM) |
| Campaigns | `campaigns:read` | See | Campaigns that hold their leads (only their leads inside) |
| | `campaigns:all` | See all | Every campaign and every lead in it (reach); edit shared campaigns |
| | `campaigns:write` | Edit | Create, options, sequences, drafts, add/remove leads, comments, attachments |
| | `campaigns:generate` | AI drafts | Generate / regenerate AI drafts and follow-ups (spends LLM) |
| | `campaigns:assign` | Assign | Assign a campaign to a member |
| | `campaigns:send` | Send | Approve drafts, send, pause, resume, hold (sends email) |
| | `campaigns:delete` | Delete | Delete a campaign |
| Unibox | `unibox:read` | See | Inbox threads on their own leads, mark read / unread |
| | `unibox:all` | See all | Every thread in the company (reach) |
| | `unibox:reply` | Reply | Send replies, AI reply drafts (sends email, spends LLM) |
| | `unibox:write` | Edit | Interest status |
| Model Lab | `model_lab:read` | See | Model Lab page and results |
| | `model_lab:write` | Run | Run models, vote, save prompt sets (spends LLM) |
| Credits | `credits:read` | See | Credits page, campaign credit / AI cost tabs, AI cost per answer |
| Kuber AI | `assistant:use` | Use | Chat with Kuber AI (tools cut to their other scopes) |
| | `assistant:actions` | Actions | Confirm Kuber AI actions (also needs the action's own scope) |
| | `assistant:admin` | Admin | AI model picks, AI spend per person |
| Company settings | `settings:write` | Edit | Company AI templates, default/follow-up drafts, reply AI, footer, company details, logo, assignment strategy |
| Knowledge | `knowledge:write` | Edit | Product offerings, industry segments |
| API keys | `keys:read` | See | Keys list, provider usage pages |
| | `keys:write` | Edit | Add / edit / delete / check / reorder keys, model + tier, Apollo allowance |
| | `sending_accounts:write` | Sending | Pick the company default sender mailbox |
| Team | `team:read` | See | Team list |
| | `team:write` | Manage | Add members, edit, password reset, deactivate, scopes (see §3) |

**Open to every active member, no scope** (allow-listed in the wiring test, each with a reason):
`me/*`, `settings/signature`, own assistant threads, `GET /settings` (prompt fallback), `settings/logo` GET, `settings/prompt-meta`, `apollo-credits` (sidebar pill, shown to all today), `service-health` (banner).
**Public:** `health`, `meta/locations`, `campaigns/generate-emails` (410), `POST /drafts` (410).
**Secret-only (outside scopes):** `app/api/internal/*`, `enrich/scrape-orgs|generate-drafts|regenerate-drafts`, `webhooks/instantly`, GET `unibox/sync`, the INTERNAL_SECRET branch of routes that also take a user.

## 3. Rules

- **Owner**: one per company (`profiles.is_owner`, unique index). Holds every scope whatever is stored. Nobody can edit their scopes, deactivate them or change their role. Set only by migration / DB (no transfer UI: YAGNI).
- **Member**: exactly the ticked scopes, unknown values ignored, stored in `SCOPES` order. **Deactivated = no scopes.**
- **Service-role bearer** = owner with every scope, `companyId: null` (unchanged behaviour).
- **Write never implies read and read never implies write.** A write handler is never guarded by a `:read` scope.
- **Reach**: `leads:all`, `campaigns:all`, `unibox:all`, `dashboard:all`, `organizations:read`. Without it a member gets today's employee row rule.
- **Shared-campaign rule** (today's `assertCampaignSettingsAccess`): campaign-wide changes on a campaign that holds another lead-owner's leads need `campaigns:all`. "Lead owner" = §4 (members who see all leads are not counted, as managers were not).
- **No escalation** (`canGrant`, applies to create and edit):
  1. Owner may do anything to any non-owner member.
  2. A non-owner needs `team:write`.
  3. Nobody edits the owner. Nobody changes their own scopes or deactivates themselves.
  4. A non-owner may only edit members who **do not hold `team:write`** and **hold no scope the editor lacks** (today: managers edit employees only, never peer managers; a password reset is an account takeover — security review 16 Nov).
  7. A handover on deactivate that gives work to people needs `leads:assign` (and `campaigns:assign` if they hold campaigns); releasing to the pool needs only `team:write`.
  5. A non-owner may only **add or remove** scopes they hold: `(old △ new) ⊆ granter's scopes` (so they can't strip a peer's scope they can't grant either).
  6. Only the owner may grant `team:write` (today only the super admin creates managers).
- **Refusals**: 403 `You need the <scope> permission for this. Ask the owner to add it.` / `Only the owner can do this.`
- **Owner-only list** (pinned in the wiring test): **empty**. Everything above is expressed with scopes + `canGrant`.
- Scope changes reach the API within 30 s (existing per-instance profile cache).

## 4. Who receives leads (not a permission)

Auto-assign pools, handover targets, "assign to" pickers, territory, availability, workload columns, and the two DB functions use `role = 'employee'`.
**Decided:** "lead owner" = non-owner member whose stored scopes have `leads:read` and **not** `leads:all`. Like the old role it ignores `is_active`; pickers and pools add `is_active` exactly where they did before. Same people as today (employees), no new column. The migration rewrites `team_oversight_counts` and `employee_campaign_stats` to that rule. (Question 4 below.)

## 5. Templates (exact parity with today)

| Template | Scopes |
|---|---|
| **Manager** | every scope **except** `sending_accounts:write` (super admin only today) |
| **Employee** | `dashboard:read`, `leads:read`, `leads:write`, `campaigns:read`, `campaigns:write`, `campaigns:generate`, `campaigns:send`, `campaigns:delete`, `unibox:read`, `unibox:reply`, `unibox:write`, `assistant:use`, `assistant:actions`, `knowledge:write` |
| Owner | not a template: `is_owner` holds all |

Why the Employee set has `campaigns:send` / `campaigns:delete` / `campaigns:generate`: employees can send, pause, delete and run AI drafts on their own campaigns today. The shared-campaign rule (if you agree, Q5) stops them doing it on campaigns that hold a teammate's leads.

## 6. Parity check (who could do it before → template that holds the scope)

Encoded as a test (`lib/auth/scopes-parity.test.mts`): one row per audit row, `{ what, oldAccess: 'any' | 'manager' | 'super', scope }`. Assert: Manager template holds `scope` ⇔ oldAccess ∈ {any, manager}; Employee template holds `scope` ⇔ oldAccess = any.
Rows where parity is **deliberately broken** (only if you agree, Q5) are listed in the test with the reason.

Summary by area (full rows in the audit files):

| Area | Employee today | Manager today | Super admin only |
|---|---|---|---|
| Dashboard | own numbers | company + oversight | – |
| Leads | see/edit own, comment | + all, assign, delete, import, reveal, retry-all | – |
| Organizations | org detail via own leads | list, edit, rescrape | – |
| Prospects | – | all | – |
| Campaigns | create, edit, AI drafts, approve, send, pause/resume/hold, delete (own access) | + all, assign | – |
| Unibox | own threads, reply, status, read | + all, add lead | – |
| Model Lab / Credits / Keys | – | all | default sender mailbox, exact credit number |
| Settings | knowledge (products, segments), own profile | company settings | – |
| Team | – | edit employees | create managers, change roles, edit managers |
| Kuber AI | chat + actions within own data | + assign / reveal / team / spend tools, model picks | – |

## 7. Odd rows (today's behaviour that looks wrong): Q5

| # | Finding | Proposal |
|---|---|---|
| A | An employee with one lead in a shared campaign can **delete, pause, resume, PATCH, generate drafts for, use default drafts for, sync, cancel regeneration on** the whole campaign (only Options/Sequences use the shared rule) | Apply the shared-campaign rule to all campaign-wide actions. Hold stays open to anyone with `campaigns:send` (emergency brake) |
| B | Missing lead-owner checks / leaks: bulk-approve certifies teammates' drafts; follow-up regenerate/save, kanban status, per-lead attachment act on teammates' leads; `/campaigns/[id]/replies` and `GET /drafts` show teammates' data; `GET /organizations/[id]` returns co-workers' leads; `enrich/retry` and `enrich/status` have no ownership check; `followup-step-regenerate` has no campaign check; thread `?hydrate=1` runs before the access check; thread status takes `lead_email` from the body (can hit another company's lead in the shared Instantly); `unibox/reply` trusts `reply_draft_id`; `POST unibox/sync` runs a cross-company sync for any user | Fix all of them in this work (each one is a tightening, never a loosening) |
| C | The super-admin-only "exact credits left" number already leaks to every manager (`message` text, `keys/usage/*`, AI tool). Also the campaign Credits / AI cost APIs (`campaigns/[id]/credits`, `llm-cost`) answer employees although the UI hides those tabs from them | Drop the trim: `credits:read` shows exact numbers. The two campaign cost APIs need `credits:read` (no visible change: employees never had the tab) |
| D | `PATCH keys/usage/apollo` changes the Apollo allowance in a table **all companies share** | Owner-only (would be the one entry in the owner-only list) |
| E | Dead code: `/user-signature` (unused, blanks fields), `import-excel` storage modes (cross-company read, nothing uploads there) | Delete |
| F | Employees can rewrite a lead's email; the company-wide duplicate check reveals a co-worker holds that email | Leave as is (low risk) |

## 8. Phases (one commit each on `feat/scopes`)

0. **Audit + plan** (this file). Questions → wait.
1. **Pure core**: `lib/auth/scopes.ts`, `constants/scopeAreas.ts`, `lib/auth/scopes.test.mts`.
2. **Migration** `supabase/migrations/2026_11_16_member_scopes.sql`: `scopes text[]`, `is_owner`, one-owner index, `kuber_scopes_valid`, check constraint, backfill (Lakshit owner on Dev, Rudraksh Manager template), rewrite the 2 DB functions to the lead-owner rule. Re-runnable, drops nothing. **You run it** before the code deploys. Drift test `lib/auth/scopes-sql.test.mts`.
3. **Server guards**: `requireScope`, `requirePageScope`; every route moved; `settings/users` takes `scopes` with `parseScopes` + `canGrant`; old guards deleted.
4. **Row visibility**: `lib/auth/scope.ts` on `canSeeAll`; shared-campaign rule; odd rows A/B if agreed.
5. **UI**: `AccessProvider` / `useAccess` fed from the `(app)` layout (profile row, not JWT); nav + settings `scope`; `PageAccessGate`; every `role ===` → `can(...)`; Settings → Team scope picker with template buttons, chips, disabled boxes with a tooltip.
6. **Kuber AI**: tool list filtered by scope in `buildAssistantTools` (+ `/assistant/overview`); `can()` re-check; `canSeeAll` filters; prompt describes scopes; eval cases updated.
7. **Tests** (by a **separate test agent** that gets this plan, not the implementation notes): wiring scan, drift, parity, then HTTP tests on the Dev company (throwaway members created/deleted in the test), then Playwright on the Dev company. `tsc` + `npm run build`. A fresh review agent reads the diff for security holes.
8. **CLAUDE.md** files + one short doc for the team (`docs/scopes.md`).
9. **Deploy** (after your go): you run the migration → dev → Deployed/Kuber_fork → NeuriqAI fork, `npm run build` each step. Then a smoke test on prod as the Dev owner.
