-- Per-admin email signatures
-- One row per admin user — used by resolveCampaignSignature()
CREATE TABLE IF NOT EXISTS user_signatures (
  user_id     uuid PRIMARY KEY,
  full_name   text NOT NULL,
  title       text,
  contact     text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz
);

-- Which admin signs a campaign's drafts (defaults to created_by)
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS signature_user_id uuid;
