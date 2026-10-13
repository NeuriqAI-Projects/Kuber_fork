-- resume-apollo-reveal: every 30 minutes -> every 5 minutes (10 Oct 2026).
-- Safe for the same reasons the 30-minute change was (2026_09_04): each lead
-- is asked about at most twice, only one reveal runs at a time, and a pass
-- that dies unlocks itself after 10 minutes. Same credits, just sooner.
-- Scored searches now start their reveal straight away; this is the backup.
-- To revert: re-run with '*/30 * * * *'.
select cron.unschedule('resume-apollo-reveal')
where exists (select 1 from cron.job where jobname = 'resume-apollo-reveal');
select cron.schedule(
  'resume-apollo-reveal',
  '*/5 * * * *',
  $$select public.ping_internal_route('/api/internal/resume-apollo-reveal', 60000)$$
);
