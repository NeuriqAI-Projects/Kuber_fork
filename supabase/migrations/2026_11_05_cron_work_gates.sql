-- Only wake Vercel when there is work (5 Nov 2026).
-- The five busy pumps below pinged Vercel ~5,900 times a day and found nothing
-- almost every time (~65% of all Vercel invocations, see
-- logs/reports/Vercel-Supabase-Optimization-Review-2026-11-04.md, cron-watchdogs-02).
-- Each job now asks the same "is there work?" question as its route, in SQL.
-- A SELECT with no FROM skips its select list when the WHERE is false, so
-- pg_net is never called. Each gate costs well under 1 ms.
--
-- The routes keep their own checks, so a gate that is slightly too loose only
-- costs one idle call. If a route's work rule changes, change its gate here too:
--   draft pump      -> app/api/enrich/generate-drafts/route.ts pumpStalledCampaigns
--   regeneration    -> app/api/enrich/regenerate-drafts/route.ts (no job_id branch)
--   follow-up pump  -> app/api/internal/write-followups/route.ts (body.pump branch)
--   scoring pump    -> lib/services/prospects/worker.ts companiesWithWork + WORKABLE
--   apollo reveal   -> lib/services/enrichment-watchdog.ts triggerEnrichWatchdog + MAX_ENRICH_ATTEMPTS
-- Re-runnable: cron.schedule replaces a job with the same name.
-- To revert: re-run the same cron.schedule calls without the WHERE.

select cron.schedule(
  'draft-generation-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/generate-drafts', 60000)
    where exists (
      select 1 from public.campaign_leads cl
      join public.campaigns c on c.id = cl.campaign_id
      join public.leads l on l.id = cl.lead_id
      where c.status in ('draft', 'processing', 'active')
        and not c.is_deleted
        and c.draft_generation_started_at is not null
        and cl.draft_id is null
        and cl.crm_status in ('new', 'enriched', 'draft')
        and l.email is not null)$$
);

select cron.schedule(
  'regeneration-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/regenerate-drafts', 60000)
    where exists (
      select 1 from public.draft_regeneration_jobs
      where status in ('queued', 'running')
        and (heartbeat_at is null or heartbeat_at < now() - interval '1 minute'))$$
);

select cron.schedule(
  'followup-pump',
  '* * * * *',
  $$select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'app_base_url') || '/api/internal/write-followups',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-internal-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'internal_secret')),
      body := '{"pump": true}'::jsonb,
      timeout_milliseconds := 60000)
    where exists (
      select 1 from public.campaigns
      where sequence_publish_pending and not is_deleted)$$
);

select cron.schedule(
  'prospect-scoring-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/internal/score-prospects', 60000)
    where exists (
      select 1 from public.prospect_companies
      where status in ('queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits')
        and (locked_until is null or locked_until <= now()))
    or exists (
      select 1 from public.prospect_searches where run_status = 'running')$$
);

select cron.schedule(
  'resume-apollo-reveal',
  '*/5 * * * *',
  $$select public.ping_internal_route('/api/internal/resume-apollo-reveal', 60000)
    where exists (
      select 1 from public.leads
      where lead_source = 'apollo'
        and has_email
        and not is_deleted
        and enrich_attempts < 2
        and email is null
        and import_id is not null)$$
);

-- Park the Dev company's 160 [TEST] [no-credits] prospects (22-23 Oct). In mock
-- mode they can never get credits, so they re-locked every 10 minutes for ever:
-- ~54K Supabase requests a day (supabase-db-01). Dev company only.
update public.prospect_companies
   set status = 'review', last_error = 'test data parked', locked_until = null
 where company_id = '00000000-0000-0000-0000-00000000000a'
   and status = 'waiting_credits';
