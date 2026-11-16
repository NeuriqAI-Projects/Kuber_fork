-- Member scopes (docs/notes/scopes-plan.md). Part A — run BEFORE the scopes code deploys.
-- Safe to re-run. Drops nothing (role / is_super_admin go in part B, after the code is live).
--
-- profiles.scopes  : the boxes ticked in Settings → Team, in SCOPES order (lib/auth/scopes.ts).
-- profiles.is_owner: one per company, holds every scope whatever is stored.

alter table public.profiles add column if not exists scopes text[] not null default '{}';
alter table public.profiles add column if not exists is_owner boolean not null default false;
-- New members are created without a role from now on.
alter table public.profiles alter column role drop not null;

-- The full list, same order as SCOPES in lib/auth/scopes.ts. Re-created by every migration
-- that adds a scope, and run BEFORE the code that can save the new scope goes live.
create or replace function public.kuber_scopes_valid(p_scopes text[])
returns boolean language sql immutable set search_path = '' as $$
  select p_scopes is not null
     and p_scopes <@ array[
       'dashboard:read', 'dashboard:all',
       'leads:read', 'leads:all', 'leads:write', 'leads:assign', 'leads:delete', 'leads:import',
       'organizations:read', 'organizations:write',
       'prospects:read', 'prospects:run',
       'campaigns:read', 'campaigns:all', 'campaigns:write', 'campaigns:generate', 'campaigns:assign', 'campaigns:send', 'campaigns:delete',
       'unibox:read', 'unibox:all', 'unibox:reply', 'unibox:write',
       'model_lab:read', 'model_lab:write',
       'credits:read',
       'assistant:use', 'assistant:actions', 'assistant:admin',
       'settings:write',
       'knowledge:write',
       'keys:read', 'keys:write', 'sending_accounts:write',
       'team:read', 'team:write'
     ]::text[]
$$;
revoke all on function public.kuber_scopes_valid(text[]) from public, anon, authenticated;
grant execute on function public.kuber_scopes_valid(text[]) to service_role;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_scopes_valid') then
    alter table public.profiles add constraint profiles_scopes_valid check (public.kuber_scopes_valid(scopes));
  end if;
end $$;

-- "Lead owner" (who receives leads / counts as a campaign owner). Mirrors isLeadOwner in
-- lib/auth/scopes.ts: not the owner, leads:read ticked, leads:all not ticked. Ignores
-- is_active, exactly like the old role = 'employee' test it replaces.
create or replace function public.kuber_is_lead_owner(p_is_owner boolean, p_scopes text[])
returns boolean language sql immutable set search_path = '' as $$
  select not p_is_owner and 'leads:read' = any(p_scopes) and not ('leads:all' = any(p_scopes))
$$;
revoke all on function public.kuber_is_lead_owner(boolean, text[]) from public, anon, authenticated;
grant execute on function public.kuber_is_lead_owner(boolean, text[]) to service_role;

-- ── Backfill (idempotent) ───────────────────────────────────────────────────
-- Owners. Dev company had two super admins; decided 16 Nov 2026: Lakshit is the Dev owner.
-- Every other company: its single super admin.
update public.profiles set is_owner = true
 where company_id = '00000000-0000-0000-0000-00000000000a' and email = 'lakshit@gmail.com' and not is_owner;
update public.profiles p set is_owner = true
 where p.is_super_admin and not p.is_owner
   and p.company_id <> '00000000-0000-0000-0000-00000000000a'
   and not exists (select 1 from public.profiles o where o.company_id = p.company_id and o.is_owner);

create unique index if not exists profiles_one_owner_per_company
  on public.profiles (company_id) where is_owner;

-- Managers / employees → their template (lib/auth/scope-areas.ts SCOPE_TEMPLATES), only
-- where nothing is ticked yet. The other Dev super admin becomes a Manager-template member.
update public.profiles set scopes = array[
  'dashboard:read', 'dashboard:all',
  'leads:read', 'leads:all', 'leads:write', 'leads:assign', 'leads:delete', 'leads:import',
  'organizations:read', 'organizations:write',
  'prospects:read', 'prospects:run',
  'campaigns:read', 'campaigns:all', 'campaigns:write', 'campaigns:generate', 'campaigns:assign', 'campaigns:send', 'campaigns:delete',
  'unibox:read', 'unibox:all', 'unibox:reply', 'unibox:write',
  'model_lab:read', 'model_lab:write',
  'credits:read',
  'assistant:use', 'assistant:actions', 'assistant:admin',
  'settings:write',
  'knowledge:write',
  'keys:read', 'keys:write',
  'team:read', 'team:write'
]::text[]
 where role = 'manager' and scopes = '{}' and not is_owner;

update public.profiles set scopes = array[
  'dashboard:read',
  'leads:read', 'leads:write',
  'campaigns:read', 'campaigns:write', 'campaigns:generate', 'campaigns:send', 'campaigns:delete',
  'unibox:read', 'unibox:reply', 'unibox:write',
  'assistant:use', 'assistant:actions',
  'knowledge:write'
]::text[]
 where role = 'employee' and scopes = '{}' and not is_owner;

-- ── DB functions that read role = 'employee' → lead-owner rule ─────────────
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
  where p.company_id = p_company and public.kuber_is_lead_owner(p.is_owner, p.scopes);
$$;
revoke execute on function public.team_oversight_counts(uuid) from public, anon, authenticated;
grant execute on function public.team_oversight_counts(uuid) to service_role;

create or replace function public.employee_campaign_stats(p_company uuid, p_user uuid)
returns table (
  campaign_id uuid, total_leads int, delivered_count int, replied_count int,
  bounced_count int, hot_count int, cold_count int, can_edit_settings boolean
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
    join profiles p on p.id = o.uid and p.company_id = p_company
     and public.kuber_is_lead_owner(p.is_owner, p.scopes)
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
revoke execute on function public.employee_campaign_stats(uuid, uuid) from public, anon, authenticated;
grant execute on function public.employee_campaign_stats(uuid, uuid) to service_role;

-- Check after running (expect one owner per company, nobody without scopes except owners):
-- select company_id, email, is_owner, role, array_length(scopes, 1) from public.profiles order by 1, 3 desc, 2;
