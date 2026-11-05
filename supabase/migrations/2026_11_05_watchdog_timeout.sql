-- enrichment-watchdog: wait up to 60 s for the reply (5 Nov 2026).
-- It used pg_net's default 15 s, so 36 of 36 passes in 6 h were logged as timeouts
-- while the route kept running. The route now exports maxDuration = 60.
-- Re-runnable: cron.schedule replaces the job with the same name.
select cron.schedule(
  'enrichment-watchdog',
  '*/10 * * * *',
  $$select public.ping_internal_route('/api/internal/enrichment-watchdog', 60000)$$
);
