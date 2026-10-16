# AI scoring real-credit test: findings (16 Oct 2026)

Full report: open `index.html` (same folder). Spend: **37 of 50 Apollo credits**, 126 Firecrawl credits, about $0.011 of Jev.
TC-8 (real end-to-end with email reveals) was **not run**: it writes real leads into the client's workspace and needs approval.

## Answers

| Question | Answer |
|---|---|
| Is the AI accurate? | 91% of "good fit" were real plastic makers (51 of 56 judged; 82% if the 6 unclear count as wrong). It hid 0 real makers out of 64. Only 1.6% needed a human. Labels came from one AI reviewer reading page excerpts, 129 companies. |
| Are the keywords on topic? | Some are not. Poor in our sample: blown film, compounding, pipe, masterbatch, agricultural film (0 of 5 real customers each). Good: PP sheets, rotational molding, stretch film, plastic film. |
| How many companies per keyword? | From 2 ("Thermoformings") to 39,806 ("pipe"). Big words are mostly not plastic processors. About 38 of every 100 on page 1 are already in the client's database. |
| How many leads per search? | About **19** (about 30 on the best keywords): 62 new companies x 99% read x 48% good x 65% with an emailable person. |
| Can we give 200 / 300 / 400 leads? | Not from one search. About 11 / 16 / 21 searches across different keywords or pages. "100 leads per batch" is too high for one search; "100 companies per batch" is realistic. |
| Do deeper pages hold quality? | Yes: pages 2, 5, 10 of "stretch film" had 5, 5, 4 plastic makers out of 8. The wizard only asks for page 1, so a repeat search finds nothing new. |

## Findings

1. Apollo charging is as assumed: 1 credit per page with results, 0 for an empty page, 0 for People Search.
2. Apollo combines several keywords with OR (group total is at least the largest word).
3. Two Settings keywords are broken: "Thermoformings" (2 companies), "Plastic Injection MoldingS" (6). Duplicates: "Plastic Pallets"/"plastic pallets", "masterbatch" twice in one group.
4. Cookie-banner page text passes the 20-word check, so the AI guesses from the company name (3 of the 6 unclear good fits).
5. Big or mixed companies fool it (Sasol, Sanmina, Jabil, TAFE, a mould maker).
6. 35% of good companies (27 of 77) have no emailable person. The contact picked is often not a buyer.
7. The automatic-reveal limit (20 per search) is below the roughly 30 good fits per search.
8. Firecrawl dropped 126 credits for 142 reads; Tavily's balance showed no drop after 36 calls. Worth checking in Settings > Keys > Usage.

## Recommendations

1. Fix or replace the poor keywords (use product words a processor writes about itself).
2. Treat cookie-banner, error and placeholder text as "no text".
3. Add a "next 100 companies" page option to the wizard.
4. Raise the auto-reveal limit when volume matters.
5. Keep the cut-offs (0.65 / 0.35): precision 91%, no missed customers.
6. Tell the client: one search is about 100 companies and 19 to 30 leads.

## Limits

Small samples (4 to 5 per keyword); one AI reviewer; 28 of 63 keywords and 4 groups run because of the 50-credit cap; raw Apollo payloads and people data are kept locally, not in git (public repo).
