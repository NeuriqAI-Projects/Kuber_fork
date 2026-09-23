-- Model Lab: pick the writing model by reading the emails, not by benchmarking.
--
-- The shortlist of candidate models was produced by measuring cost, speed and
-- failures. What none of that measures is whether an email reads right to a
-- masterbatch buyer, and that judgement belongs to the client's sales team, not
-- to us. These three tables are what lets them make it inside the product.
--
-- Nothing here is ever sent. A lab email is written against a fixed bench of
-- enriched leads and stored here; it never becomes an email_drafts row, never
-- reaches Instantly, and never touches a campaign.

-- One saved combination of "what the model is told": the personal email
-- template, the drafting prompt, and whose settings scope they belong to.
-- Mirrors Settings > AI & Outreach exactly, because a wording tried here has to
-- be pasteable back there with no translation.
create table if not exists model_lab_prompt_sets (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  name         text not null,
  -- 'personal' = template + prompt (a user's writing style, which REPLACES the
  -- company default); 'company' = the company base prompt only.
  scope        text not null default 'personal' check (scope in ('personal', 'company')),
  template     text,
  prompt       text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_model_lab_prompt_sets_company on model_lab_prompt_sets (company_id, created_at desc);

-- One generated email. A comparison is several rows sharing a run_group.
create table if not exists model_lab_emails (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references companies(id) on delete cascade,
  run_group     uuid not null,
  lead_id       uuid not null references leads(id) on delete cascade,
  step_number   int  not null default 1,
  model         text not null,
  prompt_set_id uuid references model_lab_prompt_sets(id) on delete set null,
  -- Blind labels are assigned per run ("A", "B", "C") and kept, so reopening a
  -- finished comparison shows the same letters it was judged under.
  label         text,
  subject       text,
  body          text,
  duration_ms   int,
  cost_usd      numeric(12, 6),
  error         text,
  created_by    uuid,
  created_at    timestamptz not null default now()
);
create index if not exists idx_model_lab_emails_group   on model_lab_emails (run_group);
create index if not exists idx_model_lab_emails_company on model_lab_emails (company_id, created_at desc);

-- A human's verdict on one email. Best and worst are separate rows, so a run can
-- carry both, and one person can only hold one of each per run.
create table if not exists model_lab_votes (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  run_group  uuid not null,
  email_id   uuid not null references model_lab_emails(id) on delete cascade,
  verdict    text not null check (verdict in ('best', 'worst')),
  voted_by   uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_model_lab_vote_per_voter
  on model_lab_votes (run_group, verdict, voted_by);
create index if not exists idx_model_lab_votes_email on model_lab_votes (email_id);

-- The bench itself (which leads, which models are offered) is a settings row,
-- not a table: it is one short list per company that changes rarely, and a
-- table for it would be three more joins for no gain.
--   model_lab_bench_leads  -> JSON array of lead ids
--   model_lab_models       -> JSON array of model ids
