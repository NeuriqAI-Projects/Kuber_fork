-- 2026-11-05 (perf fixes, group D): campaigns list, send fan-out, campaign credits.
-- Additive and safe to re-run (create or replace / if not exists). Functions take
-- the company id explicitly (the scoped client cannot add it to an RPC) and are
-- callable by the service role only. The app falls back to its old queries if a
-- function is missing.

-- Employee campaigns list in one call (was: campaign_leads read 3 times, 8-10 trips).
-- One row per campaign the employee can see, same rules as before:
--   visible   = campaigns they created / are assigned (not deleted), plus every
--               campaign holding a non-deleted lead assigned to them
--               (lib/auth/scope.ts employeeCampaignIds)
--   counts    = their own campaign_leads (lead assigned to them), bucketed like
--               lib/campaign-status.ts deliveryBucket:
--                 failed + first_sent_at  -> bounced
--                 replied                 -> replied
--                 other  + first_sent_at  -> sent
--               delivered = sent + replied + bounced (what the card's sent_count holds)
--   can_edit_settings = no OTHER employee is part of it (creator, assignee, or
--               owner of a non-deleted lead in it) — campaignsEditableByEmployee
create or replace function public.employee_campaign_stats(p_company uuid, p_user uuid)
returns table (
  campaign_id uuid,
  total_leads int,
  delivered_count int,
  replied_count int,
  bounced_count int,
  hot_count int,
  cold_count int,
  can_edit_settings boolean
)
language sql stable
set search_path = public
as $$
  with ids as (
    select c.id from campaigns c
    where c.company_id = p_company and c.is_deleted = false
      and (c.created_by = p_user or c.assigned_to = p_user)
    union
    select cl.campaign_id from campaign_leads cl
    join leads l on l.id = cl.lead_id
    where cl.company_id = p_company and l.assigned_to = p_user and l.is_deleted = false
  ),
  own as (
    select cl.campaign_id,
      count(*) as total,
      count(*) filter (where cl.crm_status::text not in ('failed', 'replied') and cl.first_sent_at is not null) as sent,
      count(*) filter (where cl.crm_status::text = 'replied') as replied,
      count(*) filter (where cl.crm_status::text = 'failed' and cl.first_sent_at is not null) as bounced,
      count(*) filter (where cl.lead_temperature::text = 'hot') as hot,
      count(*) filter (where cl.lead_temperature::text = 'cold') as cold
    from campaign_leads cl
    join leads l on l.id = cl.lead_id
    where cl.company_id = p_company and l.assigned_to = p_user
      and cl.campaign_id in (select id from ids)
    group by cl.campaign_id
  ),
  owners as (
    select c.id as campaign_id, c.created_by as uid from campaigns c
    where c.company_id = p_company and c.id in (select id from ids)
    union
    select c.id, c.assigned_to from campaigns c
    where c.company_id = p_company and c.id in (select id from ids)
    union
    select cl.campaign_id, l.assigned_to from campaign_leads cl
    join leads l on l.id = cl.lead_id
    where cl.company_id = p_company and l.is_deleted = false
      and cl.campaign_id in (select id from ids)
  ),
  shared as (
    select distinct o.campaign_id from owners o
    join profiles p on p.id = o.uid and p.company_id = p_company and p.role::text = 'employee'
    where o.uid <> p_user
  )
  select i.id,
    coalesce(o.total, 0)::int,
    (coalesce(o.sent, 0) + coalesce(o.replied, 0) + coalesce(o.bounced, 0))::int,
    coalesce(o.replied, 0)::int,
    coalesce(o.bounced, 0)::int,
    coalesce(o.hot, 0)::int,
    coalesce(o.cold, 0)::int,
    not exists (select 1 from shared s where s.campaign_id = i.id)
  from ids i
  left join own o on o.campaign_id = i.id;
$$;

-- Send fan-out: mark the leads Instantly accepted in one statement (was one
-- UPDATE request per lead, up to 500 in parallel per batch). Each lead gets its
-- own Instantly lead id; everything else matches the old per-row update.
create or replace function public.fanout_mark_sent(
  p_company uuid,
  p_sub_id uuid,
  p_ids uuid[],
  p_instantly_lead_ids text[],
  p_now timestamptz
)
returns int
language sql
set search_path = public
as $$
  with u as (
    update campaign_leads cl
    set instantly_campaign_id = p_sub_id,
        instantly_lead_id = x.iid,
        crm_status = 'sent',
        updated_at = p_now
    from unnest(p_ids, p_instantly_lead_ids) as x(id, iid)
    where cl.id = x.id and cl.company_id = p_company
    returning 1
  )
  select count(*)::int from u;
$$;

revoke execute on function public.employee_campaign_stats(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fanout_mark_sent(uuid, uuid, uuid[], text[], timestamptz) from public, anon, authenticated;
grant execute on function public.employee_campaign_stats(uuid, uuid) to service_role;
grant execute on function public.fanout_mark_sent(uuid, uuid, uuid[], text[], timestamptz) to service_role;

-- Campaign Credits tab: "emails delivered" counts lead_events by
-- event = 'email_delivered' and metadata @> {campaign_id[, step]}; with no index
-- that scanned every event of the company (~42K rows, ~70 ms). Small partial GIN
-- (~7.5K rows) serves exactly that query, so the numbers cannot change.
create index if not exists lead_events_delivered_metadata_idx
  on public.lead_events using gin (metadata jsonb_path_ops)
  where event = 'email_delivered';
