# lib/server/ — loaders for server components

`session.ts` (session + member access + scoped client, redirects if not an active member; `requirePageScope`),
`leads-count.ts`, `lead-visibility.ts` (what counts as a "lead" vs a pre-reveal row),
`dashboard.ts`, `imports.ts` (batch dropdown).
Always use the caller's scoped client — never count across companies.
