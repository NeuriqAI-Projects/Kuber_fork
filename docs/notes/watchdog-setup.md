# Running the watchdog on GitHub Actions — setup steps

This replaces `npm run watchdog` on your laptop with GitHub Actions, so the
background jobs keep running even when your laptop is off.

## What I already did (in the code)

I added two workflow files. You don't need to edit these:

- `.github/workflows/watchdog.yml` — calls **enrichment-watchdog** every 15 minutes
- `.github/workflows/retry-failed-orgs.yml` — calls **auto-retry-failed-orgs** every 3 hours

(The third job, `reconcile-counters`, already runs once a day on Vercel — see
`vercel.json` — so it is not here.)

These files do nothing until they are **on GitHub** and the **two secrets below
are set**. Follow the steps in order.

---

## Step 1 — Find your deployed app URL

This is the **live Vercel address**, e.g. `https://kuber.vercel.app`.

- **Not** the `ngrok` URL, and **not** `localhost`.
- Get it from the Vercel dashboard → your Kuber project → the production domain
  at the top.
- Copy it **without** a trailing slash (`https://kuber.vercel.app`, not
  `https://kuber.vercel.app/`).

Keep this handy for Step 2.

---

## Step 2 — Add two secrets in GitHub (the manual part)

In your browser:

1. Go to the repo: **https://github.com/dranzer-17/Kuber**
2. Click **Settings** (top menu of the repo).
3. In the left sidebar: **Secrets and variables → Actions**.
4. Click the green **New repository secret** button. Add the first secret:
   - **Name:** `APP_URL`
   - **Secret:** the URL from Step 1 (e.g. `https://kuber.vercel.app`)
   - Click **Add secret**.
5. Click **New repository secret** again. Add the second secret:
   - **Name:** `INTERNAL_SECRET`
   - **Secret:** copy the value labelled `INTERNAL_SECRET` from your
     `Kuber/.env.local` file.
   - Click **Add secret**.

> ⚠️ The `INTERNAL_SECRET` you paste here **must be identical** to the
> `INTERNAL_SECRET` set in your Vercel project's Environment Variables. If they
> don't match, every run will fail with `HTTP 401`. (Vercel dashboard → project →
> Settings → Environment Variables — check it's the same value.)

When done you should see two secrets listed: `APP_URL` and `INTERNAL_SECRET`.
GitHub hides their values after saving — that's normal.

---

## Step 3 — Push the workflow files to GitHub

The files exist on your machine but GitHub can't see them until you push. In a
terminal inside the `Kuber` folder:

```bash
git fetch origin
git pull --rebase origin main        # get any of Kavish's latest changes first
git add .github/workflows/watchdog.yml .github/workflows/retry-failed-orgs.yml watchdog-setup.md
git commit -m "Run watchdog + retry jobs via GitHub Actions"
git push origin main
```

> Someone else also pushes to this repo, so the `fetch` + `pull --rebase` first
> avoids a rejected push. If the push is still rejected, run
> `git pull --rebase origin main` again, then `git push`.

*(Tell me if you'd rather I run these git commands for you instead.)*

---

## Step 4 — Check Actions is on and see your workflows

1. Go to the **Actions** tab of the repo.
2. If GitHub shows a "Workflows aren't being run on this repository" banner,
   click the button to **enable Actions** (public repos usually have it on
   already, so you may not see this).
3. In the left sidebar you should now see **Enrichment watchdog** and
   **Retry failed orgs**.

---

## Step 5 — Test it right now (don't wait for the timer)

1. **Actions** tab → click **Enrichment watchdog** in the left sidebar.
2. On the right, click the **Run workflow** dropdown → **Run workflow** (green
   button). This runs it immediately by hand.
3. Refresh after ~20 seconds. A new run appears.
   - **Green tick ✅** = working. Click into it → the log should end with
     `HTTP 200`.
   - **Red X ❌** = something's off. Click in and read the error:
     - `HTTP 401` → the `INTERNAL_SECRET` secret doesn't match Vercel's.
     - `HTTP 404` / connection error → the `APP_URL` secret is wrong.
     - "secrets are not set" → you skipped Step 2.
4. Do the same test for **Retry failed orgs** to confirm both.

After this, they run automatically on their timers — nothing more to do.

---

## Good to know

- **Timing is approximate.** GitHub's scheduler is best-effort; a run can be a
  few minutes late or, rarely, skipped. That's fine — these are safety nets, not
  deadlines.
- **The 60-day rule.** On a repo with no recent commits, GitHub pauses scheduled
  workflows after 60 days (it emails you first). Any new commit wakes them up.
- **Failure emails.** If the app is down, a run fails and GitHub emails you.
  That's the point — but it can get noisy during an outage.
- **Keep using `npm run watchdog` while developing.** It hits `localhost`; these
  workflows hit the deployed app. Both can run at once — the jobs are no-ops when
  there's no work, so double-pinging is harmless.
- **If every run 401s even though secrets look right:** check the Vercel project
  doesn't have "Deployment Protection / Vercel Authentication" turned on for the
  production URL — that would block outside callers before they reach the app.

---

## How to change the schedule later

Edit the `cron:` line in the relevant file and push:

- `.github/workflows/watchdog.yml` → `"*/15 * * * *"` = every 15 min
- `.github/workflows/retry-failed-orgs.yml` → `"0 */3 * * *"` = every 3 hours

Cron format is `minute hour day month weekday`, in **UTC**.
