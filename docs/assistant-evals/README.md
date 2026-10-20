# Kuber AI — evals

38 real questions, run through the real agent against the **Dev company's live data**.
Each case is graded three ways:

1. **Hard checks** — the right tool was called with the right filters, and the number in
   the answer equals the number computed straight from the database (e.g. "1,657 enriched
   leads not in any campaign"). Security cases check scope (an employee sees 34 leads, not
   2,537; another company's lead id is "not found").
2. **Database unchanged** — row counts (campaigns, campaign leads, notes, reply drafts,
   assignments, paused campaigns, drafts) are taken before and after the run. Questions
   and confirm cards must change nothing.
3. **AI judge** — Claude Sonnet 5.5 scores each answer 1–5 against the tool results and a
   per-case rubric. A case passes with all hard checks green **and** a judge score ≥ 4.

Covered skills: find leads (incl. follow-up questions), lead 360, ambiguous names,
companies, campaign status / comparison, inbox (needs reply, interested, thread summary),
drafts, team, activity, AI spend, "what should I do today", every action card (create
campaign, add to campaign, assign, reveal emails with Apollo cost, pause, never-send,
note), employee scope, company isolation, prompt injection, off-topic, Deep mode, and a
second provider (OpenRouter).

Action cases stop at the confirm card — no Apollo or Instantly call is ever made.
Pressing **Confirm** was tested by hand in the app (created a `[TEST]` draft campaign with
67 leads; 67 activity rows logged like the normal UI; then soft-deleted).

## Run it

```bash
npx tsx --env-file=.env.local scripts/assistant-eval/run.mts
```

Options: case ids (`run.mts E03 E19`), `--deep`, `--no-judge`, `EVAL_FAST_MODEL=claude-sonnet-5-5` /
`EVAL_DEEP_MODEL=…` (compare models), `EVAL_TAG=name` (output file name). Writes `<tag>.md` and
`<tag>.json` here — **git-ignored**: they hold real lead names, emails and reply text, and this
repo is public. The people, companies and campaigns each case asks about are picked from the
Dev data at run time, so none are written into the code either. About 2 minutes and ~$0.65 per full run, on the Dev company's own AI keys.

Unit tests (no network):

```bash
npx tsx --test lib/services/assistant/lead-filter.test.mts
npx tsx --test lib/services/assistant/models.test.mts
npx tsx --test lib/services/assistant/actions.test.mts
npx tsx --test lib/assistant-markdown.test.mts
```

## Results (20 Oct 2026)

**Shipped defaults** — Fast = Claude Haiku 5.5, Deep = Claude Sonnet 5.5 (latest, 38 cases):

| Cases passed | Hard checks | Judge avg | Fast: first output p50 | Fast: answer p50 / p90 | Deep: answer p50 | Database | Cost / run |
|---|---|---|---|---|---|---|---|
| **32/38** (84%) | **70/70** | 4.18 | 1.5 s | 5.4 s / 7.2 s | 26 s | unchanged | $0.75 |

Fast cases pass 28/32 and Deep cases 4/6 in this run (judge scores vary a little run to run).

**Fast mode: Haiku 5.5 vs Sonnet 5.5** (full 34-case suite, earlier prompt):

| Fast model | Passed | Judge avg | Answer p50 / p90 | Cost / run |
|---|---|---|---|---|
| Haiku 5.5 (run) | 27/34 | 4.03 | 4.8 s / 7.5 s | $0.98 |
| Sonnet 5.5 (run) | 29/34 | 4.15 | 6.8 s / 13.1 s | $1.80 |

With the final prompt Haiku reached 29/34, so Fast stays on Haiku: same quality, faster, ~1/20th the token price.

**Deep mode: Opus 5.5 vs Sonnet 5.5** (6 deep cases, 2 rounds each = 12 answers per model):

| Deep model | Passed | Judge avg | Answer p50 | Cost (both rounds, incl. judge) |
|---|---|---|---|---|
| Opus 5.5 (r1, r2) | 5/12 | 3.42 | ~37 s | $2.18 |
| Sonnet 5.5 (r1, r2) | **7/12** | **3.58** | **~23 s** | **$0.98** |

So Deep uses **Sonnet 5.5**: Opus was slower and more expensive with no quality gain.
Chat titles use the cheapest model. An admin can change Fast/Deep per provider in
**Credits > AI > Kuber AI models**.

**Timings** were measured from a laptop in India to the Supabase database, so every
query pays a long round-trip. On Vercel, next to the database, the tool part of each
answer is faster.

**Known weak spots.** Deep answers (any model) are useful but the judge often scores them 3:
they add up numbers by hand and sometimes get a total wrong, or skip a per-person
recommendation the rubric wants. Fast answers sometimes open with a "Let me check…" line
or add a small unsupported remark, and results vary a little run to run (the same case can
score 3 one run and 5 the next). All hard checks — numbers, scope, safety, nothing changed —
pass every run. Re-run after changing the prompt (`lib/services/assistant/prompt.ts`) or
tools, and compare to `latest.md`.
