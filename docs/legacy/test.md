# test.md — Kuber Polyplast | Phase 1 Live API Tests
> Run these BEFORE building each backend module. Paste responses back so backend.md field mappings stay verified against reality, not docs.
> Replace `$APOLLO_KEY`, `$FIRECRAWL_KEY`, `$OPENROUTER_KEY` with real keys. Never commit keys.

---

## A. APOLLO — Stage 1 Search (free, no credits)

### A1. Credit / usage check (run first — confirms key is MASTER type)
```bash
curl --request GET \
  --url 'https://api.apollo.io/api/v1/usage_stats/api_usage_stats' \
  --header 'x-api-key: $APOLLO_KEY'
```
**Verify:** response shows credit quotas. A standard (non-master) key fails on the search endpoints below.

### A2. Baseline search — "plastics" worldwide (KNOWN GOOD: 971 results on Jun 7)
```bash
curl --request POST \
  --url 'https://api.apollo.io/api/v1/mixed_people/api_search' \
  --header 'Cache-Control: no-cache' \
  --header 'Content-Type: application/json' \
  --header 'accept: application/json' \
  --header 'x-api-key: $APOLLO_KEY' \
  --data '{
    "person_titles": ["purchase manager","procurement manager","plant manager","managing director","production manager","procurement head","purchase officer","technical manager","proprietor","founder"],
    "person_seniorities": ["owner","founder","c_suite","partner","vp","head","director","manager"],
    "q_keywords": "plastics",
    "organization_num_employees_ranges": ["10,200","200,1000"],
    "contact_email_status": ["verified","likely to engage"],
    "include_similar_titles": false,
    "per_page": 5,
    "page": 1
  }'
```
**Verify:** `total_entries` ≈ 971+ · `people[].id` present · `last_name_obfuscated` (NOT last_name) · `has_email` flag · NO email/domain/linkedin in response.

### A3. ⚠ COUNTRY FILTER TEST — the open question from the Jun 7 meeting
Same body as A2 plus `person_locations`. Run once per priority country:
```bash
#  add inside the JSON body:
    "person_locations": ["Poland"],
```
Repeat with `["India"]`, `["Bangladesh"]`, `["United Arab Emirates"]`.
**Decision rule:** if `total_entries > 0` → country filter ships in the UI (maps to `person_locations[]`). If 0 for valid countries → UI keeps country as display/timezone field only, search stays worldwide. **Record each count here:**
| Country | total_entries |
|---|---|
| Poland | |
| India | |
| Bangladesh | |
| UAE | |

### A4. Per-keyword pool sizes (fill the table — sets expectations for dedup volume)
Run A2 changing only `q_keywords`:
| q_keywords | total_entries | Note |
|---|---|---|
| plastics | 971 (Jun 7) | buyers ✅ |
| polymer | | |
| moulding | | |
| packaging | | |
| masterbatch | 12 (Jun 7) | competitors — never use ❌ |
**Reminder:** `"masterbatch OR polymer"` → 0. No OR, ever. One keyword per job, merge on `people[].id`.

### A5. Pagination sanity
A2 with `"page": 2` → different `people[].id` values, same `total_entries`.

---

## B. APOLLO — Stage 2A bulk_match (⚠ CONSUMES CREDITS — 1/match, run with 2-3 ids only)

### B1. Bulk match using real ids from A2
```bash
curl --request POST \
  --url 'https://api.apollo.io/api/v1/people/bulk_match?reveal_personal_emails=false&reveal_phone_number=false' \
  --header 'Cache-Control: no-cache' \
  --header 'Content-Type: application/json' \
  --header 'accept: application/json' \
  --header 'x-api-key: $APOLLO_KEY' \
  --data '{
    "details": [
      { "id": "PASTE_people[].id_FROM_A2" },
      { "id": "PASTE_ANOTHER_id" }
    ]
  }'
```
**Verify against schema v5 mappings:**
- top level: `status:"success"`, `unique_enriched_records`, `missing_records`, `credits_consumed`
- `matches[].email` + `matches[].email_status` ("verified" gate)
- `matches[].last_name` now UNOBFUSCATED
- `matches[].organization_id` → organizations.apollo_org_id
- `matches[].organization.primary_domain` → organizations.domain — **note how often this is null for plastics SMEs** (drives the no-domain path)
- `matches[].organization.keywords[]` → organizations.keywords
- query params in URL (body placement is silently ignored — confirm by checking no personal emails returned)

### B2. Single match (manual-entry path)
```bash
curl --request POST \
  --url 'https://api.apollo.io/api/v1/people/match' \
  --header 'Content-Type: application/json' \
  --header 'x-api-key: $APOLLO_KEY' \
  --data '{ "first_name": "PASTE", "organization_name": "PASTE", "domain": "PASTE_IF_KNOWN" }'
```

