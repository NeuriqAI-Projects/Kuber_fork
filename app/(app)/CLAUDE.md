# app/(app)/ — signed-in screens

`layout.tsx` checks the session (`lib/server/session.ts`); `app-shell.tsx` is the sidebar,
top bar, review badge and service-health banner.

| Route | Main file | UI lives in |
|---|---|---|
| `/dashboard` | `dashboard/dashboard-client.tsx` | `components/app/dashboard.tsx` |
| `/leads` | `leads/page.tsx` (People / Organizations tabs, List/Kanban, scored-org filters via URL `sbatch`/`sgroups`/`shidden`) | `lead-drawer`, `org-drawer`, `scored-orgs`, `add-leads-drawer` |
| `/leads/[id]` | single lead | `lead-drawer.tsx` |
| `/leads/add` | add leads | `add-leads-drawer.tsx`, `lead-forms.tsx` |
| `/campaigns`, `/campaigns/[id]` | `campaigns-client.tsx`, `campaign-detail-client.tsx` | `campaign-drawer.tsx`, `campaign-*` |
| `/unibox` | `unibox-client.tsx` | `components/app/unibox/` |
| `/settings` | tabs | `settings-view.tsx`, `keys-view.tsx`, `team-view.tsx` |
| `/model-lab` | try models/prompts | `model-lab-view.tsx` |

- Each route has a `loading.tsx` skeleton — use `components/app/page-skeletons.tsx`.
- Managers vs employees see different data; respect `role` from the session.
