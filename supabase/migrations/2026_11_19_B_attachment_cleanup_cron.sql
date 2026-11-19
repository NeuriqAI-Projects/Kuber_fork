-- Daily cleanup of the campaign-attachments bucket. Re-runnable.
-- Run AFTER the code with /api/internal/cleanup-attachments is live (the cron pings it).
--
-- A file is KEPT when any of these is true; everything else under uploads/ or
-- campaign-leads/ is deleted by the route (branding/ = logos, never touched):
--   * uploaded less than 1 day ago (an upload still in progress / a modal still open)
--   * it is a file of a live campaign (not deleted, not completed) or of one of its leads
--   * its link is in a live campaign's step, in company/user settings, or in an
--     unsent reply draft
--   * its link is in an email written, sent or received in the last 60 days
-- So: abandoned uploads go after 1 day; files of deleted/completed campaigns go
-- once no mail used them for 60 days. On 19 Nov 2026 the first run removes 46
-- of 76 files (67.5 MB): 19 never used, 14 of deleted campaigns, 13 old reply files.
--
-- Storage rows cannot be deleted with SQL (Supabase blocks it), so this only
-- LISTS the files; the route removes them through the Storage API.

create or replace function public.attachment_cleanup_candidates(p_limit integer default 200)
returns setof text
language sql
stable
security definer
set search_path = public, storage, pg_temp
as $$
  with re as (select 'campaign-attachments/((?:uploads|campaign-leads)/[A-Za-z0-9._/-]+)'::text p),
  active as (select id from public.campaigns where not is_deleted and status is distinct from 'completed'),
  used(name) as (
    select f->>'path' from public.campaigns c, jsonb_array_elements(c.attachments) f where c.id in (select id from active)
    union select f->>'path' from public.campaign_leads cl, jsonb_array_elements(cl.attachments) f where cl.campaign_id in (select id from active)
    union select m[1] from public.campaign_steps s, re, regexp_matches(s::text, re.p, 'g') m where s.campaign_id in (select id from active)
    union select m[1] from public.settings s, re, regexp_matches(s::text, re.p, 'g') m
    union select m[1] from public.user_settings s, re, regexp_matches(s::text, re.p, 'g') m
    union select m[1] from public.reply_drafts r, re, regexp_matches(r::text, re.p, 'g') m
      where r.sent_at is null or r.sent_at > now() - interval '60 days'
    union select m[1] from public.email_drafts d, re, regexp_matches(coalesce(d.body, ''), re.p, 'g') m
      where d.updated_at > now() - interval '60 days'
    union select m[1] from public.unibox_emails u, re, regexp_matches(coalesce(u.body_html, ''), re.p, 'g') m
      where coalesce(u.timestamp_email, u.created_at) > now() - interval '60 days'
    union select m[1] from public.reply_events e, re, regexp_matches(coalesce(e.reply_body, ''), re.p, 'g') m
      where e.received_at > now() - interval '60 days'
    union select m[1] from public.campaign_leads cl, re, regexp_matches(coalesce(cl.last_reply_body, ''), re.p, 'g') m
      where cl.last_reply_at > now() - interval '60 days'
  )
  select o.name from storage.objects o
   where o.bucket_id = 'campaign-attachments'
     and (o.name like 'uploads/%' or o.name like 'campaign-leads/%')
     and o.created_at < now() - interval '1 day'
     and not exists (select 1 from used where used.name = o.name)
   order by o.created_at
   limit p_limit;
$$;

revoke all on function public.attachment_cleanup_candidates(integer) from public, anon, authenticated;
grant execute on function public.attachment_cleanup_candidates(integer) to service_role;

-- 03:15 UTC daily (quiet hours for India).
select cron.schedule(
  'attachment-cleanup',
  '15 3 * * *',
  $$select public.ping_internal_route('/api/internal/cleanup-attachments', 60000)$$
);
