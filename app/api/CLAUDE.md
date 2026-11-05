# app/api/ — HTTP routes

| Folder | Who calls it | Auth |
|---|---|---|
| `v1/` | the browser (via `lib/api-client.ts`) | user JWT: `requireAuth` / `requireManager` / `requireSuperAdmin` (`lib/auth/api-auth.ts`) |
| `internal/` | pg_cron pump, Vercel cron, other routes | `INTERNAL_SECRET` (or `CRON_SECRET`) checked with `safeSecretEqual` |
| `enrich/` | self-chaining enrichment workers | `INTERNAL_SECRET` |

Route pattern:
```ts
let user; try { user = await requireManager(req); } catch (r) { return r as Response; }
const db = createScopedClient(user.companyId);   // never the raw admin client
return ok(data);  // or fail(status, "CODE", "message")  — lib/api-response.ts
```
- Validate bodies with zod schemas from `lib/validators/`.
- **Every route sets `export const maxDuration`** (route segment export, not vercel.json; 2 exceptions below). Default
  `60` (Vercel Fluid would otherwise allow 300 s, so a hung call bills 5 min). Long jobs stop work by ~35-50 s.
  Longer on purpose: 300 = `enrich/scrape-orgs`, `leads/enrich`, `leads/apollo-search`,
  `leads/import-excel` (big Apollo/Firecrawl/LLM batches), `assistant/chat`, `model-lab/generate`
  (long LLM calls); 120 = `campaigns/[id]/send`, `campaigns/[id]/config` (many Instantly calls),
  `leads/bulk-delete`, `internal/reconcile-counters`. No value yet (300 s default, check run times
  first): `campaigns/[id]/sync-replies` (Instantly + DB calls per reply) and `drafts/bulk-approve`
  (up to 200 drafts, one at a time).
- Instantly calls time out (30 s, bulk 90 s) in `lib/services/instantly.ts`. Credit-spending routes
  write one `ROUTE_TIMING` row to `enrichment_logs` per run (`lib/services/route-timing.ts`).
- Business logic goes in `lib/services/`, not in the route file.
