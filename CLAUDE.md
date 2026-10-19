# Kuber — agent notes

Next.js 15 (App Router) + React 19 + Tailwind 4 + Supabase. Deployed on Vercel.
Lead-gen pipeline: **Apollo** (find people/companies, reveal emails) → **Firecrawl**
(read company site) → **LLM** (write emails) → **Instantly** (send) → **Unibox** (replies).

## Map — each folder has its own CLAUDE.md, read it before editing there

| Folder | What lives there |
|---|---|
| `app/` | Pages (`app/(app)/`) and API routes (`app/api/`) |
| `components/` | `ui/` = shared controls (mandatory, see rules below); `app/` = feature screens |
| `lib/` | Everything that isn't UI: auth, Supabase clients, services, validators |
| `lib/services/` | Business logic + provider calls (Apollo, Firecrawl, Instantly, LLM) |
| `supabase/migrations/` | SQL migrations — the user runs them by hand on the live DB |
| `scripts/` | One-off checks, repairs, probes, the local watchdog |
| `docs/` | Design docs, RCAs, PRDs, `docs/notes/` audits, `docs/legacy/` old schema |
| `Deployed/` | Untracked deploy clone (rjm2007/Kuber_fork). Not part of this repo; excluded from tsconfig |

## Repo-wide rules
- **Multi-tenant.** Every request works for one company. Use `createScopedClient(companyId)`
  (`lib/supabase/scoped.ts`); `createAdminClient()` only for deliberate cross-company work (cron, watchdogs).
- **Live DB.** `.env.local` points at the client's live Supabase. Test on the Dev company
  `00000000-0000-0000-0000-00000000000a`. Non-production Apollo calls are mocked.
- **Provider keys** are DB-first (`provider_keys`, Settings > Keys), `.env.local` is the fallback. Never print keys.
- **Before pushing:** `npm run build` (redirect to a file, grep `Error:`; lint tail hides errors). Never run two builds at once.
- **Tests:** `npx tsx --test lib/**/*.test.mts` style, file by file (e.g. `npx tsx --test lib/services/prospects/*.test.mts`).
- Answer the user in very short, easy words.

## One shared component per control type (hard rule, strict)

**Every field-like control anywhere in this app MUST be the shared component from `components/ui/` — never a one-off hand-styled element, and never a local re-implementation.**

| Control | Use this, always |
|---|---|
| Text / number / email input | `Input` (`components/ui/input.tsx`) |
| Multi-line text | `Textarea` (`components/ui/textarea.tsx`) |
| Dropdown / picker | `Select` + `SelectTrigger` (`components/ui/select.tsx`) |
| Checkbox / tri-state selection | `AppCheckbox` (`components/ui/app-checkbox.tsx`) |
| Radio | `AppRadio` (`components/ui/app-radio.tsx`) |
| Single date / date range | `DatePicker` (`components/ui/date-picker.tsx`) — wraps `Calendar` + `Popover`; never hand-roll a `Popover`+`Calendar`+`Button` date trigger again. A From/To pair is two DatePickers linked with `maxDate` / `minDate` |
| Email addresses (To / Cc / Bcc chips) | `EmailChipInput` (`components/ui/email-chip-input.tsx`) |
| Multi-select country/region | `LocationsPicker` (`components/ui/locations-picker.tsx`) |
| Toggle | `Switch` (`components/ui/switch.tsx`) |
| Rich text / HTML body | `RichTextEditor` (`components/ui/rich-text-editor.tsx`) |
| Choice card (a radio/checkbox rendered as a clickable bordered box with a label+description, e.g. "Assign imported leads" strategy cards, handover-strategy cards, theme tiles) | `ChoiceCard` (`components/ui/choice-card.tsx`) — `border-border bg-field` unselected, `border-primary/50 bg-primary/5` selected; `indicator="radio" \| "checkbox"` |
| Status tag / chip | `Pill` (`components/ui/pill.tsx`) with a `color` (batch tones, `neutral`, `red`, `primary`); `pillClass()` for a chip that must be a `<button>`, `pillTone()` to tint a `Badge`. No local tone maps |
| Card with a header (title, description, right-side actions) | `Panel` (`components/ui/panel.tsx`) |
| Custom modal that opens above a drawer | `ModalShell` (`components/ui/modal-shell.tsx`) — portal, z-200, `data-confirm-dialog-root`. Otherwise `DialogContent` |
| Settings-style page (side menu, section header, label-left/control-right rows) | `PageShell` with `nav` + `SettingsNav` / `SettingsPageTitle` / `SettingsSection` / `SettingsRow` (`components/ui/settings.tsx`) |
| Multi-step wizard progress | `Stepper` (`components/ui/stepper.tsx`) — the not-yet-reached step pill is `bg-field` for the same choice-card reason; don't hand-roll step chips. |
| Apollo credit-cost messaging ("N leads/contacts selected → N credits will be spent") | `ApolloCostNote` (`components/app/apollo-cost-note.tsx`) — shown twice per Apollo-backed import flow: once where the count that drives cost is chosen, once as final confirmation right before the button that spends it. Same UI in test-mode workspaces too (real credit count + a "(test)" tag), never a different box/copy for mock vs real. See `docs/apollo-credit-usage-rca.md` for the cost model — search is free, reveal is 1 credit/contact, org search is 1 credit/page; **no individual filter field has its own cost**, confirmed against Apollo's own docs, so never add a per-field "uses credits" pill. |

