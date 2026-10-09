# lib/auth/

- `api-auth.ts` — `requireAuth` / `requireManager` / `requireSuperAdmin(req)` → `AuthedUser`
  (`id`, `role`, `companyId`). Throw a Response on failure; routes `catch (r) { return r }`.
- `verify-jwt.ts`, `jwks-cache.ts` — verify Supabase tokens locally (no Auth round-trip).
- `roles.ts` — role from `app_metadata`. `scope.ts` — who may see/edit which lead/campaign
  (managers see all; employees their own; campaign is a multi-employee container).
- `secret.ts` — `safeSecretEqual` for INTERNAL_SECRET / CRON_SECRET.
- `rate-limit.ts`, `config.ts` (24 h session), `login-action.ts` (blocks inactive profiles).

Security code: don't loosen checks; ask first.
