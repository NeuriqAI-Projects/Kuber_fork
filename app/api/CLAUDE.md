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
- Long jobs: `export const maxDuration = 60;` and stop work by ~35 s (Vercel kills at 60 s).
- Business logic goes in `lib/services/`, not in the route file.
