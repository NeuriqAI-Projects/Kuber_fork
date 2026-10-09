# lib/ — non-UI code

| Folder / file | What |
|---|---|
| `auth/` | JWT checks, roles, access scope, rate limits |
| `supabase/` | Supabase clients (scoped / admin / server / browser) |
| `server/` | Data loaders for server components (pages) |
| `services/` | Business logic + provider calls (biggest folder) |
| `validators/` | zod schemas for API bodies |
| `utils/` | domain, email-html, person-name helpers |
| `api-client.ts` | Browser fetch wrappers for every `/api/v1` route |
| `api-response.ts` | `ok()` / `fail()` response helpers |
| `app-context.tsx`, `theme-context.tsx` | React contexts (session, leads cache, theme) |
| `mappers.ts` | DB row → frontend shape + status maps |
| `branding.ts` | colour palettes (the 4-colour light mode) |
| `http.ts` | retry schedule per provider (Apollo: no retries, on purpose) |
| `constants.ts` | service-role synthetic caller id etc. |
| others | small pure helpers: campaign-status, territory, unibox-filters, thread-participants, email-display, reply-* |

Tests sit next to the code as `*.test.ts` / `*.test.mts`; run with `npx tsx --test <file>`.
`leads-store.ts` is deprecated.
