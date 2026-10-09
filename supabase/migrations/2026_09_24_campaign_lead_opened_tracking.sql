-- Whether/when a lead opened one of our emails — the Instantly webhook has
-- handled the `email_opened` event since it was first written (see
-- LEAD_EVENT_BY_INSTANTLY_EVENT in app/api/v1/webhooks/instantly/route.ts),
-- logging it to the lead's activity timeline, but nothing made it queryable:
-- no column recorded it, and no list view showed it. This is that column,
-- populated by the webhook the same way first_sent_at/last_reply_at already
-- are — first occurrence only, never overwritten by a later open, matching
-- Instantly's own `is_first` flag on the event.
alter table campaign_leads
  add column if not exists opened_at   timestamptz,
  add column if not exists opened_step integer;

comment on column campaign_leads.opened_at is
  'When this lead first opened one of our emails in this campaign, per Instantly''s email_opened webhook. Null = not opened (or open tracking is off for this campaign).';
comment on column campaign_leads.opened_step is
  'Which sequence step (1 = opening email, 2+ = follow-up) was open when opened_at was recorded.';

create index if not exists idx_campaign_leads_opened_at
  on campaign_leads (campaign_id, opened_at)
  where opened_at is not null;
