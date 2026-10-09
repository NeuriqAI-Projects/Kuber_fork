-- Atomic per-search cap on automatic reveals.
--
-- Prospects are now scored by several lanes at once. "Count the good ones,
-- then mark this one good" was two steps, so two lanes could both see 19/20
-- and both reveal: the cap overshoots and real Apollo credits are spent. This
-- makes taking a slot ONE statement: the row update only succeeds while
-- used < cap, and Postgres row locking serialises concurrent callers.
--
-- The cap is the search's own `filters.max_auto_reveals` when set, else the
-- company default passed in.
alter table prospect_searches add column if not exists auto_reveals_used int not null default 0;

create or replace function public.reserve_auto_reveal(p_search uuid, p_default_cap int)
returns boolean
language sql
as $$
  with taken as (
    update prospect_searches s
       set auto_reveals_used = auto_reveals_used + 1,
           updated_at = now()
     where s.id = p_search
       and s.auto_reveals_used < coalesce((s.filters->>'max_auto_reveals')::int, p_default_cap)
    returning 1
  )
  select exists (select 1 from taken);
$$;
