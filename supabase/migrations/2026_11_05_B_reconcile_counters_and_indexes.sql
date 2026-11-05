-- Group B perf fixes (5 Nov 2026). Additive and re-runnable.
-- See logs/reports/Vercel-Supabase-Optimization-Review-2026-11-04.md
-- (cron-watchdogs-08, supabase-db-11, supabase-db-17).

-- 1. cron-watchdogs-08: campaign counters recomputed in ONE statement.
--    Same rules as app/api/internal/reconcile-counters (JS version):
--    total = all campaign_leads rows, sent = first_sent_at set, replied =
--    last_reply_at set, bounced = crm_status 'failed' AND first_sent_at set
--    (a failed row never sent is not a bounce), hot/cold by lead_temperature.
--    Only live (not deleted) campaigns; only drifted rows are written.
--    No 1,000-row cap (the JS read was capped by PostgREST).
--    p_company_id: null = every company (the cron job); a uuid = one company.
create or replace function public.reconcile_campaign_counters(p_company_id uuid default null)
returns integer
language sql
security definer
set search_path = public
as $$
  with t as (
    select c2.id,
           count(cl.id)::int as total,
           count(cl.first_sent_at)::int as sent,
           count(cl.last_reply_at)::int as replied,
           (count(*) filter (where cl.crm_status = 'failed' and cl.first_sent_at is not null))::int as bounced,
           (count(*) filter (where cl.lead_temperature = 'hot'))::int as hot,
           (count(*) filter (where cl.lead_temperature = 'cold'))::int as cold
      from public.campaigns c2
      left join public.campaign_leads cl on cl.campaign_id = c2.id
     where not c2.is_deleted
       and (p_company_id is null or c2.company_id = p_company_id)
     group by c2.id
  ), upd as (
    update public.campaigns c
       set total_leads = t.total, sent_count = t.sent, replied_count = t.replied,
           bounced_count = t.bounced, hot_count = t.hot, cold_count = t.cold,
           updated_at = now()
      from t
     where t.id = c.id
       and (coalesce(c.total_leads, 0), coalesce(c.sent_count, 0), coalesce(c.replied_count, 0),
            coalesce(c.bounced_count, 0), coalesce(c.hot_count, 0), coalesce(c.cold_count, 0))
           is distinct from (t.total, t.sent, t.replied, t.bounced, t.hot, t.cold)
    returning 1
  )
  select count(*)::int from upd;
$$;

-- Server-only, like the other SECURITY DEFINER functions (2026_11_05_security_lockdown.sql).
revoke execute on function public.reconcile_campaign_counters(uuid) from public, anon, authenticated;
grant execute on function public.reconcile_campaign_counters(uuid) to service_role;

-- Daily at 02:30 UTC, the old Vercel cron's slot. Replaces the vercel.json
-- entry (no Vercel call). cron.schedule replaces a job with the same name.
select cron.schedule(
  'reconcile-campaign-counters',
  '30 2 * * *',
  $$select public.reconcile_campaign_counters()$$
);

-- 2. supabase-db-11: the watchdog's provider-fault recovery query
--    (enrichment-watchdog.ts triggerScrapeRecoveryWatchdog) walked all ~4,000
--    failed orgs (1,172 ms cold). Small partial index.
create index if not exists organizations_failed_status_idx
  on public.organizations (enrichment_status)
  where enrichment_stage = 'failed';

-- 3. supabase-db-17: "last event of type X" on enrichment_logs
--    (scrape-orgs SKIPPED_LOW_CREDITS lookup) scanned ~20K rows (695 ms).
create index if not exists enrichment_logs_event_created_at_idx
  on public.enrichment_logs (event, created_at desc);
