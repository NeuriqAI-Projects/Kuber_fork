# components/app/ — feature screens

Group by feature (find the file by prefix):
- **Leads:** `lead-drawer`, `org-drawer`, `lead-forms` (manual add, industry keywords), `add-leads-drawer`
  (sections: Apollo search, company lookup, scored companies, Excel), `company-lookup-form`
  (Apollo company search + advanced filters), `apollo-people-advanced`, `batch-confirm-modal`, `kanban-board`.
- **Scored companies:** `prospect-finder-form` (4-step wizard → Started screen), `scored-orgs`
  (polling hook, table, kanban, filters, running-searches bar). API: `/api/v1/prospects/*`.
- **Campaigns:** `campaign-drawer` (leads, outbox, sequences), `create-/edit-campaign-modal`,
  `campaign-config-modal`, `campaign-kanban`, `campaign-report`, `regenerate-drafts-modal`,
  `hold-sending-modal`, `replace-lead-modal`, `email-sending-view`.
- **Replies:** `reply-draft-box`, `manual-reply-box`, `reply-recipients`, `reply-cc-bcc-fields`, `reply-attach-controls`.
- **Settings:** `settings-view`, `keys-view`, `keys-usage-*`, `team-view`, `usage-bar-chart`.
- **Other:** `dashboard`, `model-lab-view`, `discussion-comment`, `service-health-banner`,
  `apollo-cost-note` (required wherever Apollo credits are spent), `page-skeletons`, `usage-skeletons`, `tag-input`.

Data comes from `lib/api-client.ts` (fetch wrappers) and `lib/app-context.tsx`.
Big files (campaign-drawer, settings-view) — read the part you need, don't rewrite.
