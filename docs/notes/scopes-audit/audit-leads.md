# Permission audit: leads / organizations / prospects / imports / dashboard / misc / enrich

Repo: `C:\Users\rudra\Desktop\Kuber-Polyplast\Kuber` (read-only). 43 user-facing handlers + 12 internal handlers.

Legend:
- `requireAuth` = any active member. **Note:** it also accepts the `SUPABASE_SERVICE_ROLE_KEY` as a bearer and returns `{role:"manager", isSuperAdmin:true, companyId:null}`, so `dbForUser` gives an **unscoped** (cross-company) client. Every `requireManager` route below therefore also works for the service-role bearer.
- "emp" = employee branch, "mgr" = manager branch.
- Reach (`X:all`) replaces `role === "employee"` checks; without it the member gets today's employee rule.

## Table

| Handler | Today's guard + role branches | Does | Proposed scope | Odd? |
|---|---|---|---|---|
| GET /api/v1/leads | requireAuth. Inline `role==="employee"`: emp → `assigned_to = self` (the `assigned_to` filter param is ignored); mgr → all, honours `?assigned_to=a,b,unassigned`. `?stamp=1` same split (emp: newest of own rows). `onlyRevealedLeads` for both. | read | leads:read + reach leads:all | - |
| POST /api/v1/leads | requireManager. No role branch. Optional `assigned_to` (checked active only). | write (insert lead, upsert org, insert import) + **spends Firecrawl/LLM** (fires `/api/enrich/scrape-orgs` via after()) | leads:import (+ leads:assign when `assigned_to` set) | Manual single-lead add spends Firecrawl, so it is not a plain write. Assignee is not checked to be an employee (a manager id passes). |
| GET /api/v1/leads/count | requireAuth. Inline: emp → `getLeadStatusCounts(assignedTo=self)` and `?orgs=1` counts orgs with `leads.assigned_to=self`; mgr → whole company. | read | leads:read + reach leads:all | - |
| GET /api/v1/leads/hot-count | requireAuth. Inline: emp → hot campaign_leads joined to `leads.assigned_to=self`; mgr → all hot campaign_leads. | read | leads:read + reach leads:all (or unibox:read/unibox:all, it counts reply temperature) | Hot-count is a reply/unibox number living under leads; decide which area owns it. |
| GET /api/v1/leads/[id] | requireAuth. Inline: emp → 404 unless `lead.assigned_to===self`; mgr → any. Returns `org_shared` counts (other leads/owners under org) to both. | read | leads:read + reach leads:all | - |
| PATCH /api/v1/leads/[id] | requireAuth. Inline: emp → 404 unless own lead; may edit name/email/phone/title/status etc. Changing `assigned_to` → `role!=="manager"` → 403. | write (lead fields, status, assignment) + lead_events | leads:write + reach leads:all; `assigned_to` part needs leads:assign | Employee can change a revealed lead's `email` and `status`. Email dedup check is company-wide, so the 409 tells an employee that some co-worker's lead has that email. |
| DELETE /api/v1/leads/[id] | requireManager. | delete (soft) + removes lead from Instantly campaigns (stops sending) | leads:delete | - |
| POST /api/v1/leads/bulk-assign | requireManager. Strategies manual / round_robin / territory, ≤1000 ids. | write (assignment) | leads:assign | Manual target only checked `is_active`, not that it is an employee. |
| POST /api/v1/leads/bulk-delete | requireManager. ≤500 ids. | delete (soft) + Instantly removal | leads:delete | - |
| POST /api/v1/leads/apollo-search | requireManager. Inline `companyId===DEV_COMPANY_ID` → 403 (dev blocked). | **spends Apollo** (people search free, then chains `/leads/enrich` reveal = credits); writes leads/orgs/imports | leads:import (+ leads:assign when `assigned_to`/`assignment_strategy` set) | Enrich chain is called with the caller's own JWT (see Odd #6). |
| POST /api/v1/leads/company-search | requireManager. Dev company → mock fixtures (no spend). | **spends Apollo** (1 credit per non-empty org search page); writes enrichment_logs + apollo raw records | leads:import | A "search" that costs a credit; must not sit under a :read scope. |
| POST /api/v1/leads/company-people | requireManager. Dev → mock. | Apollo people search (0 credits) + writes apollo raw records | leads:import (free, but only reachable from the import flow) | Free call, but writes raw rows; fine under leads:import. |
| POST /api/v1/leads/company-import | requireManager. Dev → mock (no reveal chain). | write (org, import, leads) + **spends Apollo** (chains `/leads/enrich` reveal) | leads:import (+ leads:assign when assigned) | - |
| POST /api/v1/leads/enrich | requireManager (so also service-role bearer). No role branch. Accepts `campaign_id` / `import_id` / `lead_ids`; no campaign/lead access check (mgr only today). | **spends Apollo** reveal credits; self-chains; kicks scrape-orgs (**Firecrawl/LLM**) | leads:import | Called by the cron watchdog with the **service-role key as bearer** → unscoped DB, cross-company. Self-chain forwards the user's JWT. Raw-body `chained:true` (any manager can send it) skips the fresh Apollo balance read. |
| POST /api/v1/leads/import-excel | requireManager. Modes `direct` / `headers` / `import`. | write (imports, orgs, leads) + **spends Firecrawl/LLM** (fires scrape-orgs) | leads:import (+ leads:assign when assigned) | `headers`/`import` modes download `storage_path` from bucket `excel-imports` via the service-role storage client, **not company-scoped and not path-checked**: a manager could read another tenant's file by path. No code in app/lib/components uploads to that bucket, so those two modes look dead. |
| GET /api/v1/leads/[id]/activity | requireAuth + `assertLeadAccess` (emp: own lead only, else 404; mgr: any). | read | leads:read + reach leads:all | - |
| GET /api/v1/leads/[id]/comments | requireAuth + `assertLeadAccess` (run in parallel with the read; result only returned after the check). | read | leads:read + reach leads:all | - |
| POST /api/v1/leads/[id]/comments | requireAuth + `assertLeadAccess`. | write (comment) | leads:write + reach leads:all (or a new leads:comment) | Read-only members cannot comment unless they get leads:write. See gaps. |
| POST /api/v1/leads/[id]/comments/[commentId]/reactions | requireAuth + `assertLeadAccess`. Toggles caller's own reaction. | write | same as comments POST | - |
| GET /api/v1/organizations | requireManager. | read (all orgs) | organizations:read | Org list is manager-only today; there is no "own orgs" view for employees. With scopes, organizations:read with no reach rule = whole company list. |
| POST /api/v1/organizations | requireManager. | write (insert org, no scrape kick) | organizations:write | - |
| GET /api/v1/organizations/[id] | requireAuth. Inline: emp → 404 unless they own ≥1 non-deleted lead under the org; mgr → any. `scored` block only when `role==="manager"`. | read | organizations:read + reach (leads:all or a new organizations:all); `scored` part → prospects:read | **Leak:** after the ownership check, an employee gets `leads` = **every** lead under the org (names, emails, titles), including co-workers' leads. Contradicts spec §5 and leads/[id]'s deliberate counts-only `org_shared`. |
| PATCH /api/v1/organizations/[id] | requireManager. | write | organizations:write | - |
| POST /api/v1/organizations/[id]/rescrape | requireManager. | write (requeue, resets attempts to 0) + **spends Firecrawl/LLM** | organizations:write | - |
| GET /api/v1/prospects | requireManager. | read | prospects:read | - |
| POST /api/v1/prospects/search | requireManager. Needs companyId. | **spends Apollo** (1 credit/page) + queues scoring (Firecrawl/LLM) and auto-reveals | prospects:run | - |
| POST /api/v1/prospects/estimate | requireManager. | read-only POST: Apollo People Search scan (0 credits, many calls) + live credit balance checks | prospects:read (free) or prospects:run | POST that does not write; it does burn Apollo rate-limit quota (up to many pages). |
| POST /api/v1/prospects/run | requireManager. Uses **admin (unscoped) client** with `user.companyId`. | **spends** Apollo reveal + Firecrawl + LLM scoring (worker pass) | prospects:run | Unscoped client relies on the worker filtering by companyId. |
| POST /api/v1/prospects/decide | requireManager. Bulk approve/reject/retry/undo. | write; approve = 1 Apollo reveal credit, retry = 1 Firecrawl credit (spent later by worker) | prospects:run | Decision spends credits → not prospects:read. |
| POST /api/v1/prospects/[id] | requireManager. Single decision. | same as decide | prospects:run | - |
| GET /api/v1/imports | requireAuth. Inline: emp → `getImports(assignedTo=self)` (only batches holding their leads); mgr → all batches + real lead counts via RPC. | read | leads:read + reach leads:all | - |
| GET /api/v1/dashboard/analytics | requireAuth. Inline `role==="manager"` → `getDashboardAnalytics` (company); else → `getEmployeeDashboard(self)`. | read | dashboard:read + reach dashboard:team | Employee dashboard's campaign list uses `created_by/assigned_to = self` only (lib/server/dashboard.ts:143), **not** `employeeCampaignIds`, though scope.ts says every employee campaign surface must use it. Note the branch tests `=== "manager"` while most routes test `=== "employee"`. |
| GET /api/v1/dashboard/oversight | requireManager. | read (all campaigns + **all profiles incl. role, is_super_admin, territory, availability**) + per-employee counts | dashboard:team (and arguably team:read) | Exposes profile admin fields; if dashboard:team is given to a team lead they also see is_super_admin flags. |
| GET /api/v1/apollo-credits | requireAuth. No branch. | read (saved balance; calls Apollo once only if nothing ever saved) | credits:read | Employees see the shared Apollo balance today. |
| POST /api/v1/ai-readiness | requireAuth. No branch. | **spends LLM** (one ~30-token real call per press) | campaigns:write (it runs at campaign create) | Any employee can trigger a paid LLM call; POST that is really a check. |
| GET /api/v1/service-health | requireAuth. No branch. | read (enrichment_logs last 6h, company-scoped) + Instantly account list (shared workspace, cached 5 min) | none (banner for all) or credits:read | Employees see provider/mailbox failure banners; fine as a banner, but it is a call to Instantly on a cold instance. |
| GET /api/v1/meta/locations | **no auth at all**. | read (static constants) | none | Fine (static), just the only v1 route without requireAuth here. |
| GET /api/v1/health | **no auth** (public liveness). Uses admin client. | read: DB ping + which provider keys exist | none | Public route returns raw DB error text on failure and which of apollo/firecrawl/openrouter/openai/service-role/jwt-secret are configured. |
| POST /api/enrich/retry | **requireAuth only**. No role branch, **no lead/org ownership check**. Refuses at 3 attempts. | write (requeue org) + **spends Firecrawl/LLM** (kicks scrape-orgs) | organizations:write (+ reach) | **Any employee can requeue any org in the company** and spend Firecrawl/LLM credits, while the near-identical `/organizations/[id]/rescrape` is manager-only. |
| POST /api/enrich/retry-all | requireManager. | write (requeue all eligible failed orgs) + **spends Firecrawl/LLM** (~1 credit/org) | organizations:write | - |
| GET /api/enrich/status | **requireAuth only**, no ownership check. | read (org enrichment stage, description, sells_to, last_error) | organizations:read + reach | Employee can read any org's enrichment summary by id, unlike GET /organizations/[id] which checks ownership. |
| POST /api/enrich/scrape-orgs | INTERNAL_SECRET only (`safeSecretEqual`). | **spends Firecrawl + LLM**, writes orgs, auto-assigns leads | none (secret) | Every user path above that "kicks" a scrape just fires this with the secret, so the credit spend is not attributed to a user. |
| POST /api/enrich/generate-drafts | INTERNAL_SECRET only. Optional `company_id` (pump all stalled campaigns if no campaign_id). | **spends LLM**, writes drafts | none (secret) | Without `campaign_id` and `company_id` it pumps every company. |
| POST /api/enrich/regenerate-drafts | INTERNAL_SECRET only. | **spends LLM**, writes drafts | none (secret) | - |

