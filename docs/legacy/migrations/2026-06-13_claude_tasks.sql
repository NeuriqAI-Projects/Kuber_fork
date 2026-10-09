-- CLAUDE.md task backlog migrations (project: vrkzwsdlpkeapkcrfils)

-- 1. Campaign fields
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS ai_prompt_context text,
  ADD COLUMN IF NOT EXISTS sender_name text;

-- 2. Draft version history
ALTER TABLE email_drafts
  ADD COLUMN IF NOT EXISTS version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS parent_draft_id uuid REFERENCES email_drafts(id);

-- 3. Settings table
CREATE TABLE IF NOT EXISTS settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value text,
  updated_at timestamptz DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('default_sender_name', 'Kuber Polyplast'),
  ('system_prompt', 'You are writing outbound sales emails on behalf of Kuber Polyplast, a masterbatch and specialty plastics manufacturer based in New Delhi, India that exports to 50+ countries. Write personalized, professional B2B emails. Keep them concise (under 200 words). Do not mention pricing. Focus on understanding their needs. Return ONLY valid JSON with no markdown fences: {"subject": string, "body": string}. The body field is the full email text.'),
  ('client_industry', 'Plastics & Polymer Manufacturing'),
  ('client_products', 'Masterbatch, Color Concentrates, White Masterbatch, Black Masterbatch, Additive Masterbatch, Filler Masterbatch'),
  ('client_target_markets', 'Packaging, Automotive, Agriculture, Consumer Goods')
ON CONFLICT (key) DO NOTHING;
