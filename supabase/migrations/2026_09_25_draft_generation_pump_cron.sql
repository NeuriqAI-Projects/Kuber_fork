-- Keep opening-draft generation moving without relying on its self-chain.
--
-- The draft worker re-triggers itself batch to batch, and on production that
-- chain dies after ~5 hops. The watchdog revives it, but only every 10 minutes
-- for campaigns 5 minutes quiet, so on 24 Sep 2026 a 121-lead campaign took
-- 1h40m to draft. With no campaign_id the worker restarts any campaign whose
-- drafting has stopped (nothing in flight, no draft for a minute, leads still
-- waiting) and leaves live ones alone. An idle pass is a few indexed reads.
--
-- Also schedules the matching pump for bulk regeneration
-- (2026_09_18_regeneration_pump_cron.sql, never applied until now).
--
-- Apply in the Supabase SQL editor. cron.schedule upserts on the name, so
-- running this twice is harmless.
select cron.schedule(
  'draft-generation-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/generate-drafts', 60000)$$
);

select cron.schedule(
  'regeneration-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/regenerate-drafts', 60000)$$
);
