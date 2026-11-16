# lib/auth/

Permissions are **scopes** (`docs/scopes.md`). No roles anywhere.

- `scopes.ts` — pure: `SCOPES` (the list, display order), `memberScopes` (owner = all,
  deactivated = none, unknown values ignored), `hasScope`, `can`, `canSeeAll` (reach:
  `leads:all` / `campaigns:all` / `unibox:all` / `dashboard:all`), `isLeadOwner` (who receives
  leads), `canManage` + `canGrant` (no escalation: a non-owner with `team:write` edits only members
  without `team:write`, may only add/remove scopes they hold, may not give `team:write`; nobody
  edits the owner or their own scopes). Tests: `scopes.test.mts`.
- `scope-areas.ts` — `SCOPE_AREAS` picker labels, `scopeLabel`, `SCOPE_TEMPLATES`
  (Manager / Employee = the old roles exactly; `scopes-parity.test.mts`), `templateName`.
- `api-auth.ts` — `requireAuth` (any active member; only for allow-listed open routes),
  `requireScope(req, scope | "owner")`, `assertScope(user, scope)` → `AuthedUser`
  (`id`, `companyId`, `isOwner`, `scopes`, `member`). Throw a Response; routes `catch (r) { return r }`.
  Scopes come from `profiles` (cached 30 s per instance, `forgetProfile` after a change), never the JWT.
  The service-role bearer = owner with every scope, `companyId: null`.
- `scope.ts` — row rules: without the reach scope a member sees only rows on leads assigned to
  them; `assertCampaignSettingsAccess` = shared-campaign rule for every campaign-wide change;
  `assertCampaignLeadAccess` for one lead inside a campaign.
- `verify-jwt.ts`, `jwks-cache.ts` — verify Supabase tokens locally (no Auth round-trip).
- `secret.ts` — `safeSecretEqual` for INTERNAL_SECRET / CRON_SECRET.
- `rate-limit.ts`, `config.ts` (24 h session), `login-action.ts` (blocks inactive / unprovisioned profiles).
- Tests that guard the wiring: `access-wiring.test.mts` (every route has a scope, no write behind a
  read scope, banned role words), `scopes-sql.test.mts` (code list = DB list).

Security code: don't loosen checks; ask first.
