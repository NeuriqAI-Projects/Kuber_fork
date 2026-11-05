-- Security lockdown (5 Nov 2026, cost review supabase-db-14).
--
-- 1. Twelve one-off backup/tmp tables in public had no RLS, so anyone with the
--    public anon key could read them (copies of drafts, replies, lead events).
--    Nothing in the app uses them. A copy was saved first to
--    logs/notes/db-backup-2026-11-05/ (outside the repo).
-- 2. SECURITY DEFINER functions were executable by anon/authenticated (through
--    PUBLIC), including provider_key_read_secret, which returns a decrypted
--    API key from Vault. Every caller is server code using the service role
--    (createAdminClient / dbForUser), so only service_role keeps EXECUTE.
--    provider_keys_delete_vault_secret is a trigger function; triggers fire
--    regardless of EXECUTE, so the revoke does not affect key deletion.
-- Re-runnable.

drop table if exists
  public.backup_20260817_campaign_leads,
  public.backup_20260817_email_drafts,
  public.backup_20260817_lead_events,
  public.backup_20260817_reply_drafts,
  public.backup_20260817_reply_events,
  public.backup_20260817_unibox_emails,
  public.backup_20260827_campaign_steps,
  public.tmp_f,
  public.tmp_q,
  public.tmp_q2,
  public.tmp_regen_baseline,
  public.tmp_rounds;

revoke execute on function public.claim_queued_orgs(integer) from public, anon, authenticated;
revoke execute on function public.claim_unenriched_leads(uuid[]) from public, anon, authenticated;
revoke execute on function public.provider_key_create_secret(text, text) from public, anon, authenticated;
revoke execute on function public.provider_key_delete_secret(uuid) from public, anon, authenticated;
revoke execute on function public.provider_key_read_secret(uuid) from public, anon, authenticated;
revoke execute on function public.provider_keys_delete_vault_secret() from public, anon, authenticated;

grant execute on function public.claim_queued_orgs(integer) to service_role;
grant execute on function public.claim_unenriched_leads(uuid[]) to service_role;
grant execute on function public.provider_key_create_secret(text, text) to service_role;
grant execute on function public.provider_key_delete_secret(uuid) to service_role;
grant execute on function public.provider_key_read_secret(uuid) to service_role;
grant execute on function public.provider_keys_delete_vault_secret() to service_role;
