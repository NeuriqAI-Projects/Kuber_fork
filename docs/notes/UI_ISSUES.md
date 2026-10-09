u# UI Consistency Audit

Read-only audit of the frontend for visual inconsistency — same-purpose elements (panels, buttons, headings, empty states, inputs) rendered with different styling across pages. No fixes applied; this is a punch list to work through.

Severity: **High** = immediately visible to any user, jarring; **Med** = noticeable on close look / breaks on retheme; **Low** = cosmetic nitpick.

---

## 1. Add-leads Manual form — Organization section blends into background (High)

The originally reported bug. Three stacked containers share the exact same faint fill with no contrast between them, while a sibling section two lines down uses a solid fill:

- `components/app/add-leads-drawer.tsx:75` — outer tab shell: `rounded-xl border border-border bg-secondary/20 p-5`
- `components/app/lead-forms.tsx:172` (`BatchNameField`, shared by all 3 add-lead tabs) — `rounded-xl border border-border bg-secondary/20 p-4`
- `components/app/lead-forms.tsx:1230` (ManualForm **Organization** section) — `rounded-xl border border-border bg-secondary/20 p-4`
- `components/app/lead-forms.tsx:1255` (ManualForm **People** / lead-entry cards, right below Organization) — `rounded-xl border border-border bg-card p-4`