A miss worth remembering: `RichTextEditor` looked like a plain panel bug (its wrapper was `bg-card`) but the real cause was that it's a fully custom component, not built on the shared `Textarea` — so the global `Textarea` fix never reached it. When a field-like control renders wrong, check whether it actually goes through one of the components in this table before assuming the token/ladder is at fault; a bespoke reimplementation is the more common cause.

Before writing a new field-like control (a hand-rolled `<input>`, a `Popover`-based trigger button standing in for a select, a `<input type="radio"/checkbox">`, a bespoke date field, etc.), **check this table first.** If nothing fits, extend the existing shared component's props (as `DatePicker` was extended with `size`/`showQuickActions`) rather than building a local one-off in the calling file. A local `DateField`/`FIELD_FILL`-style helper duplicated per-file is exactly the bug this rule exists to prevent — it already happened twice (`create-campaign-modal.tsx` and `edit-campaign-modal.tsx` each had their own copy of a `FIELD_FILL` constant, and `company-lookup-form.tsx` had its own `Popover`+`Calendar` date field) before being consolidated.

Exception: raw `<input type="file" hidden>` and raw `<input type="checkbox"/radio">` used purely as a native a11y target under a custom-styled wrapper (not visible itself) don't need a shared wrapper — but the *visible* control next to them (the checkmark, the radio dot) still must be `AppCheckbox`/`AppRadio`.

## Attio look — surfaces and colour (hard rule)

The UI follows Attio (reference: the "Attio Full Dashboard UI Screens" Figma file). This
replaced the old "gray panels, white fields only, 4-colour light mode" rule on 19 Oct 2026
at the client's request.

### Surface ladder

| Role | Token | Light | Dark |
|------|-------|-------|------|
| Page | `bg-background` | white | near-black |
| Sidebar (nav rail only) | `bg-sidebar` | faint off-white | one step up |
| Panel / card / table / list | `bg-card` | white | one step up from page |
| Menu / popover / modal | `bg-popover` + `shadow-lg`/`shadow-xl` | white | one more step |
| Nested area, chips, skeleton blocks | `bg-secondary` | light gray | |
| Row / menu / nav hover | `bg-hover` | lighter gray | |
| Selected row / nav item | `bg-accent` (nav) or `bg-primary/5` (rows) | | |
| Field | `bg-field` via the shared `components/ui` control | white | one step above panels |

