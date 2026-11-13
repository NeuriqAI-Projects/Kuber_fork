-- Apollo gates use the same "out of credits" line as the app: under 5 (13 Nov 2026).
-- The enrich route refuses reveals below APOLLO_MIN_CREDITS (5), but the gates in
-- 2026_11_13_apollo_zero_gates.sql only held back at <= 0. With 1-4 credits left,
-- resume-apollo-reveal would wake Vercel every 5 min to be refused, and the scoring
-- pump would keep queueing reveals. lib/services/provider-credits.ts
-- apolloOutOfCredits and the 1-hour re-check now use "< 5" too.
-- Safe with the old prod code: when the gate opens after the hour, the old code
-- re-saves the balance and the gate shuts again (same as the <= 0 version).
-- Re-runnable: cron.schedule replaces a job with the same name. Commands copied
-- from cron.job on 13 Nov 2026; the only change is "<= 0" -> "< 5" (twice).
-- To revert: re-run 2026_11_13_apollo_zero_gates.sql.

select cron.schedule(
  'prospect-scoring-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/internal/score-prospects', 60000)
    where exists (
      select 1 from public.prospect_companies
      where status in ('queued', 'read_social', 'read', 'good', 'approved', 'waiting_credits')
        and (locked_until is null or locked_until <= now())
        and (status <> 'waiting_credits' or not coalesce((
          select (value::jsonb ->> 'remaining')::numeric < 5 and updated_at > now() - interval '1 hour'
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
      select (value::jsonb ->> 'remaining')::numeric < 5 and updated_at > now() - interval '1 hour'
      from public.system_state where key = 'credit_check_apollo'), false)
      and exists (
        select 1 from public.enrichment_logs
        where event = 'CREDITS_EXHAUSTED' and source = 'apollo'
          and created_at > now() - interval '1 hour'))$$
);
