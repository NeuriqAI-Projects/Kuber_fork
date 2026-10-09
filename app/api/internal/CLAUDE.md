# app/api/internal/ — background jobs

Called by **Supabase pg_cron** (`ping_internal_route`, schedules live in the DB, see
`supabase/migrations/*_cron.sql`) and by Vercel cron (`vercel.json`: reconcile-counters).
GitHub workflow files are manual-only now.

| Route | Job |
|---|---|
| `score-prospects` | prospect fit-scoring pump, every minute |
| `write-followups` | write + push due follow-ups. **Always pass `company_id`** |
| `enrichment-watchdog` | restart stuck scrape / reveal chains |
| `resume-apollo-reveal` | continue email reveals after credits return |
| `auto-retry-failed-orgs` | retry failed company scrapes |
| `check-sequence-drift` | compare our sequences with Instantly's |
| `reconcile-counters` | nightly campaign counter fix |

Rules: check the secret first; cross-company is allowed here (admin client) but carry
`company_id` from each row; finish inside 60 s and let the next tick continue.
