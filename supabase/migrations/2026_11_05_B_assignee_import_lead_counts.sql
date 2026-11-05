-- enrichment-leads-import-04 (5 Nov 2026): GET /api/v1/imports for an employee
-- ran one exact count per import (63 sequential queries for the client today).
-- One grouped count instead. Same predicate as lib/server/imports.ts:
-- assigned to this employee, not deleted, email revealed (onlyRevealedLeads).
-- The caller joins the result to its company-scoped imports list, so only the
-- caller's own company's imports ever show. Additive, re-runnable.
create or replace function public.assignee_import_lead_counts(p_assignee uuid)
returns table (import_id uuid, lead_count bigint)
language sql
stable
set search_path = public
as $$
  select l.import_id, count(*)
    from public.leads l
   where l.assigned_to = p_assignee
     and l.is_deleted = false
     and l.email is not null
     and l.import_id is not null
   group by l.import_id;
$$;

revoke execute on function public.assignee_import_lead_counts(uuid) from public, anon, authenticated;
grant execute on function public.assignee_import_lead_counts(uuid) to service_role;