Palettes are generated in `lib/branding.ts` (`buildLightPalette` / `buildDarkPalette`); the
pre-paint script in `app/layout.tsx` embeds them as JSON from the same functions, so there is
one source of truth. A new token goes in `CSS_VARS`, both palette builders, `@theme` and the
`:root` defaults in `app/globals.css`.

### Do / don't

- **Separate with 1px borders, not fills.** In light mode page, panels, tables and fields are
  all white; hierarchy comes from `border-border` lines and soft shadows on floating things.
- **Primary (theme colour) is for** primary buttons, links, checked checkbox/radio/switch and
  small selected tints (`bg-primary/10`). Never a big fill, never a rail on cards.
- **Tags / status pills** use the light/dark pair: `bg-x-100 text-x-800` in light,
  `dark:bg-x-500/15 dark:text-x-300` in dark (see `BATCH_COLORS` in `lib/constants.ts`,
  `lib/temperature-badge.ts`, `components/leads/lead-ui.tsx`). Never `text-x-400` alone — it
  is unreadable on white.
- **Density:** controls are 32px (`h-8`), small 28px; UI text 13px, body 14px; titles 15–18px
  semibold. No uppercase tracked "eyebrow" labels, no mono numbers — use `tabular-nums`.
- **Instant, no motion:** no fade/slide/zoom entrance animations on panels, menus or dialogs,
  no press-scale. Hover colour transitions only.
- **Don't** override fields with `bg-card`/`bg-white`/ad-hoc fills, and don't wrap one or two
  fields in their own bordered box for grouping — plain spacing is enough.
- **Don't** duplicate a field-fill constant per file — extend the shared component.

### Screen building blocks (`components/ui`)

- `PageHeader` (48px breadcrumb + actions bar) and `Toolbar` (view/Sort/Filter row) — every
  screen starts with these. `PageShell` wraps PageHeader + the scroll column (and an optional
  side `nav` or fixed `subheader`) for full pages.
- `Panel` — report card with a header strip (dashboard, Credits usage).
- `Table` = Attio grid (32px header, 36px rows, 1px grid lines, `hover:bg-hover`).
- `RecordLayout` + `RecordHeader` + `DetailSection` + `DetailRow` — lead, org and campaign
  record views (main column with underline tabs + right "Details" rail).
- `SegmentedTabs` — `variant="segmented"` for view toggles, `variant="underline"` for page tabs.
- `CommandMenu` — the ⌘K "Quick actions" palette in the app shell.
- `EmptyState` — icon tile, optional `title`, message, one primary action.

## No focus ring at all (hard rule)

**No element may show any visible focus ring or outline on selection/click/tab — no browser native outline, and no Tailwind `ring-*` box-shadow either.** This applies to inputs, selects, textareas, calendar/date-picker day cells, dropdown triggers, buttons, anything focusable.

This was a blue rectangle in two different forms: the browser's native `outline`, and separately our own `focus-visible:ring-2 focus-visible:ring-ring` utility (used on `Input`/`Select`/`Textarea`/`Button`) — in light mode `--ring` resolves to the primary brand color, so that box-shadow ring rendered blue too. Both are killed globally in `app/globals.css` via:

```css
*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }
```

right after the `* { border-color: var(--border); }` rule. Do not remove or narrow that rule, and do not re-add `outline` or `ring-*`/`shadow-*` on `:focus`/`:focus-visible` anywhere, even scoped to one component — the global `!important` reset is intentional and should stay the single source of truth.

- **Don't** add `focus:outline-*`, `focus-visible:outline-*`, `focus:ring-*`, or `focus-visible:ring-*` Tailwind classes on new components. They're dead weight — the global reset overrides them anyway — and reintroducing them invites someone to "fix" the reset instead of just deleting the dead classes.
- If a new custom interactive element needs a *non-focus* visual state for being active/selected/open (e.g. the locations picker's open state), use a state-driven class (`data-[state=open]:...`, a conditional className) instead of a focus pseudo-class.
