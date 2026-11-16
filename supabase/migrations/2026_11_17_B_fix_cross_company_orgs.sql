-- One-time data repair (17 Nov 2026) for the cross-company org bug fixed in
-- app/api/enrich/scrape-orgs (domain lookups now stay inside the lead's company)
-- and lib/utils/domain.ts ("x@mail.com" no longer becomes the website "com").
-- Safe to re-run: every step only touches rows that are still wrong. Deletes nothing.

-- 1. A lead whose own company already has an org with the same website: put it back on that org.
update public.leads l
   set organization_id = mine.id, updated_at = now()
  from public.organizations o
  join public.organizations mine on mine.domain = o.domain
 where l.organization_id = o.id
   and o.company_id <> l.company_id
   and mine.company_id = l.company_id;

-- 2. An org that holds ONLY another company's leads (none of its own): it belongs to
--    that company. Moved only when that company has no org with the same website yet
--    (one website per company, organizations_company_domain_unique).
update public.organizations o
   set company_id = x.lead_company, updated_at = now()
  from (
    select l.organization_id, min(l.company_id::text)::uuid as lead_company
      from public.leads l
      join public.organizations org on org.id = l.organization_id
     where l.company_id <> org.company_id
     group by l.organization_id
    having count(distinct l.company_id) = 1
  ) x
 where o.id = x.organization_id
   and not exists (select 1 from public.leads own where own.organization_id = o.id and own.company_id = o.company_id)
   and not exists (select 1 from public.organizations dup
                    where dup.company_id = x.lead_company and dup.domain = o.domain and dup.id <> o.id);

-- 3. Websites that can't be a company's own: a bare ending ("com", "ru") or a free
--    email service. Cleared, so they can never be matched to unrelated leads again.
update public.organizations
   set domain = null, updated_at = now()
 where domain is not null
   and (domain !~ '\.'
        or domain in ('mail.com', 'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com',
                      'hanmail.net', 'daum.net', 'naver.com', 'qq.com', '163.com', '126.com',
                      'rediffmail.com', 'yandex.com', 'mail.ru', 'live.com', 'icloud.com', 'aol.com'));

-- Check (expect 0 rows): leads whose org belongs to another company.
-- select l.id, l.company_id, o.company_id as org_company from public.leads l
--   join public.organizations o on o.id = l.organization_id where l.company_id <> o.company_id;
