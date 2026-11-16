# Permissions (scopes) in Kuber

Kuber no longer has fixed roles. There is no Manager, Employee or Super Admin in the code.
Each person gets **scopes**: one tick box per area and action, set in **Settings → Team**.

## The 3 ideas

1. **Owner.** One per company. The owner has every permission, and nobody can change or turn
   off the owner. (Dev company: Lakshit. Kuber Polyplast: kuber@admin.com.)
2. **Members.** A member can do exactly what is ticked, nothing more. A member who is turned
   off can do nothing.
3. **Templates.** The **Manager** and **Employee** buttons tick the same boxes the old roles
   had, so nobody lost or gained access on the switch-over day. After that you can untick or
   tick single boxes per person.

## The boxes

Names are `area:action`. **See** never lets you edit, and **Edit** never lets you see.

| Area | Boxes |
|---|---|
| Dashboard | See · See all (company numbers, team table) |
| Leads | See · See all · Edit · Assign · Delete · Import (spends Apollo / Firecrawl) |
| Organizations | See all · Edit (re-reading a site spends Firecrawl) |
| Scored companies | See · Run (spends credits) |
| Campaigns | See · See all · Edit · AI drafts (spends AI) · Assign · Send (approve, send, pause, resume, hold) · Delete |
| Unibox | See · See all · Reply (sends email) · Edit (interest status) |
| Model Lab | See · Run |
| Credits | See |
| Kuber AI | Use · Actions · Admin |
| Company settings | Edit |
| Knowledge | Edit (products, industry segments) |
| API keys | See · Edit · Sender mailbox |
| Team | See · Manage |

**"See all"** decides how much data you see. Without it you see only **your own** leads, your
own campaigns (only your leads inside them) and replies on your own leads. With it you see the
whole company.

**Who gets new leads?** Auto-assign, round robin, territory and the "assign to" lists use
**lead owners**: people with Leads · See but not Leads · See all (the old "employees").

**Shared campaigns.** If a campaign holds leads of more than one lead owner, only someone with
Campaigns · See all can delete, pause, resume, edit it or run AI drafts on it. Hold still works
for everyone with Send (it is the emergency brake).

## Who can change permissions

- The **owner** can change anyone except themselves.
- A member with **Team · Manage** can only change members who do **not** have Team · Manage.
  They can only tick or untick boxes **they have themselves**, and they cannot give Team · Manage.
- Nobody can change their own boxes or turn themselves off.
- A change reaches every server within 30 seconds. The person sees the new menu after a page reload.

## For developers

- Code: `lib/auth/scopes.ts` (the list + rules), `lib/auth/scope-areas.ts` (labels, templates),
  `lib/auth/api-auth.ts` (`requireScope`), `lib/auth/scope.ts` (row rules),
  `lib/access-context.tsx` (`useAccess().can(...)` in the browser).
- DB: `profiles.scopes` (text[]) and `profiles.is_owner`. The check `kuber_scopes_valid` refuses
  unknown boxes.
- **Adding a feature?** Give it scopes in the same task. The steps are in the root `CLAUDE.md`
  ("Permissions (scopes) for every feature"), and the tests in `lib/auth/*.test.mts` fail if you
  skip one.
- A refused call returns 403: `You need the <scope> permission for this. Ask the owner to add it.`
