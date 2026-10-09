# lib/services/ — business logic + providers

Grouped by job (file prefix tells you where to look):

| Area | Files |
|---|---|
| **Apollo** (people/company search, email reveal) | `apollo.ts`, `apollo-mock.ts` (non-prod + Dev company), `apollo-raw.ts` (saves raw JSON), `enrich-leads.ts` (reveal; 402/422 = out of credits), `keyword-fallback.ts`, `lead-ranking.ts` (one person per company) |
| **Company fit scoring** | `prospects/` (own CLAUDE.md) |
| **Firecrawl** (read websites) | `firecrawl.ts`, `enrichment-status.ts`, `enrichment-watchdog.ts` |
| **LLM** | `llm.ts` (`complete()`, key rotation by tier), `llm-pricing.ts`, `llm-mock.ts` ([TEST] fake AI), `providers/` |
| **Drafts** | `generate-drafts.ts`, `regenerate-draft.ts`, `regeneration-jobs.ts`, `revision-input.ts`, `revision-intent.ts`, `draft-sync.ts`, `batch-budget.ts` |
| **Follow-ups** | `write-followups.ts`, `followup-schedule.ts`, `followup-signals.ts`, `followup-template.ts`, `followup-instruction.ts`, `followup-regenerate.ts`, `fallback-reason.ts` |
| **Instantly** (sending) | `instantly.ts`, `campaign-fanout.ts`, `campaign-lifecycle.ts` (pause = only real stop), `sequence-publish.ts`, `sequence-drift.ts`, `campaign-counters.ts` |
| **Replies / Unibox** | `unibox.ts`, `classify-reply.ts`, `generate-reply.ts`, `reply-mailing-list.ts` |
| **Leads & people** | `assignment.ts` (deferred assignment), `territory-allocator.ts`, `handover.ts`, `lead-events.ts` (activity log), `lead-lookup.ts`, `lead-removal.ts` |
| **Keys & settings** | `provider-keys.ts`, `service-keys.ts` (`getServiceSecret`), `provider-credits.ts`, `provider-errors.ts`, `settings.ts` (company + user layers) |
| **Model Lab** | `model-lab.ts` |

Rules:
- Paid calls (Apollo reveal, org search, Firecrawl): save the result immediately, never pay twice on retry.
- Email structure/tone lives in `settings.system_prompt`, not in code.
- Keys come from the DB first (`getServiceSecret(provider, companyId)`), `.env.local` is fallback.
- Pure logic gets a `*.test.mts` next to it.
