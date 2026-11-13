-- 13 Nov 2026 (agent "credits"). RUN AT DEPLOY TIME, after the app code that shows these rows
-- (LONG_WAIT in lib/services/prospects/groups.ts, liveRunNote waitedOut) is live, and after
-- 2026_11_13_credit_bookings_long_wait.sql. Re-runnable.
--
-- Effect: every company waiting for Apollo credits more than 2 days moves to Needs review
-- (status 'review'). On 13 Nov 2026 that is the client's 151 companies from 7 Nov, moved by the
-- first run of the job (within the hour) or at once by the last line below.

-- 1. Back-fill waiting_since for rows that were already waiting before the trigger existed.
--    Best evidence: a row cannot have started waiting before it was created (or approved).
--    The client's 151 were created 7 Nov 10:01-11:37 UTC; Apollo first logged
--    CREDITS_EXHAUSTED at 11:31 UTC that day. Only waiting_since changes (status untouched).
update public.prospect_companies
   set waiting_since = greatest(created_at, coalesce(decided_at, created_at))
 where status = 'waiting_credits'
   and waiting_since is null;

-- 2. The rule, hourly, SQL only (no Vercel call): works while the Apollo gates keep the scoring pump asleep.
select cron.schedule(
  'prospect-long-wait-review',
  '25 * * * *',
  $$select public.review_long_waits()$$
);

-- 3. Optional: move them now instead of at minute 25. Returns how many moved.
select public.review_long_waits();
