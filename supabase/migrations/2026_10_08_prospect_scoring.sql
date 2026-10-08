-- Company-first prospecting: find companies, read them, score them 1–10 with
-- Jev, and reveal one contact only at companies that fit.
--
-- WHY SEPARATE TABLES, NOT `organizations`
-- An organizations row today means "we have a lead here": scrape-orgs marks an
-- org failed when it has no emailable lead (NO_EMAILED_LEADS), and the
-- one-lead-per-org rule reads it as "already covered". A scored-but-not-yet-
-- revealed company is neither, so it lives here until it is promoted, at which
-- point exactly one organizations row + one lead are created (company-import's
-- shape) and the normal reveal/scrape/draft pipeline takes over.
--
-- Nothing existing is altered.

create table if not exists prospect_searches (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references companies(id) on delete cascade,
  created_by     uuid,
  filters        jsonb not null,
  page           int  not null default 1,
  -- 'paying' is written BEFORE the Apollo call. A row left in 'paying' means
  -- the call may have been charged but its result never saved (timeout,
  -- killed function) — it is shown as "charge unknown", never silently lost.
  status         text not null default 'paying' check (status in ('paying', 'done', 'failed')),
  credits_spent  int  not null default 0,
  returned       int,
  new_companies  int,
  total_entries  int,
  error          text,
  mock           boolean not null default false,
  -- The leads batch promoted contacts join (Leads page filter / colour).
  import_id      uuid references imports(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_prospect_searches_company on prospect_searches (company_id, created_at desc);

create table if not exists prospect_companies (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references companies(id) on delete cascade,
  search_id         uuid not null references prospect_searches(id) on delete cascade,
  apollo_org_id     text not null,
  name              text not null,
  domain            text,
  website_url       text,
  linkedin_url      text,
  twitter_url       text,
  facebook_url      text,
  apollo_raw        jsonb,
  status            text not null default 'queued' check (status in (
                      'queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits',
                      'review', 'hidden', 'flagged', 'site_down', 'no_contact', 'promoted', 'rejected')),
  page_text         text,
  page_markdown     text,
  text_source       text,
  score             int check (score between 1 and 10),
  score_confidence  real,
  reason            text,
  extra_sources     text[] not null default '{}',
  jev_tokens        int not null default 0,
  auto_reveal       boolean not null default false,
  attempts          int not null default 0,
  last_error        text,
  -- Claim lock AND retry/backoff time: the worker only takes rows whose
  -- locked_until is null or in the past.
  locked_until      timestamptz,
  organization_id   uuid references organizations(id) on delete set null,
  contact_apollo_id text,
  decided_by        uuid,
  decided_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One row per Apollo company per client: re-running a search never
  -- re-reads or re-scores (= re-pays for) a company we already have.
  unique (company_id, apollo_org_id)
);
create index if not exists idx_prospect_companies_work   on prospect_companies (status, locked_until);
create index if not exists idx_prospect_companies_search on prospect_companies (company_id, search_id, status);

-- Atomic claim: lock up to p_limit workable rows in one statement.
-- SKIP LOCKED means two workers running at once never get the same row.
-- Per company, because each company's keys, fit rules and credits differ.
create or replace function public.claim_prospects(p_company uuid, p_limit int, p_lock_seconds int default 300)
returns setof prospect_companies
language sql
as $$
  update prospect_companies p
     set locked_until = now() + make_interval(secs => p_lock_seconds),
         updated_at   = now()
   where p.id in (
     select id from prospect_companies
      where company_id = p_company
        and status in ('queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits')
        and (locked_until is null or locked_until <= now())
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning p.*;
$$;

-- The client's fit rules + thresholds. Seeded empty-object so the code's
-- defaults apply until the client sends their own (parseFitScoring merges).
insert into public.settings (company_id, key, value)
select id, 'fit_scoring', '{}'
from public.companies
on conflict (company_id, key) do nothing;
