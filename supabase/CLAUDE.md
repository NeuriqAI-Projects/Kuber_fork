# supabase/

- `migrations/` — SQL files named `YYYY_MM_DD_topic.sql`. **The user runs them by hand** in
  the Supabase SQL editor on the LIVE DB. Never apply them yourself; give the SQL and ask.
- `*_cron.sql` files schedule pg_cron jobs (`ping_internal_route`). Cron schedules live in
  the DB, not in GitHub workflow files.
- New tables need `company_id` + RLS enabled (service role bypasses it).
- Old pre-June schema / migrations: `docs/legacy/`.
- `.temp/` is Supabase CLI cache — ignore.
- Free plan, no backups: write migrations that are safe to re-run (`if not exists`).
