-- Harden all custom functions by pinning search_path.
-- Prevents schema hijacking attacks (Supabase advisor warning).

ALTER FUNCTION public.compute_lead_status(uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_lead_status_self() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_org_sync_leads() SET search_path = public, pg_temp;
ALTER FUNCTION public.reset_stuck_draft_generation(int) SET search_path = public, pg_temp;
