-- Every minute, advance prospects one stage each (read → score → reveal one
-- contact). Same helper as the draft-generation pump. The worker itself stops
-- starting new work after ~25 s, so it never meets the 60 s function limit.
select cron.schedule(
  'prospect-scoring-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/internal/score-prospects', 60000)$$
);
