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
| `estimate.ts` | free size check. Since 3 Nov 2026 it COUNTS companies: `scanBuyerCompanies` (apollo.ts) reads up to 40 pages of buyer-title people (0 credits), `normCompanyName` dedupes names (legal endings), companies the workspace has are left out, leads = new × `leadShare` (past searches with these keywords, weighted by keyword overlap; 40% default). Falls back to the old people-count maths (`estimateMarket`) when the scan fails. Route caches full scans 7 days in memory. Backtest on 16 client searches: companies 5% error, leads 20% |
| `keywords.ts` | Industry Segments writes without lost updates: `addKeyword` (one keyword, compare-and-swap on `settings.updated_at`, retries) for `POST /api/v1/settings/industry-keywords`; `saveGroupsChecked` for Settings (409 if changed since loaded) |
| `progress.ts` | honest words for the Started screen: finished headline (outage ≠ "All checked"), Good-fit line (waiting for credits apart), Time left: progress = companies finished checking (not websites read); "Waiting" after 1 min, "Retrying" after 2 min, or after 20 s when `stages.ai_retrying` > 0 (read rows whose AI call already failed) |

- Lead target (19 Oct 2026): `continueRun` in `search.ts`, called by `worker.ts` for `run_status = running` searches, reads the next page; `prospect_page_memory` + `claim_prospect_page` RPC remember pages per filter set.

- Same search twice (23 Oct 2026): the wizard sends one `request_id` per session (kept in its draft, stored in `prospect_searches.filters`); `runProspectSearch` answers 409 `ALREADY_STARTED` with that search's id. Not unique-indexed, see the ponytail note.
- Organizations list (24 Oct 2026): `GET /api/v1/prospects` counts every search (head-only counts, `all_counts`, `review_total`), lists every search in `batches`, returns the newest `limit` (300) rows + `total_matching` ("Show more"); full progress numbers only for the 20 newest searches + `search_ids`.
- Apollo at 0 (13 Nov 2026): `runBatch` asks once per run (`deps.apolloEmpty` = `apolloOutOfCredits`, provider-credits.ts) and parks waiting_credits rows in one write (`store.parkWaiting`); `companiesWithWork` and the pg_cron gate (`2026_11_13_apollo_zero_gates.sql`) skip them while the saved Apollo balance is 0 and < 1 h old. A saved 0 is re-read from Apollo at most hourly; Usage > Apollo refresh reopens at once.
- Booked credits (13 Nov 2026): a new search only gets the Apollo credits other searches can't still spend. `prospect_credit_bookings` RPC (one row per search that is `running` or has workable rows) → `bookedCredits` (digging.ts): running = min(credit limit − used, reveal cap left + pages it may still read), stopped = its unfinished companies within its reveal cap, + 1 per approved-not-revealed; plus contacts queued for a reveal. `runProspectSearch` refuses (402 `APOLLO_CREDITS_BOOKED`) when balance − booked < `minCredits(target)` (1 without a target); the size check (estimate route) returns `apollo_booked` / `apollo_booked_by` and `apollo_leads` net of it. RPC missing → `apolloBooked` returns null → old check only.
- Waiting 2 days (13 Nov 2026): `prospect_companies.waiting_since` is set/cleared by a trigger on every status change (updated_at is useless: claims and parks touch it). pg_cron `prospect-long-wait-review` (hourly, SQL only, works while the Apollo gates keep the pump asleep) runs `review_long_waits()`: waiting_credits > 2 days → `review` with last_error starting `LONG_WAIT` (groups.ts; keep equal to the SQL text). No credit spent; Approve = the normal approved path (may wait again; the clock restarts). `liveRunNote` says how many moved (`waitedOut`). Migrations `2026_11_13_credit_bookings_long_wait.sql` + `2026_11_13_long_wait_review_cron.sql` (back-fill + job, run at deploy).
- Tests: `npx tsx --test lib/services/prospects/*.test.mts` (fake DB in `fake-db.mts`).
- Mock scenarios by batch-name words (Dev only): `[no-credits] [credits-run-out] [sites-down] [no-socials] [jev-down] [flaky] [apollo-down] [apollo-timeout] [apollo-0] [apollo-empty] [pages-N] [firecrawl-low]`.
- Tables: `prospect_searches`, `prospect_companies`, `prospect_page_memory` (migrations `2026_10_08_*`, `2026_10_09_*`, `2026_10_19_*`).
