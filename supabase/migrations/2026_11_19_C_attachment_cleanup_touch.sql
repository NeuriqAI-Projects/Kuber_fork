-- Cleanup: judge "new" by the last write, not the first. Re-runnable.
-- Run AFTER the code with the upsert-on-reuse change is live (harmless before).
-- Picking a stored file that is older than 12 h re-uploads it over itself, which
-- bumps storage.objects.updated_at; this keeps such a file for a day even if
-- nothing points at it yet (a Create Campaign modal still open).
-- Same function as 2026_11_19_B_attachment_cleanup_cron.sql, one line changed.

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
     and coalesce(o.updated_at, o.created_at) < now() - interval '1 day'
     and not exists (select 1 from used where used.name = o.name)
   order by o.created_at
   limit p_limit;
$$;

revoke all on function public.attachment_cleanup_candidates(integer) from public, anon, authenticated;
grant execute on function public.attachment_cleanup_candidates(integer) to service_role;