## app/api/internal/* (secret-only, one line each)

- `auto-retry-failed-orgs` — POST: INTERNAL_SECRET; GET: CRON_SECRET bearer or INTERNAL_SECRET. Requeues failed orgs (spends Firecrawl).
- `check-sequence-drift` — POST: INTERNAL_SECRET (optional company_id); GET: CRON_SECRET or INTERNAL_SECRET. Read/report.
- `enrichment-watchdog` — POST: INTERNAL_SECRET; GET: CRON_SECRET or INTERNAL_SECRET. Kicks enrichment.
- `reconcile-counters` — POST: INTERNAL_SECRET; GET: CRON_SECRET or INTERNAL_SECRET. Writes counters.
- `resume-apollo-reveal` — POST: INTERNAL_SECRET; GET: CRON_SECRET or INTERNAL_SECRET. Calls `/api/v1/leads/enrich` with the **service-role key as bearer** (spends Apollo).
- `score-prospects` — POST only: INTERNAL_SECRET. Spends Firecrawl/LLM.
- `write-followups` — POST only: INTERNAL_SECRET; `guardUnscoped(company_id)` refuses a missing company_id (the `pump` mode fills it from the first due campaign). Spends LLM.

No internal route accepts a user JWT.

## Odd findings

1. **`POST /api/enrich/retry` is open to every member** (requireAuth, no ownership check) and spends Firecrawl + LLM on any org in the company. Its twin `/organizations/[id]/rescrape` is manager-only.
2. **`GET /api/v1/organizations/[id]` leaks co-workers' leads to employees**: the ownership check gates the org, but the returned `leads` list is every lead under it (name, email, title).
3. **`GET /api/enrich/status` has no ownership check** — employee reads any org's enrichment summary, inconsistent with #2's gate.
4. **`POST /api/v1/ai-readiness`** lets any member trigger a paid LLM call (tiny, but it is a spend with no role gate).
5. **Service-role bearer = super-admin manager with unscoped DB.** `requireAuth` accepts `SUPABASE_SERVICE_ROLE_KEY`; the reveal watchdog uses it to call `/api/v1/leads/enrich`. Any requireManager route accepts it. The new scope check must give this identity all scopes (or, better, move the watchdog to INTERNAL_SECRET).
6. **`/api/v1/leads/enrich` self-chains with the caller's own JWT** (also apollo-search → enrich). If the user's scope/role is removed or the token expires mid-import, the chain 403s/401s and the reveal stops until the watchdog picks it up. Raw-body `chained:true` from any manager skips the fresh Apollo balance read.
7. **`import-excel` storage modes**: `storage_path` is downloaded with the service-role storage client, not company-scoped or path-checked (cross-tenant read if a path is known). No code uploads to `excel-imports`, so these modes look dead.
8. **Credit spend hidden behind "add/search"**: manual `POST /leads` and `import-excel` fire scrape-orgs (Firecrawl), `company-search` costs 1 Apollo credit, prospect `decide`/`[id]` approve costs a reveal credit. None of these may map to a :read scope.
9. **Employee dashboard uses a narrower campaign rule** (`created_by/assigned_to` only) than `employeeCampaignIds` (which also includes campaigns holding their leads).
10. **`dashboard/oversight` returns every profile's `is_super_admin`, role, territory** — fine for managers today, but leaks admin flags if `dashboard:team` is handed to a non-admin.
11. **Assignee checks only test `is_active`** (bulk-assign manual, POST /leads, imports): a manager id can be set as a lead owner.
12. **PATCH /leads/[id]**: employee can rewrite their lead's email/status; the company-wide email-dedup 409 reveals that a co-worker holds that email.
13. `GET /api/v1/health` is public and returns raw DB error text + which provider keys/secrets are configured; `meta/locations` is unauthenticated (static, harmless).

