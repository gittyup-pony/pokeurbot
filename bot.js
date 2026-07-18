/**
 * bot.js — multi-user Lazada stock watcher.
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
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { fetchProductPage, extractStockSignal } = require('./stock');

const { TELEGRAM_BOT_TOKEN, POLL_INTERVAL_SECONDS = '30' } = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const pollIntervalMs = Math.max(20, Number(POLL_INTERVAL_SECONDS)) * 1000;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

function isLikelyLazadaUrl(text) {
  try {
    const u = new URL(text);
    return /lazada\./i.test(u.hostname);
  } catch {
    return false;
  }
}

// ---------- commands ----------

bot.onText(/^\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "👋 I watch Lazada product pages and ping you when something restocks.\n\n" +
      'Commands:\n' +
      '/watch <url> — add a product to your list\n' +
      '/unwatch <url> — remove one\n' +
      '/list — see what you\'re watching\n\n' +
      "I only read public pages — I never touch your cart or checkout, so you'll still need to grab it yourself when I ping you."
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    '/watch <url> — add a product\n/unwatch <url> — remove a product\n/list — show your watch list'
  );
});

bot.onText(/^\/watch (.+)/, (msg, match) => {
  const url = match[1].trim();
  if (!isLikelyLazadaUrl(url)) {
    bot.sendMessage(msg.chat.id, "That doesn't look like a valid Lazada product URL — double check and try again.");
    return;
  }
  const urls = db.addWatch(msg.chat.id, url);
  bot.sendMessage(msg.chat.id, `✅ Now watching:\n${url}\n\nYou're tracking ${urls.length} product(s).`);
});

bot.onText(/^\/unwatch (.+)/, (msg, match) => {
  const url = match[1].trim();
  const urls = db.removeWatch(msg.chat.id, url);
  bot.sendMessage(msg.chat.id, `🗑️ Removed:\n${url}\n\nYou're tracking ${urls.length} product(s).`);
});

bot.onText(/^\/list/, (msg) => {
  const urls = db.listWatches(msg.chat.id);
  if (urls.length === 0) {
    bot.sendMessage(msg.chat.id, "You're not watching anything yet. Use /watch <url> to add one.");
    return;
  }
  bot.sendMessage(msg.chat.id, `You're watching ${urls.length} product(s):\n\n${urls.join('\n')}`);
});

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
      bot.sendMessage(chatId, `🟢 <b>Back in stock!</b>\n${url}`, { parse_mode: 'HTML' }).catch((err) => {
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

console.log(`Bot running. Polling every ${pollIntervalMs / 1000}s.`);
pollAll();
setInterval(pollAll, pollIntervalMs);
