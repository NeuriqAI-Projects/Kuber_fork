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

- Lead target (19 Oct 2026): `continueRun` in `search.ts`, called by `worker.ts` for `run_status = running` searches, reads the next page; `prospect_page_memory` + `claim_prospect_page` RPC remember pages per filter set.

- Tests: `npx tsx --test lib/services/prospects/*.test.mts` (fake DB in `fake-db.mts`).
- Mock scenarios by batch-name words (Dev only): `[no-credits] [credits-run-out] [sites-down] [no-socials] [jev-down] [flaky] [apollo-down] [apollo-timeout] [apollo-0] [apollo-empty] [pages-N] [firecrawl-low]`.
- Tables: `prospect_searches`, `prospect_companies`, `prospect_page_memory` (migrations `2026_10_08_*`, `2026_10_09_*`, `2026_10_19_*`).
