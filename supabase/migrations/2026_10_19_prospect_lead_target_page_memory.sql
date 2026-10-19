-- Scored searches: "how many leads do you want" + page memory (19 Oct 2026).
-- A search now keeps reading Apollo pages (100 companies each) until it has the
-- leads asked for, hits the credit limit, or the keywords run out. Page memory
-- remembers the last page read per company + filter set, so the next search
-- with the same filters starts on the next page instead of paying for page 1 again.
-- Safe to run more than once.

alter table public.prospect_searches
  add column if not exists target_leads int,
  add column if not exists max_credits int,
  add column if not exists filter_key text,
  add column if not exists pages int[] not null default '{}',
  add column if not exists run_status text not null default 'complete',
  add column if not exists run_note text,
  add column if not exists run_locked_until timestamptz;

alter table public.prospect_companies add column if not exists page int;

create table if not exists public.prospect_page_memory (
  company_id  uuid not null references public.companies(id) on delete cascade,
  filter_key  text not null,
  last_page   int  not null default 0,
  total_pages int,
  updated_at  timestamptz not null default now(),
  primary key (company_id, filter_key)
);
alter table public.prospect_page_memory enable row level security;

-- Take the next page for this filter set, atomically (two searches at once never get the same page).
create or replace function public.claim_prospect_page(p_company uuid, p_key text)
returns int language sql set search_path = public as $$
  insert into public.prospect_page_memory (company_id, filter_key, last_page)
  values (p_company, p_key, 1)
  on conflict (company_id, filter_key)
  do update set last_page = public.prospect_page_memory.last_page + 1, updated_at = now()
  returning last_page;
$$;
-- Server only: the browser keys must not move another company's page memory.
revoke execute on function public.claim_prospect_page(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_prospect_page(uuid, text) to service_role;
