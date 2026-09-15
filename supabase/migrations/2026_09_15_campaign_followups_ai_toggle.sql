-- Migration: 2026_09_15_campaign_followups_ai_toggle
-- One switch per campaign: false = follow-ups use each step's default text with
-- the lead's name and company filled in, and no AI call is made for them.
-- Defaults to true so every existing campaign keeps AI-written follow-ups.

ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS followups_ai_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.campaigns.followups_ai_enabled IS
  'false = follow-ups are the campaign step default text (name/company filled), never AI-written';
