# app/api/enrich/ — enrichment workers (self-chaining)

- `scrape-orgs` — Firecrawl company pages, then calls itself again until the queue is empty.
- `generate-drafts`, `regenerate-drafts` — LLM email drafts in parallel batches.
- `retry`, `retry-all` — re-queue failed items. `status` — progress for the UI.

Each call does a time-boxed slice (`lib/services/batch-budget.ts`) then re-invokes itself
via `lib/internal-url.ts`. If a chain dies, the watchdog in `app/api/internal/` restarts it.
Logic: `lib/services/enrich-leads.ts`, `firecrawl.ts`, `generate-drafts.ts`.
