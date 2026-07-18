/**
 * bot.js — multi-user Lazada stock watcher (telegraf edition).
 *
 * Commands:
 *   /start            welcome message
 *   /watch <url>      add a product URL to your personal watch list
 *   /unwatch <url>    remove a product URL from your list
 *   /list             show what you're currently watching
 *   /help             show commands
 *
 * Each product URL is only fetched ONCE per poll cycle no matter how many
 * people are watching it — the bot then fans the alert out to every
 * subscriber of that URL. Still read-only: no cart, no login, no checkout.
 */

require('dotenv').config();
const http = require('http');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const db = require('./db');
const { fetchProductPage, extractStockSignal } = require('./stock');

const { TELEGRAM_BOT_TOKEN, POLL_INTERVAL_SECONDS = '30', PORT = '3000', RENDER_EXTERNAL_URL } = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const pollIntervalMs = Math.max(20, Number(POLL_INTERVAL_SECONDS)) * 1000;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

function isLikelyLazadaUrl(text) {
  try {
    const u = new URL(text);
    return /lazada\./i.test(u.hostname);
  } catch {
    return false;
  }
}

function getArg(ctx) {
  // ctx.message.text is the full "/watch <url>" string — strip the command itself
  const parts = ctx.message.text.trim().split(/\s+/);
  return parts.slice(1).join(' ').trim();
}

// ---------- commands ----------

bot.start((ctx) => {
  ctx.reply(
    "👋 I watch Lazada product pages and ping you when something restocks.\n\n" +
      'Commands:\n' +
      '/watch <url> — add a product to your list\n' +
      '/unwatch <url> — remove one\n' +
      "/list — see what you're watching\n\n" +
      "I only read public pages — I never touch your cart or checkout, so you'll still need to grab it yourself when I ping you."
  );
});

bot.help((ctx) => {
  ctx.reply('/watch <url> — add a product\n/unwatch <url> — remove a product\n/list — show your watch list');
});

bot.command('watch', (ctx) => {
  const url = getArg(ctx);
  if (!url || !isLikelyLazadaUrl(url)) {
    ctx.reply("That doesn't look like a valid Lazada product URL — double check and try again.");
    return;
  }
  const urls = db.addWatch(ctx.chat.id, url);
  ctx.reply(`✅ Now watching:\n${url}\n\nYou're tracking ${urls.length} product(s).`);
});

bot.command('unwatch', (ctx) => {
  const url = getArg(ctx);
  if (!url) {
    ctx.reply('Usage: /unwatch <url>');
    return;
  }
  const urls = db.removeWatch(ctx.chat.id, url);
  ctx.reply(`🗑️ Removed:\n${url}\n\nYou're tracking ${urls.length} product(s).`);
});

bot.command('list', (ctx) => {
  const urls = db.listWatches(ctx.chat.id);
  if (urls.length === 0) {
    ctx.reply("You're not watching anything yet. Use /watch <url> to add one.");
    return;
  }
  ctx.reply(`You're watching ${urls.length} product(s):\n\n${urls.join('\n')}`);
});

bot.telegram.setMyCommands([
  { command: 'watch', description: 'Add a Lazada product URL to your list' },
  { command: 'unwatch', description: 'Remove a product URL from your list' },
  { command: 'list', description: 'Show what you are currently watching' },
  { command: 'help', description: 'Show available commands' },
]);

bot.launch();
console.log('Telegram bot launched (long polling).');

// Graceful shutdown, recommended by telegraf docs
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ---------- minimal HTTP server (so Render treats this as a Web Service) ----------
// Render's free Web Service tier requires the app to listen on $PORT and
// respond to HTTP requests. This also gives the self-ping below something
// to hit, which keeps the free instance from spinning down after 15 minutes
// of inactivity — same pattern used in picklebolbot.

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('laz-stock-watcher is alive');
  })
  .listen(PORT, () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });

// RENDER_EXTERNAL_URL is set automatically by Render for web services —
// no need to configure it manually.
if (RENDER_EXTERNAL_URL) {
  const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes, safely under the 15-minute spin-down window
  setInterval(() => {
    axios.get(RENDER_EXTERNAL_URL).catch((err) => {
      console.error('Self-ping failed:', err.message);
    });
  }, SELF_PING_INTERVAL_MS);
} else {
  console.log('RENDER_EXTERNAL_URL not set — self-ping disabled (expected when running locally).');
}

// ---------- shared polling loop ----------

async function checkUrl(url) {
  const html = await fetchProductPage(url);
  const signal = extractStockSignal(html);

  const prev = db.getStock(url);
  const prevInStock = prev.inStock;
  const justRestocked = signal.inStock === true && prevInStock === false;

  db.setStock(url, {
    inStock: signal.inStock,
    lastChecked: new Date().toISOString(),
    source: signal.source,
  });

  console.log(`[${new Date().toLocaleTimeString()}] ${url} -> inStock=${signal.inStock} (${signal.source})`);

  if (justRestocked) {
    const subscribers = db.getSubscribersForUrl(url);
    for (const chatId of subscribers) {
      bot.telegram.sendMessage(chatId, `🟢 <b>Back in stock!</b>\n${url}`, { parse_mode: 'HTML' }).catch((err) => {
        console.error(`Failed to notify ${chatId}:`, err.message);
      });
    }
  }
}

async function pollAll() {
  const urls = db.getAllUrls();
  for (const url of urls) {
    try {
      await checkUrl(url);
    } catch (err) {
      console.error(`Error checking ${url}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 1500)); // stagger requests
  }
}

console.log(`Stock polling every ${pollIntervalMs / 1000}s.`);
pollAll();
setInterval(pollAll, pollIntervalMs);
