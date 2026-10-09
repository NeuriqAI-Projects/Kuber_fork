# lib/server/ — loaders for server components

`session.ts` (session + role + scoped client, redirects if not provisioned), `leads.ts`,
`leads-count.ts`, `lead-visibility.ts` (what counts as a "lead" vs a pre-reveal row),
`campaigns.ts` (employee-scoped counts), `dashboard.ts`, `imports.ts` (batch dropdown).
Always use the caller's scoped client — never count across companies.
