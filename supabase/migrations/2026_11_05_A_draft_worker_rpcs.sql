-- Draft workers: two small additive functions (5 Nov 2026, cost review
-- pumps-drafts-07 and pumps-drafts-09). Re-runnable. The app falls back to the
-- old path when either function is missing, so applying this is optional.

-- 1. Claim bulk-regeneration items atomically.
--    The worker used to SELECT pending items, then UPDATE them to running in a
--    second statement, so the minute pump and the drawer's kick landing within
--    the same second could both claim (and pay an LLM call for) the same draft.
--    FOR UPDATE SKIP LOCKED: two claims at once never get the same row.
create or replace function public.claim_regeneration_items(p_job_id uuid, p_company uuid, p_limit int)
returns table (id uuid, campaign_lead_id uuid, lead_id uuid)
language sql
set search_path = public, pg_temp
as $$
  update draft_regeneration_job_items i
     set status = 'running', updated_at = now()
   where i.id in (
     select x.id from draft_regeneration_job_items x
      where x.job_id = p_job_id
        and x.company_id = p_company
        and x.status = 'pending'
      order by x.id
      limit p_limit
      for update skip locked
   )
  returning i.id, i.campaign_lead_id, i.lead_id;
$$;

-- 2. reset_stuck_draft_generation for ONE campaign.
--    The global version (two UPDATEs over every company, ~46 ms) ran on every
--    draft-worker hop. The hop only needs its own campaign cleaned; the
--    10-minute watchdog keeps running the global one for everything else.
--    Same rules as the global function, plus the campaign filter.
create or replace function public.reset_stuck_draft_generation_for_campaign(p_campaign_id uuid, stale_minutes integer default 5)
returns table (reset_campaigns integer, reset_drafts integer)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  c_count int;
  d_count int;
begin
  with upd as (
    update email_drafts
       set status = 'failed', updated_at = now()
     where campaign_id = p_campaign_id
       and status = 'generating'
       and created_at < now() - make_interval(mins => stale_minutes)
    returning id
  ) select count(*) into d_count from upd;

  with upd as (
    update campaigns c
       set status = 'draft', updated_at = now()
     where c.id = p_campaign_id
       and c.status = 'processing'
       and c.draft_generation_started_at < now() - make_interval(mins => stale_minutes)
       and not exists (
         select 1 from email_drafts d
          where d.campaign_id = c.id and d.status = 'generating'
       )
    returning c.id
  ) select count(*) into c_count from upd;

  return query select c_count, d_count;
end;
$$;

-- Server code only (service role), like the other worker functions.
revoke execute on function public.claim_regeneration_items(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.reset_stuck_draft_generation_for_campaign(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_regeneration_items(uuid, uuid, int) to service_role;
grant execute on function public.reset_stuck_draft_generation_for_campaign(uuid, integer) to service_role;
