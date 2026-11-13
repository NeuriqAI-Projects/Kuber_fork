-- 13 Nov 2026 (agent "credits"). Additive and re-runnable. Applied now; changes no row.
--
-- 1. prospect_credit_bookings(company, mock): per search that can still spend Apollo
--    credits (run_status 'running', or with rows still workable, e.g. waiting_credits),
--    the numbers lib/services/prospects/digging.ts `bookedCredits` needs. The search
--    start (search.ts) and the size check (estimate route) subtract the total from the
--    Apollo balance. On 7 Nov 2026 five searches each passed the check alone and
--    together ran Apollo to 0 (151 good fits left waiting_credits).
-- 2. prospect_companies.waiting_since: when the row entered waiting_credits. Set and
--    cleared by a trigger on every status change (updated_at is no use: every claim
--    and park touches it). Existing waiting rows are back-filled at DEPLOY time by
--    2026_11_13_long_wait_review_cron.sql, together with the job that uses it.
-- 3. review_long_waits(company?): moves rows waiting for Apollo credits more than
--    2 days to 'review' (Needs review). No credit is spent. Not scheduled here.

-- 1 ───────────────────────────────────────────────────────────────────────────
create or replace function public.prospect_credit_bookings(p_company uuid, p_mock boolean)
returns table (
  search_id uuid, running boolean, max_credits int, used int, pages_read int,
  max_auto_reveals int, auto_reveals_used int, pending_auto int, pending_approved int
)
language sql stable
as $$
  select s.id,
         s.run_status = 'running',
         s.max_credits,
         -- Same count continueRun uses: pages read + contacts promoted (approvals included).
         coalesce(cardinality(s.pages), 0) + w.promoted,
         coalesce(cardinality(s.pages), 0),
         (s.filters ->> 'max_auto_reveals')::int,
         s.auto_reveals_used,
         w.pending_auto,
         w.pending_approved
    from public.prospect_searches s
    cross join lateral (
      select count(*) filter (where p.status = 'promoted')::int as promoted,
             -- Could still get an automatic reveal (bounded by the search's reveal cap).
             count(*) filter (where p.status in ('queued', 'read_social', 'read', 'good', 'waiting_credits')
                                and p.decided_by is null)::int as pending_auto,
             -- Approved by the client: 1 credit each, outside the search's limit.
             count(*) filter (where p.status = 'approved'
                                 or (p.status in ('good', 'waiting_credits') and p.decided_by is not null))::int as pending_approved
        from public.prospect_companies p
       where p.company_id = s.company_id and p.search_id = s.id
    ) w
   where s.company_id = p_company
     and s.mock = p_mock
     and (s.run_status = 'running' or exists (
       select 1 from public.prospect_companies p
        where p.company_id = s.company_id and p.search_id = s.id
          and p.status in ('queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits')));
$$;
revoke execute on function public.prospect_credit_bookings(uuid, boolean) from public, anon, authenticated;
grant execute on function public.prospect_credit_bookings(uuid, boolean) to service_role;

-- 2 ───────────────────────────────────────────────────────────────────────────
alter table public.prospect_companies add column if not exists waiting_since timestamptz;

create or replace function public.prospect_waiting_since()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'waiting_credits' then
    -- Entering the wait (also after an approval or an undo) starts the 2-day clock again.
    if old.status is distinct from 'waiting_credits' or new.waiting_since is null then
      new.waiting_since := now();
    end if;
  else
    new.waiting_since := null;
  end if;
  return new;
end;
$$;

drop trigger if exists prospect_companies_waiting_since on public.prospect_companies;
create trigger prospect_companies_waiting_since
  before update of status on public.prospect_companies
  for each row execute function public.prospect_waiting_since();

-- 3 ───────────────────────────────────────────────────────────────────────────
-- The text starts with LONG_WAIT in lib/services/prospects/groups.ts (keep them equal).
-- ponytail: no lock check — a worker mid-stage on the same row (seconds) may save it back to
-- waiting_credits (2 more days) or promoted (credits came back); both are safe, no credit is lost.
create or replace function public.review_long_waits(p_company uuid default null)
returns integer
language sql
as $$
  with moved as (
    update public.prospect_companies
       set status = 'review',
           last_error = 'Waited 2 days for Apollo credits — approve to get the contact once credits are back',
           attempts = 0,
           locked_until = null,
           updated_at = now()
     where status = 'waiting_credits'
       and waiting_since < now() - interval '2 days'
       and (p_company is null or company_id = p_company)
    returning 1
  )
  select count(*)::int from moved;
$$;
revoke execute on function public.review_long_waits(uuid) from public, anon, authenticated;
grant execute on function public.review_long_waits(uuid) to service_role;
