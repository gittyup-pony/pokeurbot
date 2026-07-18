/**
 * stock.js — page fetch + stock signal extraction.
 *
 * Two-tier approach:
 *   1. Fast path: plain HTTP GET (fetchProductPage). Works for pages that
 *      embed real stock data in server-rendered HTML. Cheap, fast, no
 *      extra infra.
 *   2. Fallback: headless-browser render (fetchProductPageRendered), used
 *      ONLY when the fast path can't find a stock signal. This actually
 *      executes the page's JavaScript in a real (headless) Chromium
 *      instance, so any client-side-rendered stock data — and any
 *      anti-bot fingerprinting the page does — happens the same way it
 *      would for a real visitor. We are not spoofing or forging anything;
 *      we're just running the page for real, the slow/heavy way, instead
 *      of faking a fast/light request.
 *
 * The fallback launches and closes a fresh browser per call rather than
 * keeping one running persistently — slower, but keeps memory usage from
 * compounding across poll cycles, which matters on Render's free tier.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchProductPage(url) {
  const headers = {
    'User-Agent': BROWSER_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-SG,en;q=0.9',
  };
  const { data: html } = await axios.get(url, { headers, timeout: 15000 });
  return html;
}

async function fetchProductPageRendered(url) {
  // Lazy require — keeps startup fast and avoids loading Chromium's
  // bindings for checks that never need the fallback.
  const { chromium } = require('playwright');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'], // needed on memory-constrained containers
  });

  try {
    const context = await browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      locale: 'en-SG',
    });
    const page = await context.newPage();

    // 'networkidle' is too strict for pages with persistent background
    // activity (chat widgets, analytics beacons) — Lazada's PDP pages
    // often never go fully idle, causing false timeouts. 'domcontentloaded'
    // fires once the initial HTML is parsed; we then wait a bit longer
    // for client-side rendering to fill in the stock UI.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000); // give client-side rendering time to populate stock data

    const html = await page.content();
    return html;
  } finally {
    await browser.close(); // always release memory, even on error
  }
}

function extractStockSignal(html) {
  const jsonFieldPatterns = [
    /"quantity"\s*:\s*(\d+)/i,
    /"stock"\s*:\s*(\d+)/i,
    /"available"\s*:\s*(\d+)/i,
    /"sellableStock"\s*:\s*(\d+)/i,
  ];

  for (const pattern of jsonFieldPatterns) {
    const match = html.match(pattern);
    if (match) {
      const qty = Number(match[1]);
      return { inStock: qty > 0, source: 'json-field', raw: qty };
    }
  }

  const $ = cheerio.load(html);
  const bodyText = $('body').text().toLowerCase();

  const outOfStockPhrases = ['out of stock', 'sold out', 'currently unavailable'];
  const inStockPhrases = ['add to cart', 'buy now'];

  const hasOutOfStockPhrase = outOfStockPhrases.some((p) => bodyText.includes(p));
  const hasInStockPhrase = inStockPhrases.some((p) => bodyText.includes(p));

  if (hasOutOfStockPhrase && !hasInStockPhrase) {
    return { inStock: false, source: 'text-match', raw: 'out-of-stock phrase found' };
  }
  if (hasInStockPhrase && !hasOutOfStockPhrase) {
    return { inStock: true, source: 'text-match', raw: 'add-to-cart phrase found' };
  }

  return { inStock: null, source: 'unknown', raw: null };
}

/**
 * checkStock — the single entry point bot.js should call. Tries the fast
 * path first; only pays the Playwright cost if the fast path can't tell.
 */
async function checkStock(url) {
  const fastHtml = await fetchProductPage(url);
  const fastSignal = extractStockSignal(fastHtml);

  if (fastSignal.inStock !== null) {
    return fastSignal;
  }

  console.log(`  [fallback] fast path returned unknown for ${url}, rendering with headless browser...`);
  const renderedHtml = await fetchProductPageRendered(url);
  const renderedSignal = extractStockSignal(renderedHtml);

  if (renderedSignal.inStock === null) {
    // Debug aid: show what's actually on the rendered page so patterns in
    // extractStockSignal() can be adjusted to match reality instead of guessing.
    const cheerioForDebug = cheerio.load(renderedHtml);
    const visibleText = cheerioForDebug('body').text().replace(/\s+/g, ' ').trim();
    console.log(`  [debug] rendered HTML length: ${renderedHtml.length} chars`);
    console.log(`  [debug] visible text sample (500 chars): ${visibleText.slice(0, 500)}`);
  }

  return { ...renderedSignal, source: `${renderedSignal.source}-rendered` };
}

module.exports = { fetchProductPage, fetchProductPageRendered, extractStockSignal, checkStock };
