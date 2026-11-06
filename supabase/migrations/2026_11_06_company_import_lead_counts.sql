-- Real lead counts per import for the Leads > Filters > Batch list and the
-- Dashboard batch list (6 Nov 2026).
--
-- imports.lead_count is written once when an import is created. A scored-company
-- search creates its import with lead_count 0 and adds leads later, so 102 Dev
-- batches showed "(0)" while holding leads, and others drifted (14th_July_3 said
-- 1403, 1398 are visible). Same predicate as GET /api/v1/leads: not deleted,
-- email revealed. Additive, re-runnable.
create or replace function public.company_import_lead_counts(p_company uuid)
returns table (import_id uuid, lead_count bigint)
language sql
stable
set search_path = public
as $$
  select l.import_id, count(*)
    from public.leads l
   where l.company_id = p_company
     and l.is_deleted = false
     and l.email is not null
     and l.import_id is not null
   group by l.import_id;
$$;

revoke execute on function public.company_import_lead_counts(uuid) from public, anon, authenticated;
grant execute on function public.company_import_lead_counts(uuid) to service_role;
