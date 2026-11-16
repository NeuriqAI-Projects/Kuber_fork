# Scopes end-to-end checks (live DB, Dev company only)

Creates throwaway `scopes-e2e-*@example.test` members in the Dev company, tests the API and the UI
(Playwright), then deletes them and restores the Dev leads it borrowed. Never spends credits: routes
that spend or send are only tested for their 403. Secrets come from `.env.local` at runtime.

1. `npm run dev` (one server; note the port, set `E2E_BASE` if not 3000)
2. `node --experimental-strip-types --no-warnings scripts/scopes-e2e/setup.mts`
3. `node --experimental-strip-types --no-warnings --test --test-concurrency=1 scripts/scopes-e2e/api.test.mts`
4. `node --experimental-strip-types --no-warnings scripts/scopes-e2e/ui.mts` (screenshots in the OS temp folder)
5. `node --experimental-strip-types --no-warnings scripts/scopes-e2e/teardown.mts` — always, even after a failure
6. Stop the dev server.
