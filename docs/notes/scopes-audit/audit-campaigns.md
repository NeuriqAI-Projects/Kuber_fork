# Permission audit: campaigns / campaign-leads / drafts / reply-drafts / unibox / reply-mailing-list / webhooks

Read-only audit, `Kuber/` dev repo, 16 Nov 2026. **66 exported handlers.**

Short names used below:
- **E** = employee, **M** = manager (super-admin acts as M everywhere here; no route in this slice checks `isSuperAdmin`).
- **CA** = `assertCampaignAccess`. M: campaign exists (it does NOT check `is_deleted`). E: campaign was created by them, is assigned to them, or holds at least one live lead assigned to them. Otherwise 404.
- **CSA** = `assertCampaignSettingsAccess` = CA, plus for E: no other employee owns a lead in the campaign or is its creator or assignee. Otherwise 403.
- **DA / RDA / TA / TAid** = `assertDraftAccess` / `assertReplyDraftAccess` / `assertThreadAccess` / `assertThreadAccessById`. M: always passes. E: the underlying lead must be assigned to them, else 404.
- **"campaign-wide"** = the action reaches every lead in the container, teammates' leads included.
- Every `requireAuth` route also accepts the `SUPABASE_SERVICE_ROLE_KEY` bearer, which becomes M + super-admin with `companyId = null`. `dbForUser` then hands back the **unscoped** admin client, so that caller can act across companies. This applies to all 60 `requireAuth`/`requireManager` handlers below and is not repeated in each row.
- Proposed `X:all` = reach. Without it, the member gets today's E row rule. With it, today's M rule.

## Table

