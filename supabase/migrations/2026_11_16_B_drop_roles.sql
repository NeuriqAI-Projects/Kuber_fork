-- Member scopes, part B — run only AFTER the scopes code is live on production
-- (the old code reads profiles.role and would break). Decided 16 Nov 2026.
--
-- 1. Re-run 2026_11_16_A_member_scopes.sql first: it backfills scopes for anyone the
--    old code created between part A and the deploy.
-- 2. Then this file. Safe to re-run.

do $$ begin
  -- Refuse if anyone would be left with no access (non-owner, empty scopes, still active).
  if exists (select 1 from public.profiles where not is_owner and scopes = '{}' and is_active) then
    raise exception 'Some active members have no scopes yet. Re-run part A first.';
  end if;
  if exists (select company_id from public.profiles group by company_id having count(*) filter (where is_owner) <> 1) then
    raise exception 'Every company needs exactly one owner before the old columns are dropped.';
  end if;
end $$;

alter table public.profiles drop column if exists is_super_admin;
alter table public.profiles drop column if exists role;  -- also drops profiles_role_check