Fix direction: pick one fill for "nested section inside a drawer" (probably `bg-card`, since that's the dominant panel token elsewhere) and apply it consistently to Organization, People, and BatchName sections.

## 2. Card/panel background & radius has no single convention (High)

- Dominant pattern in most of the app: `rounded-xl border border-border bg-card` — e.g. `components/app/dashboard.tsx:146,179,230,284,322,374,396`, `app/(app)/campaigns/campaigns-client.tsx:147,162`, `components/app/team-view.tsx:111,135`, `components/app/settings-view.tsx` (many), `campaign-report.tsx:168,204`, `unibox-thread-list.tsx:101,127-129`.
- The shared primitive `components/ui/card.tsx:12` is `rounded-lg` — not `rounded-xl`. It's effectively unused; every page hand-rolls its own "card" look with a different radius than the primitive defines.
- `components/app/campaign-drawer.tsx` mixes both within one file: `rounded-xl` panels at lines 1363,1386,1421,1453,1491,1520,1649,2210,2402,2446 vs. `rounded-lg` panels at lines 2027,2032,2158,2196,2311,2331,2429 for equivalent-purpose containers.
- `components/app/settings-view.tsx:123` uses `bg-background` where every sibling section in the same file (296,382,404,418,438,453,474,576,598,621,647) uses `bg-card`.
- `components/app/create-campaign-modal.tsx:396,485` use `bg-background` for nested inline rows, while `campaign-drawer.tsx:2158,2196` use `bg-secondary/20`/`bg-secondary/30` for the same "nested row inside a card" role.

Fix direction: standardize on one radius (`rounded-xl` matches the majority) and one fill (`bg-card`) for top-level panels, and pick one fill for "nested row inside a panel" (currently 3 different tokens compete for that role).

## 3. Modal chrome duplicated instead of shared (Med)

- `app/(app)/app-shell.tsx:46`, `app/(app)/campaigns/campaigns-client.tsx:33`, `app/(app)/leads/page.tsx:1122` each hand-copy an identical delete-confirmation dialog (`rounded-2xl border border-border bg-card shadow-2xl p-6`) instead of sharing one component.
- The actual shared `Dialog` primitive (`components/ui/dialog.tsx:39`) renders `sm:rounded-lg` — no custom modal in the app actually uses that radius (`batch-confirm-modal.tsx:43`, `create-campaign-modal.tsx:286,299`, `edit-campaign-modal.tsx:377`, `reply-draft-box.tsx:168` all use `rounded-2xl` instead). The one real `<Dialog>` usage (ExcelForm's raw-preview dialog, `lead-forms.tsx:1040`) ends up with visibly squarer corners than every other "modal-looking" surface in the app.

Fix direction: extract one `ConfirmDialog` component for the three duplicated delete-confirm modals; align `Dialog`'s default radius to match the de-facto `rounded-2xl` convention (or vice versa).

## 4. Page-title heading hierarchy is inconsistent (High — very visible)

Four different treatments for what should be the same "page title" level:

- `text-2xl font-bold` — `campaigns-client.tsx:101` ("Campaigns"), `dashboard.tsx:124` ("Dashboard"), `login-form.tsx:28`
- `text-xl font-bold` — `team-view.tsx:107` ("Team & Assignment")
- `text-lg font-semibold` — `unibox-client.tsx:203` ("Unibox")
- No heading element at all — `settings-view.tsx:317-321` (breadcrumb-style text only, no h1-equivalent)

Fix direction: pick one class combo for top-level page titles and apply everywhere (Team and Unibox and Settings currently read as a smaller hierarchy level than Campaigns/Dashboard for no reason).

## 5. Hand-rolled buttons duplicate the shared `Button` component (Med)

- `components/app/lead-forms.tsx:464` — `rounded-md bg-primary text-primary-foreground hover:bg-primary/90` re-implements `buttonVariants({variant:"default"})` (`components/ui/button.tsx:12`) as a bespoke `<button>`.
- `components/app/campaign-drawer.tsx:2392` — near-identical second hand-rolled copy of the same styling.

Both will silently drift from real `Button` instances if the primary variant/radius is retheme'd later, since neither consumes `buttonVariants`.

## 6. Pill/tag styling reinvents `Badge` four different ways (Low-Med)

`components/app/lead-forms.tsx` hand-rolls a "selected pill" look four separate times with inconsistent padding/fill, none reusing `components/ui/badge.tsx`:

- line 99 (TagInput pill): `px-2 py-0.5 rounded-full bg-primary/15 border-primary/30 text-primary`
- line 489 (Industry keyword pill): same pattern
- line 664 (Location pill): same pattern
- line 775 (Seniority toggle): `px-2.5 py-1 rounded-full`, selected state `bg-primary text-primary-foreground border-primary` — a different fill convention than the other three (solid fill vs. tinted fill)

## 7. `Select`/`Input` background overridden with different, non-matching fills per caller (Med)

`components/ui/select.tsx:22` defaults to `bg-transparent`. Callers each pick a different override:

- `bg-card` — `leads/page.tsx:802`, `campaigns-client.tsx:135`
- `bg-background` — `edit-campaign-modal.tsx:52,422`
- `bg-secondary/30` — `campaign-drawer.tsx:1754,1764`
- left as default `bg-transparent` — Apollo/Manual form selects in `lead-forms.tsx`, `create-campaign-modal.tsx:85,332`

Same issue on `Input`: `reply-draft-box.tsx:197` and `unibox-thread-view.tsx:218` use `bg-background/60`, `edit-campaign-modal.tsx:261` uses `bg-background`, while most `Input` usages (including every one in `lead-forms.tsx`) take the transparent default.

Fix direction: the shared component's default should match what most callers actually want (looks like `bg-card` is the intended surface color) so individual pages stop needing to override it at all.

## 8. Empty states have at least 5 distinct presentations (Med)

- Boxed, `shadow-sm`, `py-16` — `unibox-thread-list.tsx:97`, `campaign-drawer.tsx:1645`
- Boxed, no shadow, `p-12` — `campaigns-client.tsx:147`
- Bare text, no box — `dashboard.tsx:190` ("No leads yet — add some…"), `unibox-thread-view.tsx:293` ("No messages in this thread yet.")
- Bare `<TableCell>` text — `leads/page.tsx:897,979-980`
- Italic bare text — `org-drawer.tsx:409` ("No leads linked to this org.")

Fix direction: one `EmptyState` component (icon + message + optional boxed container) reused everywhere.

## 9. Stat-tile ("small metric card") styling has 3 competing conventions (Low-Med)

- `campaign-report.tsx:139` — `rounded-lg border bg-secondary/20 py-3 px-2`
- `campaign-drawer.tsx:1363` — `rounded-xl border bg-card p-3`
- `lead-forms.tsx:1091` — `rounded-lg` with colored `bg-amber/zinc/red-500/10` tokens

---

## Not flagged (reviewed, judged intentional)

Destructive-styled affordances (`settings-view.tsx:662`, `campaign-drawer.tsx:1340`) use hover-only red tints rather than a solid destructive fill — this reads as an intentional "danger outline" pattern distinct from `Button`'s `destructive` variant, not a duplicate/bug. Noted for awareness only.

---
 
## Suggested fix order

1. **#1** (Manual form Organization bg) — the specific bug reported, quick fix.
2. **#4** (heading hierarchy) — highest visibility-to-effort ratio.
3. **#2 + #7** (panel/input/select tokens) — biggest structural inconsistency, touches the most files; worth doing together since they're the same root cause (no single "surface color" convention enforced anywhere).
4. **#3, #6, #8, #9** — component-extraction cleanup (ConfirmDialog, Badge reuse, EmptyState, StatTile) — lower urgency, do opportunistically.
5. **#5** — replace the two hand-rolled buttons with `Button` when touching those files next.
