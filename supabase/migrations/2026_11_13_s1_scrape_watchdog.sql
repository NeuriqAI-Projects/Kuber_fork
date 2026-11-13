-- Scrape / watchdog wasted calls (13 Nov 2026, agent S1). Re-runnable.
-- Ledger: logs/reports/perf-fixes-2026-11-13/S1.md
--
-- 1. claim_queued_orgs: NULL-safe provider-fault filter.
--    `not (status = 'SCRAPE_PROVIDER_UNAVAILABLE' and updated_at > now()-10 min)`
--    is NULL (so never claimed) when status and updated_at are both NULL. Two
--    client orgs inserted by the Apollo reveal (enrich-leads.ts, now fixed) sat
--    queued from 6 Nov and woke scrape-orgs 144 times a day for nothing.
--    One-off data fix run once by hand on 13 Nov (not part of this file):
--    `update organizations set updated_at = now()` for exactly those 2 rows
--    (rinehart3d.com, clearviewpackaging.com), so the 24 h clean-up does not
--    write them off before they are scraped (user decision).
--
-- 2. enrichment-watchdog cron: SQL gate. It called Vercel 144/144 times a day.
--    Now it runs once an hour (minute < 10: Instantly webhook + balance, outage
--    banner refresh, scrape credit re-check) and otherwise only when one of its
--    jobs has work. Each branch mirrors lib/services/enrichment-watchdog.ts:
--    a. hasScrapeWork (same rule as claim_queued_orgs below), unless scrape-orgs
--       skipped for credits in the last hour (scrapeHeldForCredits).
--    b. triggerScrapeRecoveryWatchdog: failed SCRAPE_PROVIDER_UNAVAILABLE orgs
--       whose company has a usable Firecrawl key (hasUsableServiceKey).
--    c. triggerRegenerationWatchdog: stalled jobs; expired (24 h) or the company
--       has a usable AI key (hasUsableLlmKey).
--    d. triggerDraftGenerationWatchdog: reset_stuck_draft_generation work
--       (old 'generating' drafts, stale 'processing' campaigns) or a stale
--       campaign with a lead waiting (draft-generation-pump predicate).
--    SQL cannot see env-var keys (production has none); the hourly pass still
--    runs every job, so nothing waits more than an hour.
--
-- 3. unibox-sync: hourly at :05 (was every 15 min; user decision 13 Nov).
--    The webhook still writes replies at once; the sync only catches misses.
--
-- (AUDIT #15, purge cron history after 3 days instead of 7, deletes rows: not
--  applied here, listed under "User must run" in the ledger.)
--
-- Commands copied from cron.job on 13 Nov 2026; only the gate / schedule /
-- interval changed. To revert: re-run the old commands from that table
-- (watchdog: no where clause, */10; unibox-sync: */15).

create or replace function public.claim_queued_orgs(p_batch_size integer)
returns setof organizations
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
  update organizations
  set enrichment_stage = 'scraping',
      enrichment_status = 'SCRAPE_BATCH_STARTED',
      enrichment_started_at = now(),
      updated_at = now()
  where id in (
    select id from organizations
    where enrichment_stage = 'queued'
      and domain is not null
      and domain <> ''
      and not coalesce(enrichment_status = 'SCRAPE_PROVIDER_UNAVAILABLE'
                       and updated_at > now() - interval '10 minutes', false)
    order by created_at asc
    limit p_batch_size
    for update skip locked
  )
  returning *;
end;
$function$;

select cron.schedule('enrichment-watchdog', '*/10 * * * *', $cmd$select public.ping_internal_route('/api/internal/enrichment-watchdog', 60000)
    where extract(minute from now()) < 10
       or (exists (
             select 1 from public.organizations
             where (enrichment_stage = 'queued'
                    and not coalesce(enrichment_status = 'SCRAPE_PROVIDER_UNAVAILABLE'
                                     and updated_at > now() - interval '10 minutes', false))
                or (enrichment_stage = 'scraping'
                    and enrichment_started_at < now() - interval '10 minutes'))
           and not exists (
             select 1 from public.enrichment_logs
             where event = 'SKIPPED_LOW_CREDITS' and created_at > now() - interval '60 minutes'))
       or exists (
             select 1 from public.organizations o
             where o.enrichment_stage = 'failed' and o.enrichment_status = 'SCRAPE_PROVIDER_UNAVAILABLE'
               and exists (
                 select 1 from public.provider_keys k
                 where k.company_id = o.company_id and k.provider = 'firecrawl' and k.is_active
                   and (k.status = 'healthy' or (k.status = 'cooling_off' and k.cooling_off_until <= now()))))
       or exists (
             select 1 from public.draft_regeneration_jobs j
             where j.status in ('queued', 'running')
               and (j.heartbeat_at is null or j.heartbeat_at < now() - interval '5 minutes')
               and j.created_at < now() - interval '5 minutes'
               and (j.created_at < now() - interval '24 hours'
                    or j.company_id is null
                    or exists (
                      select 1 from public.provider_keys k
                      where k.company_id = j.company_id and k.is_active
                        and k.provider not in ('apollo', 'instantly', 'firecrawl', 'jev', 'tavily')
                        and (k.status = 'healthy' or (k.status = 'cooling_off' and k.cooling_off_until <= now())))))
       or exists (
             select 1 from public.email_drafts
             where status = 'generating' and created_at < now() - interval '5 minutes')
       or exists (
             select 1 from public.campaigns c
             where c.status = 'processing'
               and c.draft_generation_started_at < now() - interval '5 minutes'
               and not exists (
                 select 1 from public.email_drafts d where d.campaign_id = c.id and d.status = 'generating'))
       or exists (
             select 1 from public.campaign_leads cl
             join public.campaigns c on c.id = cl.campaign_id
             join public.leads l on l.id = cl.lead_id
             where c.status in ('draft', 'processing', 'active')
               and not c.is_deleted
               and c.draft_generation_started_at < now() - interval '5 minutes'
               and cl.draft_id is null
               and cl.crm_status in ('new', 'enriched', 'draft')
               and l.email is not null
               and not public.company_llm_keys_all_down(c.company_id))$cmd$);

select cron.schedule('unibox-sync', '5 * * * *', $cmd$select public.ping_internal_route('/api/v1/unibox/sync', 60000)$cmd$);
