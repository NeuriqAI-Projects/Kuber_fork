-- NOTE (24 Sep 2026): checked against live data before merging — 673 Anthropic
-- rows carry a cost and NONE has any cache tokens, because prompt caching is
-- not switched on. This backfill therefore updates zero rows today. Kept for
-- when caching is enabled; the cost overstatement it describes is not what
-- happened to the existing figures.
--
-- One-time backfill: recompute cost_usd for existing Anthropic llm_usage rows
-- using the real cache-token multipliers (cache write 1.25x, cache read 0.1x
-- of the input rate — Anthropic's published prompt-caching pricing), instead
-- of the old code's fold-in at the full input rate for every cache token.
--
-- That old behavior visibly overstated cost: a campaign that reuses the same
-- system prompt/product list across many calls does almost all of its input
-- through the cache after the first call, and billing those reads at 1x
-- instead of 0.1x can be most of a campaign's reported total. See
-- lib/services/llm-pricing.ts's costOf() for the corrected formula this
-- backfill matches exactly, using each row's own already-stored token counts
-- — not an estimate.
--
-- Scope, deliberately narrow:
--   - provider = 'anthropic' only. Every other provider's cost_usd is either
--     provider-supplied (OpenRouter) or was never inflated by this bug (no
--     cache-token multiplier applies to them), so touching them would risk
--     changing a number that was already correct.
--   - cost_usd is not null. A null row means the model was unpriced at call
--     time — it stays null; this backfill only corrects rows that already
--     had a known cost, never manufactures one where there wasn't one.
--   - cache_write_tokens > 0 or cache_read_tokens > 0. A row with no cache
--     tokens is unaffected by this bug — new cost_usd would equal the old
--     one — so it's left untouched rather than rewritten for no reason.
--
-- Anthropic model price table (USD per million tokens), copied from the
-- PRICES table in lib/services/llm-pricing.ts — keep both in sync if that
-- table changes. Matching is prefix-based with longest-prefix-wins, same
-- tie-break as that file's lookup(), so a dated snapshot id
-- (claude-sonnet-4-6-20260115) still resolves to the right row.
with prices(prefix, input_per_million, output_per_million) as (
  values
    ('claude-fable-5',    10::numeric, 50::numeric),
    ('claude-mythos-5',   10::numeric, 50::numeric),
    ('claude-opus-5',      5::numeric, 25::numeric),
    ('claude-opus-4-8',    5::numeric, 25::numeric),
    ('claude-opus-4-7',    5::numeric, 25::numeric),
    ('claude-opus-4-6',    5::numeric, 25::numeric),
    ('claude-sonnet-5',    2::numeric, 10::numeric),
    ('claude-sonnet-4-6',  3::numeric, 15::numeric),
    ('claude-haiku-4-5',   1::numeric,  5::numeric)
),
-- One matched price per row, picking the longest (most specific) prefix —
-- e.g. claude-opus-4-8 must win over the shorter claude-opus-5 prefix... no
-- shorter prefix actually collides in this table today, but the tie-break is
-- kept so this stays correct if a future price entry does collide.
matched as (
  select
    u.id,
    p.input_per_million,
    p.output_per_million,
    row_number() over (
      partition by u.id
      order by length(p.prefix) desc
    ) as rn
  from llm_usage u
  join prices p
    on lower(u.model) like (lower(p.prefix) || '%')
  where u.provider = 'anthropic'
    and u.cost_usd is not null
    and (coalesce(u.cache_write_tokens, 0) > 0 or coalesce(u.cache_read_tokens, 0) > 0)
)
update llm_usage
set cost_usd = round(
  (
    (
      -- coalesce on every term: the WHERE admits a row with only ONE cache
      -- column set, and in SQL NULL * 1.25 is NULL, which would have
      -- overwritten a known cost with nothing for exactly those rows.
      coalesce(llm_usage.input_tokens, 0)
      + coalesce(llm_usage.cache_write_tokens, 0) * 1.25
      + coalesce(llm_usage.cache_read_tokens, 0) * 0.1
    ) / 1000000.0
  ) * matched.input_per_million
  +
  (coalesce(llm_usage.output_tokens, 0) / 1000000.0) * matched.output_per_million
, 6)
from matched
where matched.id = llm_usage.id
  and matched.rn = 1;
