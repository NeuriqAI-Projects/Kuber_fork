-- cron-watchdogs-12 (5 Nov 2026): a retry-after for provider faults.
--
-- When our own Firecrawl/LLM key is missing, dry or rate-limited, scrape-orgs'
-- markFailed requeues the org with status SCRAPE_PROVIDER_UNAVAILABLE and no
-- strike (right: it is not the company's fault). But claim_queued_orgs took it
-- straight back on the next self-chain hop, seconds later, to fail again.
-- Now such an org waits 10 minutes before it can be claimed again; the
-- 10-minute enrichment watchdog restarts the chain after that. Manual retries
-- set SCRAPE_QUEUED, so they are not delayed.
--
-- Same signature and body as before plus one filter. Re-runnable.
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
      and not (enrichment_status = 'SCRAPE_PROVIDER_UNAVAILABLE'
               and updated_at > now() - interval '10 minutes')
    order by created_at asc
    limit p_batch_size
    for update skip locked
  )
  returning *;
end;
$function$;
