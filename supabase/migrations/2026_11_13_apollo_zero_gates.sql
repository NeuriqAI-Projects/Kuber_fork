-- Don't wake Vercel for Apollo work while Apollo is at 0 (13 Nov 2026).
-- 151 client prospects waiting for credits made prospect-scoring-pump call
-- Vercel 261 times a day (~80K Supabase calls: claim, credit read, lead count,
-- save, per prospect), and resume-apollo-reveal called it 288/288 times only to
-- log CREDITS_EXHAUSTED and re-read Apollo's balance.
--
-- "Apollo at 0" = system_state credit_check_apollo says remaining <= 0 and was
-- saved less than 1 hour ago. After that hour the gates open once; the app
-- re-reads Apollo (lib/services/provider-credits.ts APOLLO_EMPTY_RECHECK_MS,
-- same hour) and either resumes or saves 0 again, closing them for another hour.
-- A manual refresh (Settings > Keys > Usage > Apollo) saves the live balance, so
-- a top-up reopens them within a minute.
--
-- Reveal: also runs once the last CREDITS_EXHAUSTED row is an hour old, even
-- when the scoring pump just re-saved the 0: that row is what keeps the "Apollo
-- is out of credits" banner up (service-health reads 6 h back). That pass reads
-- the saved 0 (no Apollo call) and logs again.
-- ponytail: the log check is global, not per company; fine while only the client
-- waits for reveals (Dev's mock leads never do). Per company if two ever wait.
--
-- Scoring: only waiting_credits rows are held back; website reads and AI scoring
-- (queued / read_social / read / good / approved) and running searches still
-- flow. Same rule in lib/services/prospects/worker.ts companiesWithWork.
-- The select-list subquery runs only on the credit_check_apollo row, so the
-- ::jsonb cast never sees another key's value.
-- Re-runnable: cron.schedule replaces a job with the same name. Commands copied
-- from cron.job on 13 Nov 2026 (2026_11_05_cron_work_gates.sql); only the
-- Apollo condition is new. To revert: re-run 2026_11_05_cron_work_gates.sql's
-- two calls for these jobs.

select cron.schedule(
  'prospect-scoring-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/internal/score-prospects', 60000)
    where exists (
      select 1 from public.prospect_companies
      where status in ('queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits')
        and (locked_until is null or locked_until <= now())
        and (status <> 'waiting_credits' or not coalesce((
          select (value::jsonb ->> 'remaining')::numeric <= 0 and updated_at > now() - interval '1 hour'
          from public.system_state where key = 'credit_check_apollo'), false)))
    or exists (
      select 1 from public.prospect_searches where run_status = 'running')$$
);

select cron.schedule(
  'resume-apollo-reveal',
  '*/5 * * * *',
  $$select public.ping_internal_route('/api/internal/resume-apollo-reveal', 60000)
    where exists (
      select 1 from public.leads
      where lead_source = 'apollo'
        and has_email
        and not is_deleted
        and enrich_attempts < 2
        and email is null
        and import_id is not null)
    and not (coalesce((
      select (value::jsonb ->> 'remaining')::numeric <= 0 and updated_at > now() - interval '1 hour'
      from public.system_state where key = 'credit_check_apollo'), false)
      and exists (
        select 1 from public.enrichment_logs
        where event = 'CREDITS_EXHAUSTED' and source = 'apollo'
          and created_at > now() - interval '1 hour'))$$
);
