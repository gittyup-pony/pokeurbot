# laz-stock-watcher (multi-user)

A read-only Telegram bot that lets anyone message it and add their own Lazada product URLs to watch. When a product flips from out-of-stock to in-stock, everyone watching that URL gets pinged. It never touches cart, login, or checkout — you still do the actual purchase yourself.

## How it's different from the single-user version

- No fixed `TELEGRAM_CHAT_ID` or `PRODUCT_URLS` in `.env` anymore — instead, each person who messages the bot manages their own list via commands.
- A product URL watched by 5 people is only **fetched once** per poll cycle, then the alert fans out to all 5 — not 5 separate requests.
- Subscriber lists and stock state live in `data.json` instead of `state.json`.

## Commands

| Command | What it does |
|---|---|
| `/start` | Welcome message |
| `/watch <url>` | Add a Lazada product URL to your list |
| `/unwatch <url>` | Remove one |
| `/list` | Show what you're currently watching |
| `/help` | Show commands |

## Library note

Built on `telegraf` (actively maintained, zero known vulnerabilities as of this writing) rather than `node-telegram-bot-api`, which pulls in the deprecated `request` library and its outdated transitive dependencies. Run `npm audit` any time to confirm it's still clean.

## Setup

1. **Create a Telegram bot** via [@BotFather](https://t.me/BotFather) -> `/newbot` -> copy the token.
2. Copy `.env.example` to `.env` and fill in `TELEGRAM_BOT_TOKEN`.
3. Install and run:
   ```bash
   npm install
   npm start
   ```
4. Message your bot on Telegram, send `/watch <a Lazada product URL>`, then `/list` to confirm.

Anyone who knows your bot's username can now add themselves and their own product URLs — no code changes needed per person.

## Deploying to Render (free Web Service, not a paid Background Worker)

Render's free tier only covers Web Services and static sites — Background Workers require a paid plan (from $7/month). So this deploys as a **Web Service** instead, using the same self-ping pattern as `picklebolbot`:

- The bot runs a minimal HTTP server (just responds "alive" to any request) so Render recognizes it as a web service.
- It self-pings its own `RENDER_EXTERNAL_URL` every 10 minutes — Render sets this environment variable automatically, no manual config needed — which keeps the free instance from spinning down after 15 minutes of inactivity.
- Telegram's `/watch` commands still work fine — the bot uses `polling: true` (an outbound long-poll connection to Telegram), which is unrelated to the HTTP server and needs no public webhook.

**Render setup:**
- New → **Web Service** (not Background Worker) → connect the `laz-stock-watcher` repo.
- Build Command: `npm install`
- Start Command: `npm start`
- Instance Type: **Free**
- Environment variables: `TELEGRAM_BOT_TOKEN`, `POLL_INTERVAL_SECONDS` (`30`), `DB_FILE` (`./data.json`). Don't set `PORT` or `RENDER_EXTERNAL_URL` — Render provides both automatically.

**Trade-off**: the first request after any spin-down (rare, since self-ping should prevent it) takes about a minute to wake up. In practice this only matters if the self-ping somehow fails for over 15 minutes straight — worth checking Render's logs occasionally to confirm the ping is firing.

## Data persistence caveat

`data.json` lives on Render's ephemeral filesystem — a redeploy wipes it, meaning subscribers and their watch lists would be lost. For a handful of friends this is a minor inconvenience (everyone just re-runs `/watch`), but if you want it to survive redeploys:

- Swap `db.js` for a hosted key-value store (Upstash Redis's REST API works well and needs no extra native dependencies, same as the axios-only approach used here), or
- Add a Render **persistent disk** (available on paid plans) mounted at the `data.json` path.

Worth doing this only if you're expecting the bot to be actively used by others long-term — otherwise the simple JSON file is fine to start with.

## Stock detection: two-tier approach

1. **Fast path** — plain HTTP fetch (`fetchProductPage`), works when Lazada embeds real stock data in server-rendered HTML.
2. **Fallback** — only when the fast path returns `unknown`, a headless Chromium browser (Playwright) actually loads and renders the page, the same way a real visitor's browser would. This means any client-side-rendered stock data (and any anti-bot fingerprinting Lazada's page performs) happens legitimately — nothing is spoofed or forged, we're just paying the cost of a real page load instead of a lightweight fetch.

The fallback launches a fresh browser per check and closes it immediately after, rather than keeping one running persistently, to avoid compounding memory usage across poll cycles.

## ⚠️ Important: Render deployment now needs a different build step

Playwright requires the Chromium browser binary to be installed, which needs to happen during Render's build phase:

**Build Command**: `npm install && npx playwright install chromium`

(No `--with-deps` — that flag tries to install OS-level system libraries via `apt`/`sudo`, which Render's build environment doesn't grant root access for, and the build will fail with an authentication error. Dropping it just installs the Chromium binary itself, without the OS package layer.)

The `postinstall` script in `package.json` matches this and runs automatically on every `npm install`, but setting the Build Command explicitly on Render is more reliable than relying on postinstall alone.

**If Chromium fails to launch at runtime** (not at build time) with an error about missing shared libraries: that means Render's base image is missing an OS-level dependency `--with-deps` would normally have installed. If you hit this, the practical options are switching to a Docker-based Render deploy (where you control the base image and can install those libraries yourself), or moving off the free tier to a plan with more deployment flexibility. Worth trying the plain install first — Render's Ubuntu-based images often already have most of what Chromium needs.

## ⚠️ RAM warning — this may not fit on Render's free tier

Render's free Web Service gives **512MB RAM**. A headless Chromium page load typically needs 300-500MB on its own — on top of what the bot's HTTP server, Telegram polling, and Node process already use. This is genuinely tight and may crash or get OOM-killed on the free tier, especially if multiple people's watched URLs hit the fallback around the same time.

Realistic paths forward if you hit this:
- **It mostly works fine** if the fallback triggers rarely (most watched products use the fast path successfully) — worth just trying it and watching Render's logs/metrics for OOM kills.
- **Upgrade to Render's Starter tier** ($7/month) for headroom if the free tier proves unstable.
- **Reduce the depth of the fallback** — e.g., only invoke Playwright when you specifically request a manual re-check on a `null`-result product, rather than automatically on every poll cycle.

## If stock detection stops working

Lazada's page structure (or their `mtop` API shape) can change over time. See `stock.js`'s `extractStockSignal()` and use DevTools to find the current stock/quantity field if alerts stop firing on items you know are in stock. Check the Render logs for `[fallback]` lines to see whether the fast path or the rendered fallback is being used for a given product.

## Etiquette / ToS note

Each unique URL is still only polled once per interval regardless of subscriber count, so more users doesn't mean more load on Lazada's servers. Still worth skimming Lazada's ToS periodically since platforms can tighten their stance on automated access over time.
