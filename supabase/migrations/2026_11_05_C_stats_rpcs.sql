-- 2026-11-05 (perf fixes, group C): read-only count/aggregate functions so the
-- Dashboard, Team page and Kuber AI stop downloading rows to count them in JS.
-- Additive and safe to re-run (create or replace). Every function takes the
-- company id explicitly (the app's scoped client cannot add it to an RPC) and is
-- callable by the service role only: the app always calls them server-side.
-- The app falls back to its old queries if a function is missing.

-- Dashboard numbers in one call (was ~15 requests). Same rules as before:
--   total_leads  = every non-deleted lead in scope (pre-reveal rows included)
--   by_status    = revealed leads (email not null) per status
--   monthly[i]   = revealed leads created in [p_bounds[i], p_bounds[i+1])
--   temperature  = campaign_leads per lead_temperature ('(none)' = null).
--     Manager (p_user null): every campaign_lead of the company — this was a
--     plain select capped at 1,000 rows, so the old numbers were wrong.
--     Employee: rows of campaigns they created / are assigned to, plus rows of
--     leads assigned to them.
create or replace function public.dashboard_stats(p_company uuid, p_user uuid, p_bounds timestamptz[])
returns jsonb
language sql stable
set search_path = public
as $$
  with l as (
    select status::text as status, created_at, email is not null as revealed
    from leads
    where company_id = p_company and is_deleted = false
      and (p_user is null or assigned_to = p_user)
  ),
  acc as (
    select id from campaigns
    where company_id = p_company and is_deleted = false
      and (created_by = p_user or assigned_to = p_user)
  ),
  cl as (
    select c.lead_temperature
    from campaign_leads c
    where c.company_id = p_company
      and (p_user is null
           or c.campaign_id in (select id from acc)
           or exists (select 1 from leads x where x.id = c.lead_id and x.assigned_to = p_user))
  )
  select jsonb_build_object(
    'total_leads', (select count(*) from l),
    'by_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                  from (select status, count(*) as n from l where revealed group by status) s),
    'monthly', (select coalesce(jsonb_agg(n order by i), '[]'::jsonb)
                from (select i, (select count(*) from l
                                 where revealed and created_at >= p_bounds[i] and created_at < p_bounds[i + 1]) as n
                      from generate_series(1, coalesce(array_length(p_bounds, 1), 1) - 1) as i) m),
    'temperature', (select coalesce(jsonb_object_agg(t, n), '{}'::jsonb)
                    from (select coalesce(lead_temperature, '(none)') as t, count(*) as n from cl group by 1) x)
  );
$$;

-- Team page: leads assigned per employee + distinct LIVE campaigns holding at
-- least one of their (non-deleted) leads. The campaign count read every
-- campaign_leads row and was capped at 1,000.
create or replace function public.team_oversight_counts(p_company uuid)
returns table (user_id uuid, assigned_lead_count bigint, campaign_count bigint)
language sql stable
set search_path = public
as $$
  select p.id,
    (select count(*) from leads l
      where l.company_id = p_company and l.assigned_to = p.id and l.is_deleted = false),
    (select count(distinct cl.campaign_id) from campaign_leads cl
      join leads l on l.id = cl.lead_id
      join campaigns c on c.id = cl.campaign_id
      where cl.company_id = p_company and l.assigned_to = p.id and l.is_deleted = false
        and c.company_id = p_company and c.is_deleted = false)
  from profiles p
  where p.company_id = p_company and p.role = 'employee';
$$;

-- Kuber AI pipeline_overview / Home "at a glance": the ~16 head counts in one
-- call. p_user = employee scope (their assigned leads), null = whole company.
-- Left joins: the manager counts never required the lead row to exist.
create or replace function public.assistant_overview_counts(p_company uuid, p_user uuid, p_since timestamptz)
returns jsonb
language sql stable
set search_path = public
as $$
  with l as (
    select status::text as status, created_at from leads
    where company_id = p_company and is_deleted = false and (p_user is null or assigned_to = p_user)
  ),
  cl as (
    select c.crm_status::text as crm_status, c.lead_temperature, c.interest_status
    from campaign_leads c
    where c.company_id = p_company
      and (p_user is null or exists (select 1 from leads x where x.id = c.lead_id and x.assigned_to = p_user))
  )
  select jsonb_build_object(
    'lead_status', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
                    from (select status, count(*) as n from l group by 1) s),
    'added_since', (select count(*) from l where created_at >= p_since),
    'cl_status', (select coalesce(jsonb_object_agg(crm_status, n), '{}'::jsonb)
                  from (select crm_status, count(*) as n from cl group by 1) s),
    'hot', (select count(*) from cl where lead_temperature = 'hot'),
    'interested', (select count(*) from cl where interest_status = 1),
    'drafts_waiting', (select count(*) from email_drafts d
                       left join leads x on x.id = d.lead_id
                       where d.company_id = p_company and d.status = 'draft'
                         and (p_user is null or x.assigned_to = p_user)),
    'enrichment_failed', (select count(*) from lead_events e
                          left join leads x on x.id = e.lead_id
                          where e.company_id = p_company and e.event = 'enrichment_failed' and e.created_at >= p_since
                            and (p_user is null or x.assigned_to = p_user))
  );
