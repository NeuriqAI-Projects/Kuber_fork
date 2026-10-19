# components/ui/ — shared controls (single source of truth)

Every field-like control in the app comes from here. Never hand-roll a copy in a feature file.
If a control lacks something, **extend its props here** (like `DatePicker` got `size`, `minDate`/`maxDate`).

Inputs: `input`, `textarea`, `select`, `app-checkbox`, `app-radio`, `choice-card`, `switch`,
`date-picker` (+`calendar`, `popover`), `email-chip-input`, `locations-picker`, `search-input`,
`rich-text-editor`, `prompt-editor`, `template-var-textarea`, `field`, `label`.
Layout: `page-header` (`PageHeader`, `Toolbar`), `page-shell`, `record-layout` (`RecordLayout`,
`RecordHeader`, `DetailSection`, `DetailRow`), `settings` (`SettingsNav`, `SettingsPageTitle`,
`SettingsSection`, `SettingsSectionHeader`, `SettingsRow`), `panel`, `card`, `dialog`,
`modal-shell`, `confirm-dialog`, `tabs`, `segmented-tabs` (segmented / underline), `table`
(Attio grid), `pagination`, `scroll-area`, `separator`, `skeleton`, `empty-state`, `stat-tile`,
`stepper`, `command-menu`.
Small: `button`, `badge`, `pill` (`Pill`, `pillClass`, `pillTone`), `info-tip`, `info-tooltip`,
`availability-toggle`.

- Attio look: 32px controls (`h-8`), 13px UI text, 6px radius, white fields with an
  `border-input` line and `shadow-xs`; menus/dialogs `bg-popover` + soft shadow, no animations.
- Fields keep their default `bg-field`; never override with `bg-card`/`bg-white`.
- No `focus:ring-*` / `focus:outline-*` classes.

## Which piece for what

- **`Panel`** — bordered card with a header strip (title, muted description, `actions` on the
  right, or a muted `aside` fact). `flush` for an edge-to-edge table, `truncate` for one-line
  titles. Dashboard panels and every Credits usage report.
- **`Pill`** — every tag/status chip. Pick a `color`: batch tones, or `"neutral"` (gray),
  `"red"`, `"primary"`. Don't pass light-only `bg-*/text-*` classes for a status: the default
  violet `dark:` classes stay and the tag turns violet in dark mode. Chip that must be a
  `<button>` → `pillClass({ color, shape })`; tinting a `Badge` → `pillTone(color)`.
- **`ChoiceCard`** — radio/checkbox as a clickable bordered box. `indicator="radio" | "checkbox"`,
  `title` + `description`, or `children` for custom content (theme swatches).
- **`ModalShell`** — custom modal that must open above a drawer: portal, z-200,
  `data-confirm-dialog-root`, forced pointer events, backdrop, popover panel. Caller passes
  width/layout in `className`. Plain modals not over a drawer use `DialogContent`.
- **`PageShell`** — every full page. `crumbs` for a path, `subheader` for a strip that must not
  scroll (Credits tabs), `nav` for a side menu (Settings, with `width="none"` when the column
  width changes per section).
- **`settings`** — `SettingsNav` (grouped 32px side menu, pass as PageShell `nav`),
  `SettingsPageTitle` (18px title + description + actions), `SettingsSection` /
  `SettingsSectionHeader` (15px title, 1px rule, optional aside/info tip), `SettingsRow`
  (label left 2fr, control right 3fr).
- **`DatePicker`** — single date. `minDate` / `maxDate` grey out days outside the range (a
  From/To pair is two DatePickers, From's `maxDate` = To and To's `minDate` = From).
- **`EmailChipInput`** — To / Cc / Bcc address chips. `suggestions`, `max`, `onError`,
  `lockedEmail` (tinted chip with a lock), `allowAdd={false}` for a prune-only field. The
  composer row layout (`ComposerRow`) stays in `components/app/reply-recipients.tsx`.
