# Keeping the background jobs alive after deploying

## The problem in one line

`npm run watchdog` runs on **your laptop**. Close the terminal, shut the lid, or
lose wifi, and nothing pokes the app any more.

## What actually needs to run

The watchdog is not doing heavy work. It is just **calling three URLs on a
timer**. All the real work happens on the server. That is why almost any timer
in the world can do this job.

| What | How often | URL |
|---|---|---|
| Enrichment watchdog | every 15 min | `/api/internal/enrichment-watchdog` |
| Retry failed orgs | every 3 hours | `/api/internal/auto-retry-failed-orgs` |
| Reconcile counters | once a day | `/api/internal/reconcile-counters` |

The last one is already handled by Vercel Cron (see `vercel.json`). The first
two are the ones currently stuck on your laptop.

**Why it matters:** these are safety nets. The app normally keeps itself going
by chaining one job to the next, but that chain has silently died before
(server stayed up, work just stopped). The watchdog notices and restarts it.
Since this week it *also* revives stalled bulk draft-regeneration jobs, so
without it a stuck regeneration would block that campaign forever.

**Good news:** being a few minutes late is fine. Nothing breaks if the 15-minute
ping arrives at 19 minutes. This is a safety net, not a deadline. That fact
makes the cheap options perfectly good.

---

## Option 1 — GitHub Actions (what you asked about) ✅ Recommended

**It works, and for you it is free**, because `dranzer-17/Kuber` is a **public**
repo — public repos get unlimited Actions minutes. (On a private repo this would
be a problem: a ping every 15 minutes is about 2,880 runs a month, and the free
private-repo allowance is 2,000 minutes. Worth remembering if you ever make the
repo private.)

**Why it is nice:** the schedule lives in your repo, next to the code. Anyone can
see it, change it, and review it in a pull request. Nothing extra to sign up for.

Create `.github/workflows/watchdog.yml`:

```yaml
name: Watchdog

on:
  schedule:
    - cron: "*/15 * * * *"   # every 15 minutes
  workflow_dispatch:          # lets you also run it by hand from the Actions tab

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Enrichment watchdog
        run: |
          curl -fsS -X POST "$APP_URL/api/internal/enrichment-watchdog" \
            -H "x-internal-secret: $INTERNAL_SECRET"
        env:
          APP_URL: ${{ secrets.APP_URL }}
          INTERNAL_SECRET: ${{ secrets.INTERNAL_SECRET }}

      # This step runs every 15 min too, but only actually calls the URL when
      # the hour divides by 3 and we are in the first quarter of it. Simpler
      # than maintaining a second workflow file.
      - name: Retry failed orgs (every 3h)
        run: |
          H=$(date -u +%H); M=$(date -u +%M)
          if [ $((10#$H % 3)) -eq 0 ] && [ "$M" -lt 15 ]; then
            curl -fsS -X POST "$APP_URL/api/internal/auto-retry-failed-orgs" \
              -H "x-internal-secret: $INTERNAL_SECRET"
          else
            echo "not the 3-hourly slot, skipping"
          fi
        env:
          APP_URL: ${{ secrets.APP_URL }}
          INTERNAL_SECRET: ${{ secrets.INTERNAL_SECRET }}
```

Then in GitHub: **Settings → Secrets and variables → Actions → New repository
secret**, add two secrets:

- `APP_URL` — your deployed address, e.g. `https://kuber.vercel.app`
  (**not** ngrok, **not** localhost)
- `INTERNAL_SECRET` — the same value as in your `.env.local`

**The honest downsides:**

- GitHub's timer is **best effort**. When GitHub is busy your job can run 10–30
  minutes late, and occasionally a run is skipped entirely. Fine for a safety
  net, not fine for something that must be punctual.
- On a public repo, GitHub **turns scheduled workflows off after 60 days with no
  activity** in the repo. You get an email first. Any commit wakes it up again.
- A failed curl sends you a failure email. Useful, but can get noisy if the app
  is down for a while.

---

## Option 2 — Let Supabase do it (most reliable)

Your database is **always awake** — it does not sleep like a laptop and does not
get delayed like GitHub. It can call your app on a schedule all by itself.

I checked your project: the two extensions needed (`pg_cron` and `pg_net`) are
**available but not switched on yet**.

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'enrichment-watchdog',
  '*/15 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR-APP.vercel.app/api/internal/enrichment-watchdog',
    headers := '{"x-internal-secret": "YOUR_INTERNAL_SECRET"}'::jsonb
  );
  $$
);
```

**Good:** nothing extra to pay for, nothing extra to sign up for, and it fires on
time. Best choice if you ever need the timing to actually be reliable.

**Downsides:** the schedule lives inside the database instead of in your code, so
it is easy to forget it exists. And your secret sits in the database — fine here,
but do not paste it into a public place.

---

## Option 3 — A free cron ping website

Sites like **cron-job.org** exist purely to call a URL on a timer. You paste the
URL, add the `x-internal-secret` header, pick "every 15 minutes", done. Takes
about two minutes and needs no code at all.

**Good:** fastest thing to set up. Shows you a nice history of every call.

**Downside:** one more account and one more thing that can quietly stop working.
If it dies, nothing tells you.

---

## Option 4 — Pay Vercel

Vercel's free (Hobby) plan only allows **once-a-day** cron jobs. That is exactly
why the 15-minute jobs were deleted from `vercel.json` before deploying — see
commit `48a3195`, "Drop sub-daily crons for the initial Vercel Hobby-plan deploy".

Upgrading to Pro lets you put them straight back:

```json
{
  "crons": [
    { "path": "/api/internal/reconcile-counters",  "schedule": "30 2 * * *" },
    { "path": "/api/internal/enrichment-watchdog", "schedule": "*/15 * * * *" },
    { "path": "/api/internal/auto-retry-failed-orgs", "schedule": "0 */3 * * *" }
  ]
}
```

**Good:** cleanest possible answer — one file, no outside service, and the app
looks after itself. **Downside:** it costs money. Check Vercel's current pricing
and cron limits before deciding; plan rules change.

---

## What I would do

**Start with GitHub Actions.** It is free for this repo, it lives with your code,
and "sometimes runs late" genuinely does not matter for a safety net.

**Switch to Supabase pg_cron** if you later find the delays annoying, or if the
60-day auto-disable bites you.

**Pay for Vercel Pro** only when the project is earning its keep and you want one
less moving part.

---

## Two things to remember whichever you pick

1. **Use the deployed URL, not ngrok.** ngrok is only for getting Instantly's
   replies into your laptop while developing. A scheduled job must call the real
   deployed address.
2. **`npm run watchdog` is still the right tool while developing.** Keep using it
   locally. The options above are for the deployed app, and the two can happily
   run at the same time — these jobs do nothing when there is no work waiting, so
   double-pinging is harmless.

