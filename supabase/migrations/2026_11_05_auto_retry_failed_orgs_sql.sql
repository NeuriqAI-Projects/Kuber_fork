-- auto-retry-failed-orgs: one SQL statement instead of a Vercel route (5 Nov 2026).
--
-- The route read up to 1,000 failed orgs, then counted leads for them one org
-- at a time (~300 s, the most-called query in the DB), then sent ~1,000 ids in
-- one URL that the gateway rejected. Nothing was requeued after 7 Sep, and every
-- run held a Vercel instance until it timed out (supabase-db-04 in
-- logs/reports/Vercel-Supabase-Optimization-Review-2026-11-04.md).
--
-- Rules kept from the route (app/api/internal/auto-retry-failed-orgs/route.ts):
-- - a broken site gets at most 3 tries in its life (enrichment_attempts is never
--   reset here; scrape-orgs' markFailed counts up and parks it at 3),
-- - only orgs that failed 3 h+ ago, so it never fights a manual retry,
-- - only orgs that still have a lead with an email,
-- - terminal statuses are skipped (lib/services/enrichment-status.ts
--   TERMINAL_ENRICHMENT_STATUSES; SCRAPE_EMPTY / SCRAPE_DOMAIN_UNREACHABLE were
--   missing from the route),
-- - "Retry all" and per-org rescrape still reset the counter (manual override).
-- New: at most 200 orgs per run, and Vercel (scrape-orgs) is only called when
-- something was requeued. Logs one SCRAPE_QUEUED row per company, like the route.

-- 1. Park the backlog (user decision, 5 Nov 2026: "don't try the 2,203
--    organizations now, mark them as max attempt reached"). All were client
--    company orgs: 2,030 ENRICHMENT_NEVER_RAN, 103 ENRICHMENT_FAILED_PERMANENT,
--    40 SCRAPE_EMPTY, 30 SCRAPE_DOMAIN_UNREACHABLE. Status text left as it was.
--    Re-runnable: matches 0 rows once applied.
update public.organizations
   set enrichment_attempts = 3
 where enrichment_stage = 'failed'
   and enrichment_status not in ('NO_DOMAIN', 'NO_EMAILED_LEADS')
   and domain is not null
   and enrichment_attempts < 3;

-- 2. The job itself. Re-runnable: cron.schedule replaces a job with the same name.
select cron.schedule(
  'auto-retry-failed-orgs',
  '15 */6 * * *',
  $$with req as (
      update public.organizations o
         set has_scraped = false,
             enrichment_stage = 'queued',
             enrichment_status = 'SCRAPE_QUEUED',
             last_error = null,
             updated_at = now()
       where o.id in (
         select o2.id from public.organizations o2
          where o2.enrichment_stage = 'failed'
            and o2.enrichment_status not in ('NO_DOMAIN', 'NO_EMAILED_LEADS', 'SCRAPE_DOMAIN_UNREACHABLE', 'SCRAPE_EMPTY')
            and o2.domain is not null
            and o2.enrichment_attempts < 3
            and o2.updated_at < now() - interval '3 hours'
            and exists (
              select 1 from public.leads l
               where l.organization_id = o2.id
                 and not l.is_deleted
                 and (l.email is not null or l.has_email))
          limit 200)
      returning o.id, o.company_id
    ), logged as (
      insert into public.enrichment_logs (source, event, company_id, payload)
      select 'system', 'SCRAPE_QUEUED', company_id,
             jsonb_build_object('total_orgs', count(*), 'triggered_by', 'auto_retry_stale_failures')
        from req group by company_id
    )
    select public.ping_internal_route('/api/enrich/scrape-orgs', 60000)
     where exists (select 1 from req)$$
);
