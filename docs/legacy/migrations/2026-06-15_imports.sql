-- imports table + lead linkage (List/batch tagging)
CREATE TABLE IF NOT EXISTS imports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text NOT NULL,
  source      text NOT NULL,  -- 'apollo' | 'excel' | 'manual'
  lead_count  integer NOT NULL DEFAULT 0,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_id uuid REFERENCES imports(id);
CREATE INDEX IF NOT EXISTS leads_import_id_idx ON leads (import_id);
CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at);
