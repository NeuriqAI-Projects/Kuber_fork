-- Unstick "Plastic outreach" campaign that was stuck in processing
-- because fetchDraftTargets was throwing on dropped columns.
-- One-time fix — safe to re-run.
UPDATE campaigns
SET status = 'draft',
    updated_at = now()
WHERE status = 'processing'
  AND updated_at < now() - interval '10 minutes';
