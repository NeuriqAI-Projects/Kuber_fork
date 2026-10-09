# backend.md — Kuber Polyplast Sales Automation
## NextJS Backend — Phase 1 Deep Plan (v2, post live API testing June 11)

> **Scope:** Lead Gen (Apollo / Excel / Manual) → Enrichment (bulk_match + Firecrawl + LLM) → Campaigns → Email Drafting + Review.
> **Phase 2 (NOT built):** Instantly sending, webhooks, replies. Routes reserved in §9.
> **Stack:** Next.js App Router (route handlers, TypeScript) · Supabase (Postgres/Auth/Storage) · Apollo · Firecrawl v2 · OpenRouter (primary LLM) with **OpenAI direct fallback**.
> **Schema:** `kuber_schema.dbml` v5.1 — every field mapping below is from **live API responses captured June 11**, not docs examples.
> Hand to Cursor section by section, in the §8 build order.

---

# 1. Conventions

- Base path `/api/v1`, resource-grouped routes (entities, not features).
- One response wrapper everywhere:
```ts
// lib/api-response.ts
export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: { code: string; message: string; details?: unknown } | null;
};
export const ok = <T>(data: T) => Response.json({ success: true, data, error: null });
export const fail = (status: number, code: string, message: string, details?: unknown) =>
  Response.json({ success: false, data: null, error: { code, message, details } }, { status });
```
- Error codes used consistently: `VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `NOT_FOUND` 404 · `DUPLICATE` 409 · `UPSTREAM_APOLLO` / `UPSTREAM_FIRECRAWL` / `UPSTREAM_LLM` 502 · `INTERNAL` 500. **Batch endpoints always return 200 with per-item results** (see §5) — partial failure is data, not an HTTP error.
- zod validation per endpoint (`lib/validators/*`), parse before anything else.
- Swagger: `next-swagger-doc` + `swagger-ui-react`; spec at `GET /api/v1/openapi.json`, UI at `/api-docs`. JSDoc `@swagger` block on every handler (Lakshit reviews via this).
- Auth: Supabase JWT middleware on `/api/v1/*` (skip `/health`, `/openapi.json`). `created_by/updated_by` from the verified token only — never from request body.
- All external calls go through `lib/services/*` — route handlers never call Apollo/Firecrawl/LLM directly.

---


`.env.local`
```
SUPABASE_URL=  SUPABASE_SERVICE_ROLE_KEY=
APOLLO_MASTER_KEY=
FIRECRAWL_API_KEY=
OPENROUTER_API_KEY=          # primary LLM gateway
OPENAI_API_KEY=              # direct fallback when OpenRouter unavailable
LLM_PRIMARY_MODEL=anthropic/claude-sonnet-4.5     # via OpenRouter
LLM_FALLBACK_MODEL=gpt-4o-mini                    # via OpenAI direct
SCRAPES_DIR=./scrapes
```

---

# 3. Frontend → Apollo `person_locations` mapping (LIVE-CONFIRMED working)

Your June 11 test with a US location returned 51 results → the country filter ships. Apollo accepts plain country names (city/state granularity like `"California, US"` possible later). **`lib/constants.ts` exports this map; `GET /api/v1/meta/locations` serves it to the frontend dropdown:**

| Dropdown label (UI) | Sent to Apollo `person_locations[]` | Instantly timezone default |
|---|---|---|
| Worldwide (default) | *(omit parameter entirely)* | per-lead `time_zone` |
| India | `"India"` | Asia/Kolkata |
| Bangladesh | `"Bangladesh"` | Asia/Dhaka |
| Sri Lanka | `"Sri Lanka"` | Asia/Colombo |
| Pakistan | `"Pakistan"` | Asia/Karachi |
| United States | `"United States"` | per-lead `time_zone` |
| Poland | `"Poland"` | Europe/Warsaw |
| Czech Republic | `"Czech Republic"` | Europe/Prague |
| Romania | `"Romania"` | Europe/Bucharest |
| UAE | `"United Arab Emirates"` | Asia/Dubai |
| Saudi Arabia | `"Saudi Arabia"` | Asia/Riyadh |
| Turkey | `"Turkey"` | Europe/Istanbul |
| Vietnam | `"Vietnam"` | Asia/Ho_Chi_Minh |
| Thailand | `"Thailand"` | Asia/Bangkok |
| Indonesia | `"Indonesia"` | Asia/Jakarta |
| Malaysia | `"Malaysia"` | Asia/Kuala_Lumpur |
| Egypt | `"Egypt"` | Africa/Cairo |
| Nigeria | `"Nigeria"` | Africa/Lagos |
| Kenya | `"Kenya"` | Africa/Nairobi |
| Brazil | `"Brazil"` | America/Sao_Paulo |
| Mexico | `"Mexico"` | America/Mexico_City |

Multi-select allowed → array of strings. **Timezone note:** bulk_match returns per-person `time_zone` (live-confirmed, e.g. `"America/New_York"`) — when present it overrides the table default for that lead.

---

# 4. Live-verified field mappings (the contract)

### 4.1 `mixed_people/api_search` → DB (Stage 1)  [live 51-result test]
| Response path | → | Notes |
|---|---|---|
| `people[].id` | `leads.apollo_id` | dedup key — SELECT before INSERT (June 10 rule) |
| `people[].first_name` | `leads.first_name` | |
| `people[].title` | `leads.title` | |
| `people[].has_email` | `leads.has_email` | gate for enrich |
| `people[].organization.name` | `organizations.name` (upsert by lower(name)) | only org value available at this stage |
| `people[].last_name_obfuscated` | **discard** | never store |
| `people[].has_*`, `organization.has_*` | **discard** | flags, not values |
| `total_entries` | response meta | pagination math |

### 4.2 `people/bulk_match` → DB (Stage 2A)  [live response June 11 — has fields the docs examples lacked]
**Person → `leads` (match row by `apollo_id = matches[].id`):**
| Path | Column | Edge note |
|---|---|---|
| `matches[].last_name` | `last_name` | |
| `matches[].email` | `email` | can be absent on a match → leave NULL |
| `matches[].email_status` | `email_status` | gate: only `"verified"` proceeds to draft/send |
| `matches[].headline` | `headline` | |
| `matches[].linkedin_url` | `linkedin_url` | nullable |
| `matches[].city / state / country` | same | |
| **`matches[].time_zone`** | **`time_zone`** | NEW, live-confirmed — feeds Instantly scheduling directly |
| **`matches[].email_domain_catchall`** | **`email_domain_catchall`** | NEW — `true` = "verified" is weaker; ⚠ badge in CRM, watch bounces |
| `matches[].seniority` | `seniority` | |
| `matches[].departments[]` | `departments` | |
| `matches[].is_likely_to_engage` | `is_likely_to_engage` | **ABSENT in live response** — store `?? null`, never gate on it |
| `matches[].organization_id` | → org upsert key | |

**Organization → `organizations` (upsert by `apollo_org_id = matches[].organization_id`):**
| Path | Column |
|---|---|
| `organization.name` | `name` |
| `organization.primary_domain` | `domain` (nullable!) |
| `organization.website_url` | `website` |
| `organization.industry` | `industry` |
| `organization.keywords[]` | `keywords` |
| `organization.estimated_num_employees` | `employees` |
| `organization.city / country` | `city / country` |
| `employment_history`, `photo_url`, socials, `sic/naics_codes`, headcount-growth, phone | **discard** (Phase 1) |

**Upsert merge rule (critical):** Stage 1 created the org by `name` with no `apollo_org_id`. On bulk_match:
`SELECT WHERE apollo_org_id = $1` → found: update fields.
Else `SELECT WHERE lower(name) = lower($2) AND apollo_org_id IS NULL` → claim that row (set apollo_org_id + fill fields).
Else INSERT. This prevents org duplication between stages.

### 4.3 Firecrawl v2 → files + DB (Stage 2B)  [live response June 11]
| Path | Use |
|---|---|
| `success` | `false` → item failed, continue batch |
| `data.markdown` | write `{SCRAPES_DIR}/{yyyymmdd}/{org_id}.md`; **relative path** → `firecrawl_md_path` (never raw MD in DB — June 10) |
| `data.metadata.statusCode` | `>= 400` → treat as failure even when success:true |
| **`data.metadata.description`** (or `ogDescription`) | **extraction fallback tier 3** — live test gave a ready-made description ("Custom small batch polymer development, adhesives, tape, labels…") |
| `data.metadata.creditsUsed` | accumulate into response stats |
| redirect (requested `www.stipolymer.com`, served `stipolymer.com`) | normal — use returned markdown, do NOT overwrite our `domain` |

---

# 5. Batch-processing architecture (all 4 batch endpoints)

**Principles**
1. **State lives in the data, not a jobs table.** Pending sets are derivable:
   - not enriched ⇔ `lead_source='apollo' AND has_email=true AND email IS NULL`
   - not scraped ⇔ `has_scraped=false AND domain IS NOT NULL`
   - no draft ⇔ campaign_lead `crm_status='enriched' AND draft_id IS NULL`
   ⇒ every batch endpoint is **idempotent and resumable**. Crash mid-batch loses nothing; re-running picks up exactly what's left. This is the whole failure-recovery story — no queues, no job rows (don't over-engineer, per the senior).
2. **Per-item try/catch.** One bad item never aborts the loop. Batch responses: `{processed, succeeded, failed:[{id, stage, reason}], remaining}` — retry = call again.
3. **Chunked with caps.** Every batch endpoint accepts `limit` (default 50, max 200). Frontend/n8n loops until `remaining === 0`. Keeps each request inside serverless timeouts (`export const maxDuration = 300` on batch routes; on restrictive hosts use limit ≤ 20).
4. **Pacing (Phase 1 = sequential, correctness first):** Apollo bulk_match — 500 ms sleep between 10-item chunks (rate cap = 50% of per-minute enrichment limit). Firecrawl — 300 ms gap. LLM — sequential. Bounded concurrency is a Phase 2 optimization.

**5.1 `lib/http.ts` — fetchWithRetry**
- Timeouts (AbortController): Apollo 30 s · Firecrawl 60 s · LLM 90 s.
- Retry on 429, 5xx, network error: backoff 1 s → 3 s → 9 s (max 3 attempts), honor `Retry-After`.
- **Never** retry 400/401/402/403/404/422 — deterministic; surface immediately.

---

# 6. Endpoints — spec with edge cases

### 6.0 `GET /api/v1/health`
DB ping + env presence check → `{status:"ok", db:"ok", env:{apollo:true, firecrawl:true, openrouter:true, openai:true}}`.

### 6.1 Organizations
- `GET /organizations` — `?search=&industry=&has_scraped=&unsubscribed=&page=&limit=`; search ILIKE name+domain.
- `POST /organizations` — dedup: normalized domain (strip protocol/`www.`/trailing slash, lowercase) → else `lower(name)`. 409 `DUPLICATE` with existing id in `details`.
- `GET /organizations/:id` — org + its leads + scrape/draft status.
- `PATCH /organizations/:id` — whitelisted fields incl. `unsubscribed`. Setting `unsubscribed:true` blocks at read-time (6.5) — no cascade writes.
- `POST /organizations/:id/rescrape` — `has_scraped=false`. 404 if missing. The scrape endpoint + n8n interval do the rest (the June 10 manual re-scrape trigger).

### 6.2 Leads (manual + CRUD)
- `POST /leads` (manual): upsert org (6.1 dedup) → insert lead `lead_source:'manual'`, `apollo_id:'manual_'+crypto.randomUUID()` (satisfies UNIQUE without colliding with real ids). **Edges:** zod email format; existing email in `leads` → 409 with the existing lead id.
- `GET /leads` — joins `organizations(name, domain, unsubscribed)`; filters `country, email_status, lead_source, organization_id, email_domain_catchall`; pagination. Powers the CRM table.
- `PATCH /leads/:id` — person fields only (org fields via PATCH org).

### 6.3 `POST /leads/apollo-search`  (Stage 1)
```jsonc
{ "keyword":"plastics", "locations":["United States"], "max_pages":5, "titles":null, "seniorities":null }
```
Flow: keyword ∈ {plastics, polymer, moulding, packaging} (400 otherwise) → body from constants (10 titles; seniorities incl. `partner`,`head`; `include_similar_titles:false`; `contact_email_status:["verified","likely to engage"]`; `organization_num_employees_ranges:["10,200","200,1000"]`; `per_page:100`) → `locations` non-empty → `person_locations` (mapped via §3); else omit → pages 1..max_pages sequentially:
- per person: org upsert by name → `SELECT leads WHERE apollo_id` → skip or insert.
- stop early on empty `people`.

Returns `{ total_entries, pages_fetched, inserted, skipped_duplicate, orgs_created, orgs_reused }`.

**Edge cases:**
- Apollo 401 → 502 `UPSTREAM_APOLLO` "invalid or non-master key" (no retry).
- Apollo 422 → 502 with Apollo's message (bad filter combo).
- 429/5xx mid-loop, retries exhausted → **200 with progress so far** + `warning:"stopped at page N: <reason>"`. Inserted rows kept; rerun resumes safely (dedup).
- `total_entries: 0` → 200 + `warning:"no results — remove location or change keyword"` (the masterbatch/OR lesson).
- Same person across keyword runs → second run skips on apollo_id; cross-keyword merge is automatic.

### 6.4 `POST /leads/import-excel`  (Stage 1)
- Mode `headers` `{mode, storage_path}` → header row via `xlsx` from Supabase Storage → `{columns:[...]}`. **Edge:** unreadable/empty → 422.
- Mode `import` `{mode, storage_path, mapping}` → per row: trim → email regex → normalize domain → dedup **in-file** (Set) → dedup vs DB (`WHERE email = ANY($1)` in batches of 500) → org upsert by domain→name → insert `lead_source:'excel'`, `apollo_id:'excel_'+sha1(lower(email))` (**deterministic ⇒ re-importing the same file is idempotent**).
Returns `{ inserted, skipped_blank_email, skipped_invalid_email, skipped_duplicate_in_file, skipped_duplicate_in_db }` — exactly the counts the mapping UI shows.
**Edges:** mapping without `email` → 400. Email-only rows insert with NULL name (valid). Large files → insert in 500-row chunks. Test against the three real Kuber files (Bangladesh / Poland / Exhibition — all different headers).

### 6.5 Campaigns
- `POST /campaigns` — v5.1 fields; defaults `follow_up_pattern:[{"step":1,"delay":0}]`, `daily_limit:30`, `status:'draft'`; `instantly_campaign_id` NULL until Phase 2.
- `GET /campaigns`, `GET /campaigns/:id` — counters; detail joins memberships.
- `PATCH /campaigns/:id` — editable while `draft|processing`; includes `follow_up_pattern` (Phase 2 propagates to Instantly).
- `POST /campaigns/:id/leads` `{lead_ids:[...]}` — per id: missing → `not_found[]`; org `unsubscribed` → `blocked_unsubscribed[]` (**never insert**); existing membership (23505) → `skipped_existing[]`; else insert `crm_status:'new'`. Update `total_leads`. **Edges:** empty array → 400; campaign completed/paused → 409.
- `GET /campaigns/:id/leads?crm_status=` — junction + lead + org.

### 6.6 `POST /leads/enrich`  (Stage 2A — consumes credits)
```jsonc
{ "campaign_id":"uuid", "limit":50 }   // or { "lead_ids":[...] }
```
Target: `lead_source='apollo' AND has_email=true AND email IS NULL` (∩ campaign/ids) LIMIT limit.
Chunks of 10 → bulk_match (reveal params **in URL**, body `details:[{id, first_name, organization_name}]`) → per match: update lead per §4.2 (incl. `time_zone`, `email_domain_catchall`, `is_likely_to_engage ?? null`) → org upsert-merge (§4.2 rule) → campaign context: `crm_status = verified ? 'enriched' : 'skipped'`.
**Missing detection:** Apollo gives only a count — after each chunk, chunk ids still `email IS NULL` = that chunk's missing; collect into `missing_apollo_ids`.
Returns `{ requested, matched, missing_apollo_ids, credits_consumed, verified, unverified, remaining }`.

**Edge cases:**
- Credit exhaustion mid-loop (Apollo error) → stop, 200 with progress + `warning:"credits exhausted after N"`. Resumable.
- Match without email → stays NULL → remains in pending set. If still missing after 2 manual runs, UI labels "unenrichable" (no auto-retry storm).
- `email_domain_catchall:true` → store + CRM badge; do **not** auto-skip (client decision later).
- Excel/manual leads → excluded by `lead_source='apollo'`; they're considered enriched once their org is scraped (6.7 sets it).
- Concurrent double-invoke → second run's pending set excludes rows already filled. Safe.

### 6.7 `POST /enrichment/scrape`  (Stage 2B)
```jsonc
{ "all_pending":true, "limit":25 }   // or { "organization_ids":[...] } or { "campaign_id":"uuid" }
```
Target: `has_scraped=false AND domain IS NOT NULL` — **n8n hits this on an interval; together with the rescrape endpoint this IS the has_scraped loop from the June 10 meeting.**
Per org sequentially:
1. Scrape `https://{domain}` (Firecrawl v2, `formats:["markdown"]`, `onlyMainContent:true`); try `/about` too — success → concat with `\n\n---\n\n`, failure → silent.
2. Write MD file → `firecrawl_md_path` (relative).
3. Extract via §7 chain (input: first 12,000 chars of MD) → `{description, primary_products[]}`.
4. Update org + `has_scraped=true`.
5. Set campaign_leads of this org's **non-apollo** leads to `crm_status:'enriched'` (their enrichment is the org scrape).

Returns `{ scraped, skipped_no_domain, extraction_fallback_used, failed:[{org_id, stage:"scrape"|"extract", reason}], credits_used, remaining }`.

**Edge cases:**
- `success:false` / `statusCode>=400` / timeout → failed, `has_scraped` stays false → auto-retried next interval run (acceptable: spaced runs, 1 credit/attempt; failure-count cap is Phase 2 polish).
- Redirects (live-confirmed www→apex) → fine; keep our stored `domain`.
- Thin markdown (<300 chars: parked/JS-heavy site) → skip LLM → tier-3 fallback (`metadata.description`); if that's also empty → failed("thin content").
- MD > 12,000 chars → truncate before LLM (token/cost control); full MD stays on disk for reprocessing.
- NULL-domain orgs are never targeted — their leads ride the **no-domain path** (keywords+title personalization), never dropped.

### 6.8 Drafts (Stage 3)
**`POST /drafts/generate`** `{ "campaign_id":"uuid", "lead_ids":[...]? , "limit":25 }`
Target: campaign_leads `crm_status='enriched' AND draft_id IS NULL` (regeneration also targets drafts with `status='failed'`).
Per lead: insert draft `status:'generating'` → prompt = lead(first_name, title, seniority, country) + org(name, description, primary_products, keywords — whatever exists; no-domain leads get keywords+title only) + Kuber context block (constants: 30-yr masterbatch manufacturer, ISO 9001:2015, exports 50+ countries) → `llm.complete()` expecting `{subject, body}` → success: `status:'draft'`, set `campaign_leads.draft_id`, `crm_status:'draft'`; if campaign `human_in_loop=false` → straight to `approved`/`approved` counters. Final failure: `status:'failed'`.
Returns `{ generated, failed, auto_approved, llm_tier_stats, remaining }`.

**`GET /drafts?campaign_id=&status=draft`** — review queue, joins lead + org (draft + context side-by-side, per the meeting's review-UI requirement).
**`PATCH /drafts/:id`** — `{action:"approve"}` → `approved_at`, `reviewed_by`, junction `crm_status:'approved'` · `{action:"reject", rejection_reason}` · `{action:"edit", subject, body}` (stays `draft`). **Edges:** approve on non-draft → 409; edit after approve → 409 (reject first).
**Phase 1 ends at `approved`.**

---

# 7. `services/llm.ts` — fallback chain (OpenRouter → OpenAI → static)

```ts
async function complete(opts: { system: string; user: string }): Promise<{ json: object; tier: 1|2 }>
```
- **Tier 1 — OpenRouter** `POST https://openrouter.ai/api/v1/chat/completions`, model `LLM_PRIMARY_MODEL`. One integration, any model (June 10 decision).
- **Tier 2 — OpenAI direct** `POST https://api.openai.com/v1/chat/completions`, model `LLM_FALLBACK_MODEL`, `response_format:{type:"json_object"}`. Triggers: OpenRouter 401/402 (e.g. free-tier call limit from the meeting), 429/5xx after retries, network failure, or key unset.
- **Tier 3 — static (extraction only):** `description = metadata.description ?? ogDescription ?? null`, `primary_products = []`. **For drafting there is no tier 3** — a failed draft is marked `failed`, never auto-sent as template junk (quality rule: cold emails must be appropriate to the company context).

**JSON hardening (both tiers):** strip ``` fences → `JSON.parse` → on throw, extract first `{...}` block via regex and parse → still failing ⇒ escalate to next tier. zod-validate the shape (`{description:string, primary_products:string[]}` or `{subject:string, body:string}`); shape mismatch = failure. Every batch response reports `llm_tier_stats` / `extraction_fallback_used` so quality drift stays visible.

---

# 8. Build order for Cursor (every step ends runnable; gates from test.md §E)

| # | Build | Test gate |
|---|---|---|
| 1 | Scaffold + wrapper + middleware + `/health` + Swagger skeleton | health curl |
| 2 | Schema v5.1 SQL in Supabase (don't forget the **partial unique index on organizations.domain**) | psql sanity |
| 3 | constants.ts (titles / seniorities / §3 locations map / Kuber block) + `/meta/locations` | returns map |
| 4 | Organizations + Leads CRUD with dedup | 409 duplicate test |
| 5 | http.ts + apollo.searchPeople + `/leads/apollo-search` | run twice → 2nd run all `skipped_duplicate` |
| 6 | Excel import — against the 3 REAL Kuber files (headers all differ) | counts match files |
| 7 | Campaigns + attach (unsubscribed blocking) | blocked list correct |
| 8 | apollo.bulkMatch + `/leads/enrich` (2-3 leads — credits!) | `time_zone` + `email_domain_catchall` populated |
| 9 | firecrawl.ts + llm.ts (full chain) + `/enrichment/scrape` | MD on disk; tier stats logged |
| 10 | Drafts generate / queue / review | E2E: search→enrich→scrape→draft→approve |
| 11 | Swagger polish → send `/api-docs` to Lakshit | — |

**Phase 1 definition of done:** step-10 E2E passes on real data · re-running any batch endpoint mid-way is harmless · all three client Excel files import with correct skip counts · a no-domain lead still reaches an approved draft · failed scrapes self-heal on the next n8n interval run.

---

# 9. Phase 2 (reserved — do NOT build now)
- `POST /campaigns/:id/launch` — Instantly create: `campaign_schedule` from window/days/timezone; `sequences[0].steps[]` generated from `follow_up_pattern` (**only the first `sequences[]` element is used** — official constraint); `stop_on_reply:true`, `daily_limit`.
- `POST /campaigns/:id/sync-leads` — push approved drafts (`campaign`, `custom_variables` flat values only, `skip_if_in_workspace`).
- `POST /webhooks/instantly` — all_events → `reply_events`, idempotent on `event_uid`.
- Interest-status proxy (`POST /leads/update-interest-status` with `lead_email` + `interest_value`), counter updates, org-level `unsubscribed` automation on negative events.
