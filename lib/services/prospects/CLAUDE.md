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

- Tests: `npx tsx --test lib/services/prospects/*.test.mts` (fake DB in `fake-db.mts`).
- Mock scenarios by batch-name words (Dev only): `[no-credits] [credits-run-out] [sites-down] [no-socials] [jev-down] [flaky] [apollo-down] [apollo-timeout] [apollo-0] [apollo-empty]`.
- Tables: `prospect_searches`, `prospect_companies` (migrations `2026_10_08_*`, `2026_10_09_*`).
