# components/app/unibox/ — inbox UI

Gmail-style, assembled in `app/(app)/unibox/unibox-client.tsx`: a full-width inbox list
(`UniboxThreadList layout="full"`, one line per email), and opening an email switches to a
full-page thread (back arrow, ‹ › newer/older, Details rail at xl+). The open thread is the
`?thread=` URL param, so browser Back and shared links work; ‹ › use `router.replace` so Back
still lands on the list. The list stays mounted (hidden) while an email is open, keeping its
filters and scroll. Keys inside an email: j older, k newer, u back (ignored while typing).
`layout="rail"` (the old narrow two-line list) is kept for reuse.

`unibox-thread-list` (search + read-state Select + Filter popover, rows with hover prefetch of the thread),
`unibox-thread-view` (message cards + reply composer docked at the bottom),
`unibox-filters` (`UniboxReadStateSelect`, `UniboxFilterMenu`) + `unibox-status-filter` (predicates in `lib/unibox-filters.ts`),
`unibox-temperature-badge` (`lib/temperature-badge.ts`, sentence-case label), `unibox-instantly-interest-menu` (Popover; `variant="inline"` in the rail).
Tags use `Badge` + light/dark class pairs — not `Pill`, whose violet `dark:` classes leak through a light-only override.
Server logic: `lib/services/unibox.ts`, routes `app/api/v1/unibox/`.
