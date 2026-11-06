-- Stable order for the Leads list pages (6 Nov 2026).
--
-- GET /api/v1/leads pages through leads with ORDER BY created_at DESC, LIMIT/OFFSET.
-- An import inserts up to 100 leads with the same created_at, so without a
-- tie-breaker two pages can return the same lead and skip another (search "ra"
-- showed 1030 of 1031, "in" 2812 of 2840). The route now also orders by id DESC;
-- this index keeps that order a plain index scan (without it Postgres sorts the
-- joined rows and the page gets 4-8x slower). Additive, re-runnable.

create index if not exists idx_leads_company_active_created_id
  on public.leads (company_id, is_deleted, created_at desc, id desc);
