-- Skip AI pumps for a company whose AI keys are all down (13 Nov 2026).
-- 6-12 Nov: the client's only active Anthropic key ran out of credit (status
-- 'dead'), 190 leads were waiting, and draft-generation-pump passed its gate
-- every minute: 1,438 Vercel calls a day that the route then refused
-- (canDraftOpenings false). See logs/reports/perf-fixes-2026-11-13/LLMKEY.md.
--
-- company_llm_keys_all_down(company) is TRUE only when the company HAS at least
-- one active LLM key row and NONE of them is usable the way getActiveKey picks
-- one (healthy, or cooling_off whose cooling_off_until has passed). A company
-- with no active LLM rows at all is NOT "down": it may run on an env-var key
-- (ENV_KEY_VARS), which SQL cannot see, so its pumps keep today's behaviour.
-- LLM provider = anything not in SERVICE_PROVIDER_IDS (lib/services/providers/registry.ts),
-- the same rule hasUsableLlmKey uses.
--
-- The gates are deliberately looser than the routes (route = main model only,
-- gate = any key), so a gate can only skip calls the route would have refused.
-- [TEST] campaigns on the Dev company run on fake AI, so they are never gated.
-- Re-check / save / add of a key kicks the work at once (kickLlmWork), so no
-- minute is lost when a key comes back.
--
-- followup-pump is NOT gated: with no AI key the writer still writes template
-- follow-ups and publishes the sequence, which is real progress, and the pump
-- stops by itself once sequence_publish_pending clears.
--
-- Re-runnable: create or replace + cron.schedule replaces a job of the same name.
-- To revert: re-run the two cron.schedule calls from 2026_11_05_cron_work_gates.sql.

create or replace function public.company_llm_keys_all_down(p_company uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
           select 1 from public.provider_keys k
           where k.company_id = p_company and k.is_active
             and k.provider not in ('apollo', 'instantly', 'firecrawl', 'jev', 'tavily'))
     and not exists (
           select 1 from public.provider_keys k
           where k.company_id = p_company and k.is_active
             and k.provider not in ('apollo', 'instantly', 'firecrawl', 'jev', 'tavily')
             and (k.status = 'healthy'
                  or (k.status = 'cooling_off' and k.cooling_off_until <= now())))
$$;

-- Only pg_cron (postgres) needs it; keep it off the public REST API.
revoke all on function public.company_llm_keys_all_down(uuid) from public, anon, authenticated;

select cron.schedule(
  'draft-generation-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/generate-drafts', 60000)
    where exists (
      select 1 from public.campaign_leads cl
      join public.campaigns c on c.id = cl.campaign_id
      join public.leads l on l.id = cl.lead_id
      where c.status in ('draft', 'processing', 'active')
        and not c.is_deleted
        and c.draft_generation_started_at is not null
        and cl.draft_id is null
        and cl.crm_status in ('new', 'enriched', 'draft')
        and l.email is not null
        and (not public.company_llm_keys_all_down(c.company_id)
             or (c.company_id = '00000000-0000-0000-0000-00000000000a' and c.name ~* '^\s*\[TEST\]')))$$
);

-- A job needs no AI when it is a follow-up step on a campaign with AI
-- follow-ups switched off (regenerate-drafts aiOff), or a Dev [TEST] campaign.
select cron.schedule(
  'regeneration-pump',
  '* * * * *',
  $$select public.ping_internal_route('/api/enrich/regenerate-drafts', 60000)
    where exists (
      select 1 from public.draft_regeneration_jobs j
      where j.status in ('queued', 'running')
        and (j.heartbeat_at is null or j.heartbeat_at < now() - interval '1 minute')
        and (not public.company_llm_keys_all_down(j.company_id)
             or exists (
               select 1 from public.campaigns c
               where c.id = j.campaign_id
                 and ((coalesce(j.step_number, 1) > 1 and c.followups_ai_enabled = false)
                      or (c.company_id = '00000000-0000-0000-0000-00000000000a' and c.name ~* '^\s*\[TEST\]')))))$$
);
