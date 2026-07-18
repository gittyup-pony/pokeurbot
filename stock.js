/**
 * stock.js — page fetch + stock signal extraction.
 * Same detection logic as the single-user version. See README if Lazada's
 * page structure changes and these patterns stop matching.
 */

const axios = require('axios');
const cheerio = require('cheerio');

async function fetchProductPage(url) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-SG,en;q=0.9',
  };
  const { data: html } = await axios.get(url, { headers, timeout: 15000 });
  return html;
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

module.exports = { fetchProductPage, extractStockSignal };
