# Running Kuber locally

Three things need to be running at the same time for the app to work properly
and for enrichment to keep itself going in the background. Each one goes in
its **own terminal window**, left open.

## 1. Start the app

```
npm run dev
```

Leave this running. The app is now live at `http://localhost:3000`.

## 2. Start ngrok (only if you need to open the app from another device, e.g. your friend's browser)

```
ngrok http 3000
```

This prints a URL like `https://xxxx-xx-xx-xx-xx.ngrok-free.app` — that's the
link you or your friend open in a browser.

**Important:** the free ngrok URL changes every time you restart ngrok. When
that happens:
1. Copy the new `https://....ngrok-free.app` URL ngrok prints.
2. Open `.env.local`, replace the value of `NEXT_PUBLIC_APP_URL` with it.
3. Stop and restart `npm run dev` (terminal 1) so it picks up the change.
4. **Re-register the webhook with Instantly:** `node scripts/register-webhook.mjs`

**Step 4 is not optional, and steps 2–3 do not cover it.** Instantly stores the
webhook address as a full absolute URL on *its* servers — it cannot know your
tunnel moved. `NEXT_PUBLIC_APP_URL` only affects calls the app makes back to
itself, so editing it never reaches Instantly. Skip step 4 and replies stop
arriving completely: nothing errors, the app just looks idle, and replies only
show up if you press Sync by hand. (This is exactly what happened Jul 9–17 —
the webhook sat dead for 8 days.)

Check what Instantly currently calls, and whether it is healthy:

```
curl -s "https://api.instantly.ai/api/v2/webhooks?limit=50" \
  -H "Authorization: Bearer $INSTANTLY_API_KEY"
```

`status: 1` is healthy; `status: -1` means Instantly disabled it after failures —
that does **not** recover on its own once the URL works again, so delete it and
register a fresh one. Several webhooks can coexist (one URL each), which is how
two people can both receive events on their own tunnels.

**To stop doing this every restart:** use a reserved ngrok domain, which never
changes — `ngrok http --url=your-domain.ngrok-free.dev 3000`. Then you register
once and never touch it again. Deploying to a real fixed domain removes ngrok,
and this whole step, entirely.

If you're only using the app yourself on this same machine, you can skip
ngrok entirely and just use `http://localhost:3000` — but note that inbound
Instantly replies will not reach you without a tunnel.

## 3. Start the enrichment watchdog

```
npm run watchdog
```

This is what keeps lead enrichment (finding emails, scraping company
websites) running reliably in the background — without it, if the
enrichment process ever silently stops (it has, more than once), nothing
brings it back until this script or a new import nudges it again. Leave it
running the whole time you're using the app. It's safe to leave running for
hours — it does nothing when there's no work waiting.

## Stopping everything

`Ctrl+C` in each of the three terminals.

## Quick health check

If you want to confirm enrichment is actually alive, watch the `npm run
watchdog` terminal — every 15 minutes it logs a line like:

```
[timestamp] watchdog -> 200 { triggered: true }
```

Every 3 hours it also logs an `auto-retry` line. If either of these ever
shows a repeated error instead of a 200, that's the signal something's
actually wrong — otherwise the pipeline is healthy even if it looks quiet.

## First-time setup (only needed once, skip if already done)

```
npm install
```

Requires `.env.local` to already be filled in (Supabase keys, Apollo key,
Firecrawl key, `INTERNAL_SECRET`, etc.) — ask whoever set up the project if
it's missing.
