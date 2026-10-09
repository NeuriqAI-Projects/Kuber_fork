# scripts/ — one-off tools (not part of the app)

- `watchdog.js` — local stand-in for cron (`npm run watchdog`).
- `check-*` — small self-checks for one piece of logic (run with `node` / `npx tsx`).
- `repair-*`, `replay-*` — data fixes on the LIVE DB. Read before running; ask first.
- `probe-*`, `measure-*`, `diagnose-*` — read-only investigations of Apollo/Instantly.
- `e2e-*` — Playwright end-to-end runs (screenshots go to `scripts/e2e-shots/`, git-ignored).
- `create-admin-user.mjs`, `register-webhook.mjs`, `seed-*`, `simulate-*`, `sync-keyword-seed.ts`.

Scripts read `.env.local` and hit the live DB. Scratch files go in the scratchpad, not here.
Files starting with `_` are throwaway — don't commit them.
