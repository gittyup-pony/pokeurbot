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

## Deploying to Render

Same as before, but note the polling mode difference:

- Deploy as a **Background Worker** (not Web Service) — same reasoning as the single-user version.
- Set `TELEGRAM_BOT_TOKEN`, `POLL_INTERVAL_SECONDS`, `DB_FILE` as environment variables in the Render dashboard.
- This version uses Telegram's `polling: true` mode (via `node-telegram-bot-api`) to *receive* `/watch` commands, not just send alerts — this works fine on a background worker since Telegram polling is an outbound long-poll connection, not an inbound webhook, so no public URL is needed.

## Data persistence caveat

`data.json` lives on Render's ephemeral filesystem — a redeploy wipes it, meaning subscribers and their watch lists would be lost. For a handful of friends this is a minor inconvenience (everyone just re-runs `/watch`), but if you want it to survive redeploys:

- Swap `db.js` for a hosted key-value store (Upstash Redis's REST API works well and needs no extra native dependencies, same as the axios-only approach used here), or
- Add a Render **persistent disk** (available on paid plans) mounted at the `data.json` path.

Worth doing this only if you're expecting the bot to be actively used by others long-term — otherwise the simple JSON file is fine to start with.

## If stock detection stops working

Same as before — Lazada's page structure can change. See `stock.js`'s `extractStockSignal()` and use DevTools to find the current stock/quantity field if alerts stop firing on items you know are in stock.

## Etiquette / ToS note

Each unique URL is still only polled once per interval regardless of subscriber count, so more users doesn't mean more load on Lazada's servers. Still worth skimming Lazada's ToS periodically since platforms can tighten their stance on automated access over time.
