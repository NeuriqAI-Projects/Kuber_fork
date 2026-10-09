-- Async campaign drafts migration (project: vrkzwsdlpkeapkcrfils)
-- Run in Supabase SQL editor

-- 1. Prevent duplicate active drafts per lead per campaign
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_drafts_campaign_lead
  ON email_drafts (campaign_id, lead_id)
  WHERE status NOT IN ('rejected', 'failed');

-- 2. Fast lookup: campaign leads awaiting draft / review
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign_draft
  ON campaign_leads (campaign_id, draft_id)
  WHERE draft_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_drafts_campaign_status
  ON email_drafts (campaign_id, status);

-- 3. Track when background generation started (UX)
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS draft_generation_started_at timestamptz;