| # | Handler | Today's guard + role branches | Does | Proposed scope | Odd? |
|---|---|---|---|---|---|
| 1 | GET /campaigns | requireAuth. E: `employee_campaign_stats` RPC (fallback: `getAccessibleCampaignIds`), counts recomputed from own leads only, `can_edit_settings` from `campaignsEditableByEmployee`. M: every live campaign, `can_edit_settings=true`. | read | campaigns:read (+campaigns:all for M view) | |
| 2 | POST /campaigns | requireAuth. No role branch. Any E can create. | write (campaign + default steps) | campaigns:write | `signature_user_id` from the body is not validated, so E can name a teammate's signature. |
| 3 | POST /campaigns/attachment | requireAuth. No role branch, no campaign id. | write (signed Storage upload under `uploads/`) | campaigns:write | No campaign link. Any user can mint upload URLs. |
| 4 | POST /campaigns/generate-emails | **none** (no auth at all) | returns 410 | delete route | Dead stub with no auth. Harmless, but should go. |
| 5 | GET /campaigns/[id] | requireAuth + CA. E: memberships filtered to own leads, stats recomputed, `can_edit_settings` computed. M: whole campaign. | read | campaigns:read (+all) | |
| 6 | DELETE /campaigns/[id] | requireAuth + CA. **No role branch.** | **delete**: deletes every Instantly sub-campaign (stops all sending) + soft-delete | campaigns:delete, and campaign-wide so it also needs campaigns:all or the sole-owner rule | **E can delete a shared campaign** and stop teammates' sending. No CSA check. |
| 7 | PATCH /campaigns/[id] | requireAuth + CA. No role branch. Only when status is draft/processing. | write (name, sender_name, daily_limit, window, send_days, tz, human_in_loop, ai_prompt_context) | campaigns:write + sole-owner/all rule (same as #12) | **Gets around CSA**: E edits the same settings `/config` blocks, on any shared campaign still in draft/processing. |
| 8 | POST /campaigns/[id]/assign | **requireManager**. No CA (M only). | write (campaign assignee + history, optional bulk lead reassign + lead_events) | campaigns:assign (+ leads:assign when `reassign_leads=true`) | `reassign_leads` moves leads, so it is a leads:assign action hidden inside campaigns:assign. |
| 9 | GET /campaigns/[id]/comments | requireAuth + CA | read | campaigns:read | |
| 10 | POST /campaigns/[id]/comments | requireAuth + CA | write (comment) | campaigns:write, or a new campaigns:comment | A read-only member could not comment if this goes under :write. See gaps. |
| 11 | POST /campaigns/[id]/comments/[cid]/reactions | requireAuth + CA | write (toggles own reaction) | same as #10 | |
| 12 | PATCH /campaigns/[id]/config | requireAuth + **CSA** (E only when they are the sole employee) | write + **Instantly patch** on every sub-campaign | campaigns:write + (campaigns:all or sole-owner) | |
| 13 | GET /campaigns/[id]/credits | requireAuth + CA. No role branch. | read (Apollo/Firecrawl/Jev/Tavily/AI/Instantly usage) | credits:read + campaigns:read | **E sees campaign-wide spend**, teammates' leads included. Elsewhere E stats are own-only. |
| 14 | GET /campaigns/[id]/draft-progress | requireAuth + CA. No role branch. | read (counts, `canDraftOpenings`) | campaigns:read | Counts are campaign-wide for E (small leak of teammate counts). |
| 15 | POST /campaigns/[id]/followup-regenerate | requireAuth + CA. **No lead-owner check** on `campaign_lead_id`. | **LLM spend** (unless AI is off) + write (rejects the old follow-up, inserts a new one) | campaigns:generate (see LLM decision) | **E can rewrite a teammate's lead's follow-up** in a shared campaign. Should use the lead-owner rule (as `/replace` does). |
| 16 | POST /campaigns/[id]/followup-save | requireAuth + CA. **No lead-owner check.** | write + **approve** + `syncApprovedDraftToInstantly` + may rewrite `campaign_steps` and **patch Instantly sequences on every sub-campaign** | campaigns:write. Approval here is not certification: follow-ups are auto-approved by design. | (a) E can edit or approve a teammate's follow-up. (b) It changes the campaign-wide step template and Instantly sequences **with no CSA**, which gets around the sequences rule. |
| 17 | POST /campaigns/[id]/followup-step-regenerate | requireAuth only. **No CA at all.** | **LLM spend** (template rewrite, nothing saved) | campaigns:generate + CA | Any user can spend LLM against **any campaign id**, even one they cannot see or a made-up one. The id is passed into llm_usage tagging, so another campaign's cost figures get polluted. |
| 18 | POST /campaigns/[id]/generate-drafts/kick | requireAuth + CA. Restarts only a stalled run. The drawer polls it about once a minute. | **LLM spend** (restarts the internal worker via INTERNAL_SECRET) | campaigns:generate | campaign-wide: E's kick drafts teammates' leads too. The UI must stop polling it for members without the scope. |
| 19 | POST /campaigns/[id]/generate-drafts | requireAuth + CA. No role branch. | write (status → processing) + **LLM spend for every lead in the campaign** | campaigns:generate + campaigns:write | **campaign-wide**: E starts drafting (and spending) for teammates' leads. |
| 20 | POST /campaigns/[id]/hold | requireAuth + CA. Deliberately open to anyone with access ("speed matters"). | **Instantly pause** of every sub-campaign + `sending_held_*` stamp | campaigns:send | campaign-wide, and on purpose. Decide whether a hold stays open to anyone with campaigns:read as an emergency brake. Today it does not check write at all. |
| 21 | POST /campaigns/[id]/leads/remove | requireAuth + CA. E: rows whose lead is not theirs are skipped. Unsent rows only. | **delete** (campaign_leads + unsent drafts) | campaigns:write (it removes membership, not the lead), or leads:delete if you treat it as destructive | |
| 22 | GET /campaigns/[id]/leads | requireAuth + CA. E: main rows filtered to `leads.assigned_to = me`. | read | campaigns:read (+all) | In the list view `comment_count` and `pending_reply_count` are campaign-wide for E (counts only). |
| 23 | POST /campaigns/[id]/leads | requireAuth + CA. E: may only add leads assigned to them. | write (campaign_leads + lead_events) | campaigns:write | Adding a lead to a campaign a teammate works makes it multi-employee and silently takes away that teammate's Options/Sequences rights. |
| 24 | PATCH /campaigns/[id]/leads | requireAuth + CA. **No lead-owner check.** | write (crm_status of one campaign_lead, any value including `sent`/`won`) | campaigns:write | **E can move a teammate's lead** on the kanban. The status can be set to `sent`/`approved` by hand, which works as a back-door "certify". |
| 25 | GET /campaigns/[id]/llm-cost | requireAuth + CA. No role branch. | read | credits:read + campaigns:read | E sees campaign-wide AI cost. |
| 26 | POST /campaigns/[id]/pause | requireAuth + CA. No role branch. | **Instantly pause** of every sub-campaign | campaigns:send + (all or sole-owner) | **E pauses teammates' sending.** |
| 27 | POST /campaigns/[id]/regenerate-drafts | requireAuth + CA. Targets come from `resolveRegenerationTargets`, which **skips non-own leads for E** (regeneration-jobs.ts:130). Follow-up steps also need a hold while sending. | **LLM spend** (bulk job) + write; `preview:true` = read only | campaigns:generate (preview: campaigns:read) | Preview runs through POST, so a :read caller needs POST allowed on the preview branch. Split the route or check the scope per branch. |
| 28 | GET /campaigns/[id]/regenerate-drafts | requireAuth + CA. Same E filter in the preview. | read (preview counts) | campaigns:read | |
| 29 | POST /campaigns/[id]/regeneration-job/cancel | requireAuth + CA. No role branch. | write (cancels the job) | campaigns:generate | E can cancel a manager's or teammate's campaign-wide job. |
| 30 | POST /campaigns/[id]/regeneration-job/kick | requireAuth + CA | **LLM spend** (restarts the worker via INTERNAL_SECRET; worker pump picks **any** stale job, not only this campaign's) | campaigns:generate | The kick is not tied to the campaign. CA on campaign A restarts whatever stale job the pump finds (the route's own comment says "any job"). I did not check whether the pump is company-scoped. |
| 31 | GET /campaigns/[id]/regeneration-job | requireAuth + CA | read | campaigns:read | Job totals are campaign-wide for M jobs. |
| 32 | GET /campaigns/[id]/replies | requireAuth + CA. **No role branch.** `getCampaignReplyThreads(db, id)` takes no user scope. | read (reply thread bodies) | campaigns:read + unibox:read (+unibox:all for teammates' threads) | **Leak: E reads teammates' reply threads** in a shared campaign. Breaks the "thread only if the lead is theirs" rule. |
| 33 | GET /campaigns/[id]/report | requireAuth + CA. E: rows filtered to own leads; the campaign-wide floor is skipped. | read | campaigns:read (+all) | |
| 34 | POST /campaigns/[id]/resume | requireAuth + CA. No role branch. | **Instantly activate** of every sub-campaign (restarts sending, and also releases a hold) | campaigns:send + (all or sole-owner) | **E resumes teammates' sending**, including releasing a hold someone else placed. |
| 35 | POST /campaigns/[id]/send | requireAuth + CA. E: `restrictToLeadOwnerId = me`. | **send email** (Instantly fan-out) | campaigns:send | |
| 36 | GET /campaigns/[id]/steps | requireAuth + CA | read | campaigns:read | |
| 37 | PUT /campaigns/[id]/steps | requireAuth + **CSA** | write (steps, followup_instruction, followups_ai_enabled, refresh template follow-ups) + **Instantly publish** | campaigns:write + (all or sole-owner) | `followups_ai_enabled` here is an AI-spend switch that rides on settings access. |
| 38 | POST /campaigns/[id]/sync-replies | requireAuth + CA. No role branch. | Instantly reads + writes (reply_events, unibox_emails, campaign_leads status/temperature, counters) | campaigns:write (data repair) | campaign-wide: E rewrites teammates' rows. No LLM (comment confirms). |
| 39 | POST /campaigns/[id]/use-default-drafts | requireAuth + CA. No role branch. | write (template drafts for **every** pending lead; no LLM) | campaigns:write | campaign-wide: E writes default drafts for teammates' leads. |
| 40 | POST /campaign-leads/[id]/attachment | requireAuth + CA (campaign looked up from the row). **No lead-owner check.** | write (Storage + per-lead attachment) | campaigns:write | **E can set an attachment on a teammate's lead.** |
| 41 | DELETE /campaign-leads/[id]/attachment | requireAuth + CA. **No lead-owner check.** | delete (Storage object + fields) | campaigns:write | Same as #40. Also removes the Storage object before the DB write succeeds. |
| 42 | POST /campaign-leads/[id]/replace | requireAuth + CA + **inline E check** (`assigned_to !== me` → 403). Bounced leads only. | write (**edits the `leads` row**: email/name/title), resets campaign_lead, rejects follow-ups, may kick **LLM draft** | campaigns:write + leads:write (it edits the lead identity) | Kicks generate-drafts (LLM) when the pump does not cover it, so a member without campaigns:generate can still trigger spend. |
| 43 | POST /drafts/bulk-approve | requireAuth. Per draft: **CA on its campaign** (memoised), not DA. | **approve** + Instantly sync + crm_status | campaigns:send | **E can certify teammates' drafts** in a shared campaign. The single-draft route uses DA, the bulk route only CA. |
| 44 | GET /drafts | requireAuth. E: **`campaigns.created_by = me` only** (old rule). With `campaign_id` it returns **all** drafts in that campaign. | read | campaigns:read (+all) | Uses neither `getAccessibleCampaignIds` nor the lead rule: (a) E misses campaigns where they only own leads; (b) E who created a campaign sees teammates' drafts in it. |
| 45 | POST /drafts | **none** (no auth) | returns 410 | delete route | Dead stub with no auth. |
| 46 | GET /drafts/[id]/history | requireAuth + DA | read | campaigns:read | |
| 47 | POST /drafts/[id]/regenerate | requireAuth + DA | **LLM spend** (one draft) + write; checks Instantly not-sent | campaigns:generate | |
| 48 | PATCH /drafts/[id] | requireAuth + DA. One handler, 5 actions. | `approve` = **certify** + Instantly sync; `edit` (follow-up edit also syncs to Instantly); `reject`; `reopen`; `restore` | approve → campaigns:send; edit/reject/reopen/restore → campaigns:write | Needs a per-action check. `restore` of an approved version sets `crm_status='approved'` and repoints `draft_id`, which makes it the live certified draft without the approve gate. `restore` also reads the same id as `draft` (target === draft), so it never really changes version. |
| 49 | GET /drafts/[id]/siblings | requireAuth + DA | read | campaigns:read | |
| 50 | POST /reply-drafts/generate | requireAuth + TA (after loading the newest inbound row by thread_id/campaign_lead_id). | **LLM spend** + write (reply_drafts). Also calls `reset_stuck_reply_drafts` RPC, which has **no company filter**. | unibox:reply (see LLM decision) | The RPC fails stuck drafts in every tenant. Harmless watchdog, but cross-company. |
| 51 | POST /reply-drafts/[id]/regenerate | requireAuth + RDA | **LLM spend** + write | unibox:reply | |
| 52 | GET /reply-drafts/[id] | requireAuth + RDA | read | unibox:read | |
| 53 | PATCH /reply-drafts/[id] | requireAuth + RDA. Actions edit/approve/reject. | write; `approve` is only a status (sending is #54) | edit/reject → unibox:write; approve → unibox:reply | Approve sends nothing, and #54 sends `draft` status too, so approve is cosmetic. |
| 54 | POST /reply-drafts/[id]/send | requireAuth + RDA. Atomic claim. | **send email** (Instantly reply) | unibox:reply | It also sends an unapproved `draft`, so there is no approval gate on replies. |
| 55 | POST /unibox/reply | requireAuth + TA (thread from `getThreadCore`) | **send email** | unibox:reply | `reply_draft_id` from the body is **not checked**: any reply_draft in the company is marked `sent` (`sendThreadReply`), a teammate's included. |
| 56 | POST /unibox/sync | **INTERNAL_SECRET OR requireAuth** (any role) | Instantly read + DB writes, **cross-company** (`createAdminClient`) | unibox:write, or make it secret-only | Accepts the internal secret **and** a user token. Any E triggers a full-workspace sync for **both tenants**. |
| 57 | GET /unibox/sync | CRON_SECRET bearer OR INTERNAL_SECRET | same as #56 | none (machine) | |
| 58 | GET /unibox/threads | requireAuth. E: `getUniboxScope` → `{assigned_to: me}`. M: null (everything). | read | unibox:read (+unibox:all) | |
| 59 | POST /unibox/threads/[tid]/add-lead | **requireManager** + TA (a no-op for M) | write (**creates a lead**, inherits org + assignee) | unibox:write + leads:write (it creates a lead, like POST /leads) | The only unibox mutation that is manager-only. Status, read and unread are open to E. |
| 60 | POST /unibox/threads/[tid]/read | requireAuth + TAid | write (read flag) | unibox:write | Mark read is pure UI state. Consider allowing it under unibox:read, or else a read-only member's unread badge never clears. |
| 61 | GET /unibox/threads/[tid] | requireAuth + TA. **`?hydrate=1` runs `hydrateThreadIfStale` before the access check.** | read; hydrate = Instantly fetch + DB write | unibox:read | **The side effect runs before authorisation**: E can make the server fetch and write any thread in the company by id. |
| 62 | PATCH /unibox/threads/[tid]/status | requireAuth + TAid | write (campaign_lead interest/temperature) + **Instantly `update-interest-status`** + audit_log | unibox:write | **`lead_email` from the body overrides the thread's address** in the Instantly call. Instantly is shared by both tenants, so E can change the interest status of any email in the workspace, even another tenant's lead. |
| 63 | POST /unibox/threads/[tid]/unread | requireAuth + TAid | write (read flag) | unibox:write (see #60) | |
| 64 | GET /unibox/unread-count | requireAuth + `getUniboxScope` | read | unibox:read (+all) | |
| 65 | GET /reply-mailing-list | requireAuth. Always filtered to `user_id = me`. | read (own recent recipients) | unibox:reply (only useful to someone who sends; :read also fine) | |
| 66 | POST /webhooks/instantly | `x-webhook-secret` = INSTANTLY_WEBHOOK_SECRET. Cross-company admin client, then scoped per sub-campaign's company. | write (events, statuses, unibox ingest). No LLM, no send. | none (machine, out of the scope model) | |

## LLM decision: give it its own box, `campaigns:generate`

Put every campaign LLM path behind **`campaigns:generate`**, not campaigns:write: #15, #17, #18, #19, #27 (non-preview), #29, #30, #47.
- It is the only campaign action that costs money without sending anything. The Nov cost review and the no-credit flow show the spend is real and capped.
- The AI key is shared by the whole company. One member's bulk run can push it to "out of credits", which pauses drafting for everyone (`canDraftOpenings`).
- "Can edit and certify, cannot burn credits" is a realistic role (reviewer or junior). The default email (#39) and manual follow-up save (#16) let that person still finish a campaign.
- It costs one checkbox. Presets can bundle it with campaigns:write.

Reply-draft AI (#50, #51) is one human-pressed reply at a time, and only someone who can reply needs it, so it stays under **unibox:reply**. If you would rather have one "spends AI" switch, rename the box to `ai:generate` and apply it to both areas.

## Odd findings

1. **E can delete a shared campaign** (#6): CA only, no delete or settings rule. It removes the campaign from Instantly and stops teammates' sends.
2. **E can pause, resume or hold a shared campaign** (#20, #26, #34): all campaign-wide. Resume also releases a hold someone else placed.
3. **PATCH /campaigns/[id] gets around the sole-employee settings rule** (#7): it edits the same fields as `/config` with CA only, while the campaign is in draft/processing.
4. **followup-save gets around the sequences rule** (#16): it rewrites `campaign_steps` and patches Instantly sequences on every sub-campaign with no CSA. It also does not check that the lead is the caller's.
5. **Missing lead-owner checks inside shared campaigns**, so E can act on a teammate's lead: followup-regenerate (#15), followup-save (#16), PATCH campaign lead status (#24), per-lead attachment POST/DELETE (#40, #41), and **bulk-approve uses CA instead of DA** (#43), so E can certify teammates' drafts.
6. **Campaign-wide AI runs started by E**: generate-drafts (#19), generate-drafts/kick (#18) and use-default-drafts (#39) work on every lead in the campaign, not only E's. Only regenerate-drafts filters to own leads.
7. **followup-step-regenerate has no campaign check at all** (#17): any user can spend LLM, and any campaign id (even a made-up one) is written into llm_usage tagging.
8. **Leak: /campaigns/[id]/replies** (#32) returns every reply thread in the campaign to E, teammates' threads included.
9. **GET /drafts uses the old `created_by` rule** (#44): it misses campaigns E only has leads in, and shows all drafts (teammates' too) in campaigns E created.
10. **Campaign-wide numbers shown to E**: credits (#13), llm-cost (#25), draft-progress (#14), comment/pending-reply counts (#22). Elsewhere E stats are own-only.
11. **/unibox/sync POST accepts INTERNAL_SECRET or any user token** (#56) and runs a cross-company sync, so any E can trigger it for both tenants.
12. **Thread hydrate runs before the access check** (#61).
13. **Thread status takes `lead_email` from the body** (#62). The Instantly interest update can hit any address in the shared workspace, another tenant's lead included.
14. **/unibox/reply trusts `reply_draft_id`** (#55) and marks any company reply draft `sent`.
15. **Reply approval is not a gate** (#53/#54): send accepts `draft` status too.
16. **drafts PATCH `restore`** (#48) can make an approved version live (`crm_status='approved'`) without the approve action. Its target lookup also re-reads the same id, so it is effectively a no-op on versions.
17. **CA ignores `is_deleted`** for M and for an E who is creator or assignee, so send, resume and the rest run on soft-deleted campaigns by id.
18. **regeneration-job/kick is not tied to the campaign** (#30): the worker pump restarts any stale job. I did not check whether that includes other companies.
19. **Two dead POST stubs with no auth** (#4, #45). They return 410 but should be deleted.
20. Every user route also accepts the **service-role key bearer**: M + super-admin with `companyId=null`, and so an **unscoped** DB client.
21. `reset_stuck_reply_drafts` RPC (#50) has no company filter (cross-tenant watchdog, low risk).
22. `/replace` (#42) edits the global `leads` row and can kick LLM drafting, which crosses into leads:write and campaigns:generate.

## Scope list gaps

- **`campaigns:generate`** (new): LLM drafting and regeneration. See the decision above.
- **Container rule for campaign-wide actions**: today only Options/Sequences use "sole employee or manager". Pause, resume, hold, delete, PATCH /[id], generate-drafts, use-default-drafts, sync-replies, regeneration cancel and followup-save's sequence patch all act on teammates' leads. Proposed rule: a campaign-wide mutation needs its action scope **plus** `campaigns:all` or "sole owner of the container". Build it once (generalise `assertCampaignSettingsAccess`), not per route.
- **Lead-scoped actions inside a campaign** should check the lead rule (`ownsCampaignLead`) unless the member has `campaigns:all`: drafts approve (bulk), follow-up rewrite/save, kanban status, per-lead attachment. One helper, e.g. `assertCampaignLeadAccess`.
- **Comments / reactions**: there is no box. Either a `campaigns:comment` box, or allow them under campaigns:read. Otherwise viewers cannot discuss.
- **Read/unread flags**: decide whether they count as unibox:write or are allowed under unibox:read. A read-only inbox user otherwise has a badge that never clears.
- **Hold as an emergency brake**: today it is deliberately open to anyone with access. Keep it under campaigns:send, or give it a separate `campaigns:hold`, or allow it under campaigns:read. Decide explicitly.
- **Spend visibility**: credits (#13) and llm-cost (#25) show money. Make them credits:read, and say whether credits:read without campaigns:all shows the whole campaign or own leads only.
- **Reply approval**: there is no meaningful gate today. If unibox:reply is the only gate, drop the approve action or make send require `approved` for members without a "send unapproved" right.
- **Campaign assignment that also reassigns leads** (#8): require leads:assign too when `reassign_leads=true`.
- **Lead creation from Unibox** (#59) and **bounced-contact correction** (#42) edit or create `leads` rows. Add leads:write next to their unibox/campaign scope.
- **Machine routes** (#57, #66, the INTERNAL_SECRET branch of #56) sit outside the member scope model. The user-token branch of #56 needs a scope or should be removed.
- **Service-role bearer** in `requireAuth` should be mapped to an explicit "system" principal with all scopes, not the old manager role. Otherwise the new scope checks will treat it as a member with no scopes, or with every scope by accident.
