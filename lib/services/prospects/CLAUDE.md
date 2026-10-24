# lib/services/prospects/ — company-first fit scoring

Flow: Apollo **org search** (1 credit / 100 companies) → read home page (Firecrawl, 1 credit;
no site → LinkedIn via Tavily) → **Jev** classifier → reveal ONE contact only at good fits.

| File | What |
|---|---|
| `search.ts` | `runProspectSearch`: credit check → Apollo org search → save `prospect_companies` |
| `pipeline.ts` | state machine: one stage per `advance()`, one `save()` per stage; `runBatch` (parallel lanes) |
| `worker.ts` | one pass per company: budget 30 s, paid reads start by 35 s, 8 lanes; `batchFor` creates the Leads batch |
| `deps.ts` | real + mock services (`realDeps`, `mockDeps`), `limiter`, Firecrawl cap 4, `promote` |
| `store.ts` | Supabase store: `claim_prospects` RPC (row locks), `reserve_auto_reveal` RPC (atomic cap) |
| `jev.ts` | 2 yes/no questions: `plastic_maker` decides, `on_target` sets priority |
| `fit-rules.ts` | ≥0.65 good, ≤0.35 hidden, else unsure → About page → Tavily → review; scores 9/7/2 |
| `groups.ts`, `decisions.ts` | UI groups + approve/decline/retry transitions |
| `text.ts`, `tavily.ts` | text cleaning, second-page picker, sitemap; Tavily search |
| `digging.ts` | "N leads" rules: when to read the next page or stop (target, credit limit, Firecrawl < 100, dry pages, 20-page cap = 660 leads); page-memory `filterKey` |
| `estimate.ts` | free size check: People Search count → company and lead range |
| `keywords.ts` | Industry Segments writes without lost updates: `addKeyword` (one keyword, compare-and-swap on `settings.updated_at`, retries) for `POST /api/v1/settings/industry-keywords`; `saveGroupsChecked` for Settings (409 if changed since loaded) |
| `progress.ts` | honest words for the Started screen: finished headline (outage ≠ "All checked"), Good-fit line (waiting for credits apart), Time left ("Retrying" after 2 min without progress) |

- Lead target (19 Oct 2026): `continueRun` in `search.ts`, called by `worker.ts` for `run_status = running` searches, reads the next page; `prospect_page_memory` + `claim_prospect_page` RPC remember pages per filter set.

- Same search twice (23 Oct 2026): the wizard sends one `request_id` per session (kept in its draft, stored in `prospect_searches.filters`); `runProspectSearch` answers 409 `ALREADY_STARTED` with that search's id. Not unique-indexed, see the ponytail note.
- Organizations list (24 Oct 2026): `GET /api/v1/prospects` counts every search (head-only counts, `all_counts`, `review_total`), lists every search in `batches`, returns the newest `limit` (300) rows + `total_matching` ("Show more"); full progress numbers only for the 20 newest searches + `search_ids`.
- Tests: `npx tsx --test lib/services/prospects/*.test.mts` (fake DB in `fake-db.mts`).
- Mock scenarios by batch-name words (Dev only): `[no-credits] [credits-run-out] [sites-down] [no-socials] [jev-down] [flaky] [apollo-down] [apollo-timeout] [apollo-0] [apollo-empty] [pages-N] [firecrawl-low]`.
- Tables: `prospect_searches`, `prospect_companies`, `prospect_page_memory` (migrations `2026_10_08_*`, `2026_10_09_*`, `2026_10_19_*`).
