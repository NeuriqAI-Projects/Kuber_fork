-- Campaign-level follow-up defaults vs. a lead-specific override.
--
-- email_drafts.source already distinguished 'ai' (model-written) from
-- 'template' (safety-net fallback) — see 2026_08_27_email_drafts_source_and_attempts.sql.
-- Neither meant "a human edited this specific lead's copy by hand", so a bulk
-- "regenerate this step for every lead" run had no way to leave a manually
-- edited follow-up alone: it would silently overwrite whatever someone had
-- just typed in the Sequences tab's Lead pane. 'manual' closes that gap —
-- set by app/api/v1/campaigns/[id]/followup-save/route.ts on a human save,
-- and treated as protected (skipped, not overwritten) by
-- lib/services/regeneration-jobs.ts's bulk regenerate.
alter table email_drafts drop constraint if exists email_drafts_source_check;
alter table email_drafts add constraint email_drafts_source_check
  check (source in ('ai', 'template', 'manual'));

comment on column email_drafts.source is
  'ai = model-written. template = safety-net fallback, upgradeable until sent. manual = a human edited this lead''s copy by hand; bulk regeneration skips it.';
