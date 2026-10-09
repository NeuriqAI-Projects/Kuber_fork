# lib/validators/ — zod schemas

One file per resource: `leads` (incl. ProspectSearch / ProspectDecision schemas), `campaigns`,
`drafts`, `enrichment`, `organizations`, `provider-keys`, `settings`, `users`, `id`.
Every `/api/v1` body is parsed with one of these. Add the schema here, not inline in the route.