---

## C. FIRECRAWL — Stage 2B scrape (v2 API, verified Jun 2026)

### C1. Homepage → markdown (use a real org domain from B1)
```bash
curl -X POST 'https://api.firecrawl.dev/v2/scrape' \
  -H 'Authorization: Bearer $FIRECRAWL_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://EXAMPLE-PLASTICS-DOMAIN.com",
    "formats": ["markdown"],
    "onlyMainContent": true
  }'
```
**Verify:** `{ "success": true, "data": { "markdown": "...", "metadata": {...} } }`.
**Record:** markdown size in KB (justifies file-storage decision — these get big) · whether `onlyMainContent:true` strips nav/footer junk well for typical SME plastics sites.

### C2. /about page
Same as C1 with `"url": "https://DOMAIN.com/about"`.
**Verify:** 404 sites still return success:false or error — backend must treat /about as optional (concat only when present).

### C3. Save to disk exactly like the backend will
```bash
curl -s -X POST 'https://api.firecrawl.dev/v2/scrape' \
  -H 'Authorization: Bearer $FIRECRAWL_KEY' -H 'Content-Type: application/json' \
  -d '{"url":"https://DOMAIN.com","formats":["markdown"],"onlyMainContent":true}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['markdown'])" \
  > ./scrapes/test/DOMAIN.md
```

---

## D. OPENROUTER — extraction + drafting (model swappable per meeting)

### D1. Extraction test (feed C3's markdown)
```bash
curl -X POST 'https://openrouter.ai/api/v1/chat/completions' \
  -H 'Authorization: Bearer $OPENROUTER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "anthropic/claude-sonnet-4.5",
    "messages": [
      { "role": "system", "content": "You extract company facts for B2B sales. Return ONLY valid JSON, no markdown fences: { \"description\": string (2-3 sentences: what they manufacture and who they sell to), \"primary_products\": string[] }" },
      { "role": "user", "content": "PASTE_FIRST_3000_CHARS_OF_MD_HERE" }
    ]
  }'
```
**Verify:** parseable JSON · `primary_products` is an ARRAY (schema v5) · description usable in a cold email.

### D2. Draft test (the Stage 3 prompt, end to end)
Same endpoint; system: "Write a cold outreach email from Kuber Polyplast (Indian masterbatch & specialty compounds manufacturer, 30 years, exports to 50+ countries) to the lead below. Return ONLY JSON {\"subject\": string, \"body\": string}. Reference their products specifically. Under 120 words, no placeholders."
User content: `{ first_name, title, company: { name, description, primary_products } }` from B1 + D1 output.
**Verify:** quality is client-presentable; if weak, iterate the prompt here BEFORE coding `services/drafts.ts`.

---

## E. INTERNAL API SMOKE TESTS (after each backend.md build step)
```bash
BASE=http://localhost:3000/api/v1

curl $BASE/health                                                          # step 1
curl -X POST $BASE/organizations -H 'Content-Type: application/json' \
  -d '{"name":"Test Plastics Ltd","domain":"testplastics.com"}'            # step 3
curl -X POST $BASE/organizations -H 'Content-Type: application/json' \
  -d '{"name":"Test Plastics Ltd","domain":"testplastics.com"}'            # → 409 dedup
curl -X POST $BASE/leads/apollo-search -H 'Content-Type: application/json' \
  -d '{"keyword":"plastics","max_pages":1}'                                # step 4
curl -X POST $BASE/leads/apollo-search -H 'Content-Type: application/json' \
  -d '{"keyword":"plastics","max_pages":1}'                                # → all skipped_duplicate
curl -X POST $BASE/leads/enrich -H 'Content-Type: application/json' \
  -d '{"lead_ids":["UUID1","UUID2"]}'                                      # step 7 (credits!)
curl -X POST $BASE/enrichment/scrape -H 'Content-Type: application/json' \
  -d '{"all_pending":true}'                                                # step 8
curl -X POST $BASE/drafts/generate -H 'Content-Type: application/json' \
  -d '{"campaign_id":"UUID"}'                                              # step 9
curl "$BASE/drafts?status=draft"                                           # review queue
```
(Add the Supabase JWT header once middleware is on: `-H "Authorization: Bearer $SUPABASE_JWT"`.)

---

## Sign-off checklist before coding each module
- [ ] A1-A5 run, country table filled, keyword table filled
- [ ] B1 run on 2-3 ids — domain-null rate noted
- [ ] C1-C3 run on 2 real domains from B1 — MD sizes noted
- [ ] D1-D2 outputs reviewed for quality
- [ ] All responses pasted back into the project chat for field-mapping verification
