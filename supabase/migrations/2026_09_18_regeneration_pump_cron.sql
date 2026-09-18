-- Keep bulk draft regeneration moving without relying on its self-chain.
--
-- The regenerate worker re-triggers itself batch to batch through after() +
-- fetch, and on production that chain dies every few batches. Measured on
-- 18 Sep 2026 on a 96-lead follow-up run: 20 items then silence; a manual
-- kick got 20 more, then silence again. The enrichment watchdog does revive
-- it, but it runs every ten minutes and only touches jobs five minutes stale,
-- so the run crawled for most of an hour while the campaign sat on hold.
--
-- With no job_id in the body the worker picks up any live job whose heartbeat
-- is over a minute old and runs one batch, so a dead chain costs a minute, not
-- fifteen. A pass with nothing to do is one indexed read.
--
-- Apply in the Supabase SQL editor (ping_internal_route already exists, see
-- 2026_07_23_pg_cron_internal_jobs.sql). cron.schedule upserts on the name.
select cron.schedule(
  'regeneration-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/regenerate-drafts', 60000)$$
);