## Scope list gaps

- **Add `organizations:all`** (or state that org reach follows `leads:all`). Today emp sees an org only if they own a lead under it (organizations/[id], and should be the same in enrich/status and enrich/retry); mgr sees all + the org list. Without a reach scope, `organizations:read` is ambiguous between "my orgs" and "all orgs".
- **Rename `dashboard:team` → `dashboard:all`** to match the `X:all` reach convention (it is exactly the mgr/emp branch of dashboard/analytics). If oversight (per-employee table with profile flags) should stay separate, keep `dashboard:team` for oversight only and add `dashboard:all` for analytics reach.
- **Add `leads:comment`** (or fold comments+reactions into `leads:read`). Today any member who can see a lead can comment; putting comments under `leads:write` would let commenters also edit email/status.
- **Split `leads:import` if cost control matters**: it covers both free paths (manual add, Excel, company-people) and paid ones (Apollo search/reveal, company-search). A `leads:create` (manual/Excel, spends only Firecrawl) vs `leads:import` (Apollo credits) split matches how the client thinks about cost. Otherwise keep one scope and note it spends.
- **`organizations:write` vs spend**: rescrape/retry/retry-all spend Firecrawl/LLM but PATCH/POST org do not. Consider `organizations:enrich` (spend) separate from `organizations:write` (edit fields), mirroring `prospects:run`.
- **`prospects:read` for estimate**: free but hits Apollo many times; fine under read, or tie it to `prospects:run` since it only feeds a run.
- **hot-count**: decide owner — `unibox:read`/`unibox:all` fits better than leads (it counts reply temperature).
- **`credits:read`** should also cover `apollo-credits` (sidebar) and service-health banner if you want to hide balances from plain members; otherwise mark both "no scope".
- **Service identity**: define how the service-role bearer maps to scopes (all scopes, cross-company) or remove that path in favour of INTERNAL_SECRET.
- **ai-readiness**: map to `campaigns:write` (only used at campaign creation) rather than leaving it scope-free, since it spends.
