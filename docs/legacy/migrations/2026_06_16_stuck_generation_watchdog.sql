-- Watchdog function: resets stuck draft generation
-- Call from the generate-drafts route or a cron every few minutes.
-- Marks 'generating' drafts older than N minutes as 'failed' (retry-able).
-- Resets campaigns stuck in 'processing' back to 'draft' when nothing is actively generating.

CREATE OR REPLACE FUNCTION public.reset_stuck_draft_generation(stale_minutes int DEFAULT 5)
RETURNS TABLE(reset_campaigns int, reset_drafts int)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_drafts int := 0;
  v_campaigns int := 0;
BEGIN
  -- 1. Mark stale 'generating' drafts as 'failed'
  WITH stuck AS (
    UPDATE email_drafts
    SET status = 'failed',
        updated_at = now()
    WHERE status = 'generating'
      AND created_at < now() - make_interval(mins := stale_minutes)
    RETURNING id
  )
  SELECT count(*) INTO v_drafts FROM stuck;

  -- 2. Reset campaigns stuck in 'processing' where no drafts are actively generating
  WITH stuck_campaigns AS (
    UPDATE campaigns c
    SET status = 'draft',
        updated_at = now()
    WHERE c.status = 'processing'
      AND NOT EXISTS (
        SELECT 1 FROM email_drafts d
        WHERE d.campaign_id = c.id
          AND d.status = 'generating'
      )
    RETURNING c.id
  )
  SELECT count(*) INTO v_campaigns FROM stuck_campaigns;

  reset_drafts := v_drafts;
  reset_campaigns := v_campaigns;
  RETURN NEXT;
END;
$$;
