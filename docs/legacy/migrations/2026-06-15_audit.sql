-- Audit log for tracking user actions
CREATE TABLE IF NOT EXISTS audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid,
  actor_email text,
  action      text NOT NULL,        -- 'campaign.create' | 'draft.approve' | 'lead.delete' | ...
  entity_type text NOT NULL,        -- 'campaign' | 'draft' | 'lead'
  entity_id   uuid,
  diff        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
