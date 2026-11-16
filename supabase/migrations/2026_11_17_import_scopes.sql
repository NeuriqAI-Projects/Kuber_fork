-- Split the one "Leads · Import" box into one box per Add-leads source (17 Nov 2026):
--   imports:apollo   Apollo search (+ email reveal)
--   imports:company  Company lookup
--   imports:excel    Excel / CSV
--   imports:manual   Manual entry (+ "Add as lead" from a reply)
-- Without leads:assign, whatever a member imports is assigned to them.
--
-- Run BEFORE the code that uses the new boxes. Safe to re-run. Drops nothing.

-- 1. The full list, same order as SCOPES in lib/auth/scopes.ts (leads:import removed).
create or replace function public.kuber_scopes_valid(p_scopes text[])
returns boolean language sql immutable set search_path = '' as $$
  select p_scopes is not null
     and p_scopes <@ array[
       'dashboard:read', 'dashboard:all',
       'leads:read', 'leads:all', 'leads:write', 'leads:assign', 'leads:delete',
       'imports:apollo', 'imports:company', 'imports:excel', 'imports:manual',
       'organizations:read', 'organizations:write',
       'prospects:read', 'prospects:run',
       'campaigns:read', 'campaigns:all', 'campaigns:write', 'campaigns:generate', 'campaigns:assign', 'campaigns:send', 'campaigns:delete',
       'unibox:read', 'unibox:all', 'unibox:reply', 'unibox:write',
       'model_lab:read', 'model_lab:write',
       'credits:read',
       'assistant:use', 'assistant:actions', 'assistant:admin',
       'settings:write',
       'knowledge:write',
       'keys:read', 'keys:write', 'sending_accounts:write',
       'team:read', 'team:write'
     ]::text[]
$$;
revoke all on function public.kuber_scopes_valid(text[]) from public, anon, authenticated;
grant execute on function public.kuber_scopes_valid(text[]) to service_role;

-- 2. Whoever had the old Import box gets all four new ones (same access as before),
--    kept in SCOPES order. Only rows that still hold leads:import change.
update public.profiles p
   set scopes = (
     select array_agg(s order by ord)
       from unnest(array[
         'dashboard:read', 'dashboard:all',
         'leads:read', 'leads:all', 'leads:write', 'leads:assign', 'leads:delete',
         'imports:apollo', 'imports:company', 'imports:excel', 'imports:manual',
         'organizations:read', 'organizations:write',
         'prospects:read', 'prospects:run',
         'campaigns:read', 'campaigns:all', 'campaigns:write', 'campaigns:generate', 'campaigns:assign', 'campaigns:send', 'campaigns:delete',
         'unibox:read', 'unibox:all', 'unibox:reply', 'unibox:write',
         'model_lab:read', 'model_lab:write',
         'credits:read',
         'assistant:use', 'assistant:actions', 'assistant:admin',
         'settings:write',
         'knowledge:write',
         'keys:read', 'keys:write', 'sending_accounts:write',
         'team:read', 'team:write'
       ]::text[]) with ordinality as t(s, ord)
      where s = any(array_remove(p.scopes, 'leads:import')
                    || array['imports:apollo', 'imports:company', 'imports:excel', 'imports:manual']::text[])
   )
 where 'leads:import' = any(p.scopes);

-- Check: nobody holds leads:import any more; managers now have 38 boxes.
-- select email, array_length(scopes, 1), 'leads:import' = any(scopes) as old from public.profiles order by 2 desc nulls first;
