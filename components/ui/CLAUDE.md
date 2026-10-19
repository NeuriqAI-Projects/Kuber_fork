# components/ui/ — shared controls (single source of truth)

Every field-like control in the app comes from here. Never hand-roll a copy in a feature file.
If a control lacks something, **extend its props here** (like `DatePicker` got `size`).

Inputs: `input`, `textarea`, `select`, `app-checkbox`, `app-radio`, `switch`, `date-picker`
(+`calendar`, `popover`), `locations-picker`, `search-input`, `rich-text-editor`, `prompt-editor`,
`template-var-textarea`, `field`, `label`.
Layout: `page-header` (`PageHeader`, `Toolbar`), `record-layout` (`RecordLayout`,
`RecordHeader`, `DetailSection`, `DetailRow`), `card`, `dialog`, `confirm-dialog`, `page-shell`,
`tabs`, `segmented-tabs` (segmented / underline), `table` (Attio grid), `pagination`,
`scroll-area`, `separator`, `skeleton`, `empty-state`, `stat-tile`, `stepper`, `command-menu`.
Small: `button`, `badge`, `pill`, `info-tip`, `info-tooltip`, `availability-toggle`.

- Attio look: 32px controls (`h-8`), 13px UI text, 6px radius, white fields with an
  `border-input` line and `shadow-xs`; menus/dialogs `bg-popover` + soft shadow, no animations.
- Fields keep their default `bg-field`; never override with `bg-card`/`bg-white`.
- No `focus:ring-*` / `focus:outline-*` classes.
