# components/app/unibox/ — inbox UI

Three-pane Attio mail layout, assembled in `app/(app)/unibox/unibox-client.tsx`: list (360px) | open thread | Details rail (xl+).
Below lg the panes stack (list, or thread with a back button).

`unibox-thread-list` (search + read-state Select + Filter popover, rows with hover prefetch of the thread),
`unibox-thread-view` (message cards + reply composer docked at the bottom),
`unibox-filters` (`UniboxReadStateSelect`, `UniboxFilterMenu`) + `unibox-status-filter` (predicates in `lib/unibox-filters.ts`),
`unibox-temperature-badge` (`lib/temperature-badge.ts`, sentence-case label), `unibox-instantly-interest-menu` (Popover; `variant="inline"` in the rail).
Tags use `Badge` + light/dark class pairs — not `Pill`, whose violet `dark:` classes leak through a light-only override.
Server logic: `lib/services/unibox.ts`, routes `app/api/v1/unibox/`.
