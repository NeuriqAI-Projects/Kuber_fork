-- Member scopes, part B — run only AFTER the scopes code is live on production
-- (the old code reads profiles.role and would break). Decided 16 Nov 2026.
-- Safe to re-run. Do NOT re-run part A to "fix" members: its backfill is one-time on purpose.
--
-- Before dropping, it lists active members with no permissions at all (e.g. someone the old
-- code created between part A and the deploy). That can be deliberate, so it does not block:
-- give them boxes in Settings → Team afterwards if it was not.

do $$
declare r record;
begin
  if exists (select company_id from public.profiles group by company_id having count(*) filter (where is_owner) <> 1) then
    raise exception 'Every company needs exactly one owner before the old columns are dropped.';
  end if;
  for r in select company_id, email from public.profiles where not is_owner and scopes = '{}' and is_active loop
    raise notice 'No permissions: % (company %)', r.email, r.company_id;
  end loop;
end $$;

alter table public.profiles drop column if exists is_super_admin;
alter table public.profiles drop column if exists role;  -- also drops profiles_role_check
