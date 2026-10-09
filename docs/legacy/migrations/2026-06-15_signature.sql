-- Email signature support
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS signature_override text;

INSERT INTO settings (key, value) VALUES
  ('email_signature', E'Best regards,\nKuber Polyplast\n+91-XXXXXXXXXX')
ON CONFLICT (key) DO NOTHING;
