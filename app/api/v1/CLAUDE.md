# app/api/v1/ — browser API

One folder per resource; `route.ts` exports GET/POST/PATCH/DELETE.

- `leads/` — list, count, bulk-assign/delete, Apollo search (`apollo-search`, `company-search`, `company-people`, `company-import`), `import-excel`, `enrich` (email reveal).
- `organizations/` — companies, `[id]/rescrape`.
- `prospects/` — company-first fit scoring: `search` (Apollo org search, costs credits), `run` (process now), `decide` (bulk approve/decline/retry), `[id]`. Logic in `lib/services/prospects/`.
- `campaigns/` — CRUD, steps, drafts generation (`generate-drafts`, `regeneration-job`), `send`, `pause`/`resume`/`hold`, replies, report, comments.
- `drafts/`, `reply-drafts/` — email drafts and reply drafts.
- `unibox/` — threads, reply, sync, read/unread.
- `settings/` — company settings, `keys/` (provider keys + usage), users, assignment, signature, logo.
- `me/` — current user, availability, personal settings.
- `webhooks/instantly` — Instantly events (absolute ngrok/Vercel URL).
- `dashboard/`, `service-health`, `apollo-credits`, `ai-readiness`, `health`, `meta`, `model-lab`.

Every handler: auth → scoped client → zod validate → service call → `ok()`/`fail()`.
