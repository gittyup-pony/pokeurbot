/**
 * db.js — tiny JSON-file datastore.
 *
 * No native/compiled dependencies (deliberately avoiding sqlite) so it
 * deploys cleanly on Render without a build toolchain.
 *
 * Shape:
 * {
 *   "subscribers": { "<chatId>": { "urls": ["url1", "url2"] } },
 *   "stock":       { "<url>": { "inStock": bool|null, "lastChecked": iso, "source": string } }
 * }
 *
 * Note: Render's free-tier filesystem is ephemeral — a redeploy wipes this
 * file. See README for what that does (and doesn't) affect.
 */

const fs = require('fs');

const DB_FILE = process.env.DB_FILE || './data.json';

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { subscribers: {}, stock: {} };
  }
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function ensureSubscriber(db, chatId) {
  const key = String(chatId);
  if (!db.subscribers[key]) {
    db.subscribers[key] = { urls: [] };
  }
  return db.subscribers[key];
}

function addWatch(chatId, url) {
  const db = load();
  const sub = ensureSubscriber(db, chatId);
  if (!sub.urls.includes(url)) {
    sub.urls.push(url);
  }
  if (!db.stock[url]) {
    db.stock[url] = { inStock: null, lastChecked: null, source: null };
  }
  save(db);
  return sub.urls;
}

function removeWatch(chatId, url) {
  const db = load();
  const sub = ensureSubscriber(db, chatId);
  sub.urls = sub.urls.filter((u) => u !== url);
  save(db);
  return sub.urls;
}

function listWatches(chatId) {
  const db = load();
  return db.subscribers[String(chatId)]?.urls || [];
}

function getAllUrls() {
  const db = load();
  const set = new Set();
  Object.values(db.subscribers).forEach((sub) => sub.urls.forEach((u) => set.add(u)));
  return Array.from(set);
}

function getSubscribersForUrl(url) {
  const db = load();
  return Object.entries(db.subscribers)
    .filter(([, sub]) => sub.urls.includes(url))
    .map(([chatId]) => chatId);
}

function getStock(url) {
  const db = load();
  return db.stock[url] || { inStock: null, lastChecked: null, source: null };
}

function setStock(url, stockInfo) {
  const db = load();
  db.stock[url] = stockInfo;
  save(db);
}

module.exports = {
  addWatch,
  removeWatch,
  listWatches,
  getAllUrls,
  getSubscribersForUrl,
  getStock,
  setStock,
};
