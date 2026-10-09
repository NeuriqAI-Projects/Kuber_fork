# lib/supabase/ — clients

| File | Use |
|---|---|
| `scoped.ts` | `createScopedClient(companyId)` — **default for all server code.** Auto-filters reads and stamps writes with `company_id`. |
| `admin.ts` | `createAdminClient()` — service role, no RLS, no tenant filter. Only for cron / cross-company jobs; carry `company_id` from the row. |
| `server.ts` | Server Components (cookies, read-only) |
| `client.ts` | Browser client (also `lib/supabase.ts`) |
| `middleware.ts` | session refresh in Next middleware |

Tables without `company_id` are listed in `scoped.ts`; add new ones there.