$$;

-- Kuber AI team_overview: non-deleted leads per (assignee, status).
create or replace function public.lead_counts_by_assignee(p_company uuid)
returns table (assigned_to uuid, status text, n bigint)
language sql stable
set search_path = public
as $$
  select assigned_to, status::text, count(*)
  from leads
  where company_id = p_company and is_deleted = false
  group by 1, 2;
$$;

-- Kuber AI drafts_overview: email drafts in one status per campaign.
create or replace function public.email_drafts_by_campaign(p_company uuid, p_status text, p_user uuid)
returns table (campaign_id uuid, n bigint)
language sql stable
set search_path = public
as $$
  select d.campaign_id, count(*)
  from email_drafts d
  left join leads x on x.id = d.lead_id
  where d.company_id = p_company and d.status = p_status
    and (p_user is null or x.assigned_to = p_user)
  group by 1;
$$;

-- Kuber AI recent_activity: lead_events per (event, actor) with the newest
-- time of each group (keeps the old "first seen" order for ties). Inner join
-- to leads, as the old query did (events of a vanished lead are not shown).
create or replace function public.lead_event_counts(
  p_company uuid, p_since timestamptz, p_user uuid, p_event text, p_actor uuid, p_lead uuid)
returns table (event text, actor_id uuid, n bigint, latest timestamptz)
language sql stable
set search_path = public
as $$
  select e.event, e.actor_id, count(*), max(e.created_at)
  from lead_events e
  join leads x on x.id = e.lead_id
  where e.company_id = p_company and e.created_at >= p_since
    and (p_user is null or x.assigned_to = p_user)
    and (p_event is null or e.event = p_event)
    and (p_actor is null or e.actor_id = p_actor)
    and (p_lead is null or e.lead_id = p_lead)
  group by 1, 2;
$$;

-- AI spend (Settings > AI tab and the assistant's usage_and_credits): llm_usage
-- summed per (purpose, provider, model, user, UTC day). A few hundred groups
-- instead of every row in the window (up to 100,000).
create or replace function public.llm_usage_summary(p_company uuid, p_since timestamptz)
returns table (
  purpose text, provider text, model text, user_id uuid, day text,
  calls bigint, cost_usd numeric, input_tokens bigint, output_tokens bigint,
  cache_read_tokens bigint, cache_write_tokens bigint, failed bigint, unpriced bigint, last_used timestamptz)
language sql stable
set search_path = public
as $$
  select purpose, provider, model, user_id, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD'),
    count(*), coalesce(sum(cost_usd), 0),
    coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
    coalesce(sum(cache_read_tokens), 0), coalesce(sum(cache_write_tokens), 0),
    count(*) filter (where error is not null and error <> ''),
    count(*) filter (where (error is null or error = '') and cost_usd is null),
    max(created_at)
  from llm_usage
  where company_id = p_company and created_at >= p_since
  group by 1, 2, 3, 4, 5;
$$;

-- Server-only, like the other functions locked down on 5 Nov.
revoke execute on function public.dashboard_stats(uuid, uuid, timestamptz[]) from public, anon, authenticated;
revoke execute on function public.team_oversight_counts(uuid) from public, anon, authenticated;
revoke execute on function public.assistant_overview_counts(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.lead_counts_by_assignee(uuid) from public, anon, authenticated;
revoke execute on function public.email_drafts_by_campaign(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function public.lead_event_counts(uuid, timestamptz, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.llm_usage_summary(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.dashboard_stats(uuid, uuid, timestamptz[]) to service_role;
grant execute on function public.team_oversight_counts(uuid) to service_role;
grant execute on function public.assistant_overview_counts(uuid, uuid, timestamptz) to service_role;
grant execute on function public.lead_counts_by_assignee(uuid) to service_role;
grant execute on function public.email_drafts_by_campaign(uuid, text, uuid) to service_role;
grant execute on function public.lead_event_counts(uuid, timestamptz, uuid, text, uuid, uuid) to service_role;
grant execute on function public.llm_usage_summary(uuid, timestamptz) to service_role;
