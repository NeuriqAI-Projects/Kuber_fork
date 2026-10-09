# app/ — Next.js App Router

- `layout.tsx`, `globals.css` — root layout + the colour ladder / global focus-ring reset (see root CLAUDE.md).
- `page.tsx` — login / entry.
- `(app)/` — signed-in screens (own CLAUDE.md).
- `api/` — all HTTP routes (own CLAUDE.md).

Pages are thin: server `page.tsx` loads data via `lib/server/*`, then hands it to a
`*-client.tsx` or a component in `components/app/`. Put logic in `lib/`, not here.
