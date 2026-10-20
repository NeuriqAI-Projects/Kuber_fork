-- Kuber AI assistant (19 Oct 2026)
--
-- 1. llm_usage.user_id — who caused an AI call. Filled for assistant turns, so
--    Credits > AI can show "who used how much". Nullable: background work
--    (drafts, follow-ups, enrichment) has no single person behind it.
-- 2. assistant_threads — saved chats, one row per chat, messages as JSON.
--
-- Safe to run twice. The app works before this runs (no history, no per-person
-- usage) and picks both up as soon as it has run.

alter table public.llm_usage add column if not exists user_id uuid;

create index if not exists llm_usage_company_user_created_idx
  on public.llm_usage (company_id, user_id, created_at desc)
  where user_id is not null;

create table if not exists public.assistant_threads (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  user_id       uuid not null,
  title         text not null default 'New chat',
  messages      jsonb not null default '[]'::jsonb,
  message_count int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists assistant_threads_user_updated_idx
  on public.assistant_threads (company_id, user_id, updated_at desc);

-- Same model as every other table (2026_07_14_enable_rls.sql): RLS on with no
-- policies. The app reads through the service role, which bypasses RLS; the
-- public anon key can read nothing.
alter table public.assistant_threads enable row level security;
