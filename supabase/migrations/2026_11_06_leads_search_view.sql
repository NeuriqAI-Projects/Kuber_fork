-- Leads search by company name without an id list in the URL (6 Nov 2026).
--
-- GET /api/v1/leads?q=... used to look up every organization whose name matched
-- and put all their ids into `organization_id.in.(...)`. A short query like "ra"
-- matches 500-950 orgs, the URL got too long, PostgREST rejected it and the page
-- showed "No matches". This view carries the org name next to each lead, so the
-- search filters `org_name` in the same query.
--
-- `l.*` is expanded when the view is created: a column added to `leads` later
-- does not appear here until this file is re-run. Re-runnable.

create or replace view public.leads_search with (security_invoker = true) as
  select l.*, o.name as org_name
    from public.leads l
    left join public.organizations o on o.id = l.organization_id;

revoke all on public.leads_search from public, anon, authenticated;
grant select on public.leads_search to service_role;
