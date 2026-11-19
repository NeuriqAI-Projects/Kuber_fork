-- Up to 5 files per campaign and per campaign lead (was 1), 25 MB each (was 10 MB).
-- Run BEFORE the code deploys: the new code reads and writes `attachments`.
--
-- `attachments` = [{ "path", "name", "mime", "size" }]. The old single
-- attachment_* columns are no longer read or written; drop them later.

alter table public.campaigns
  add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.campaign_leads
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- Carry the existing single file over.
update public.campaigns
   set attachments = jsonb_build_array(jsonb_build_object(
         'path', attachment_path, 'name', attachment_name,
         'mime', coalesce(attachment_mime, ''), 'size', coalesce(attachment_size, 0)))
 where attachment_path is not null and attachment_name is not null and attachments = '[]'::jsonb;

update public.campaign_leads
   set attachments = jsonb_build_array(jsonb_build_object(
         'path', attachment_path, 'name', attachment_name,
         'mime', coalesce(attachment_mime, ''), 'size', coalesce(attachment_size, 0)))
 where attachment_path is not null and attachment_name is not null and attachments = '[]'::jsonb;

-- 25 MB per file (Supabase Free allows up to 50 MB).
update storage.buckets set file_size_limit = 26214400 where id = 'campaign-attachments';
