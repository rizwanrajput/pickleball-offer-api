// server.js
// Live used-paddle pricing → FIXED offer (50% of midpoint). Source never shown to user.
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

// ✅ CORRECT SOURCE URL — actual used paddle listings
const SOURCE_URL = "https://pickleballcentral.com/deals/used-pickleball-paddles/";

// In-memory cache (5-minute TTL)
let CACHE = {  null: null, fetchedAt: 0, ttlMs: 5 * 60 * 1000 };

// Normalize text for matching
function normalize(str = "") {
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

// Parse price string into lo, hi, mid
function priceParse(priceText) {
  const nums = (priceText.match(/[\d]+\.\d{2}/g) || []).map(v => parseFloat(v));
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const mid = (lo + hi) / 2;
  return { lo, hi, mid };
}

// Enhanced browser-like headers to avoid 406
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Cache-Control": "max-age=0"
};

// Retry with exponential backoff
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { ...options, compress: true });
      if (res.status === 406 || res.status >= 500) {
        console.warn(`Attempt ${i + 1}: Received ${res.status}, retrying...`);
        if (i === retries - 1) return res;
        await new Promise(r => setTimeout(r, 3000 * (i + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Network error (attempt ${i + 1}), retrying...`, err.message);
      await new Promise(r => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

// Scrape used paddles from Pickleball Central
async function scrapeUsedPaddles() {
  const now = Date.now();
  if (CACHE.data && now - CACHE.fetchedAt < CACHE.ttlMs) {
    console.log("✅ Using cached paddle data");
    return CACHE.data;
  }

  console.log("🔍 Fetching used paddles from pickleballcentral.com...");
  try {
    const res = await fetchWithRetry(SOURCE_URL, { headers: HEADERS });
    const html = await res.text();

    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch`);

    const $ = cheerio.load(html);
    const items = [];

    // Pickleball Central uses .grid__item .product-item
    $('.grid__item .product-item').each((_, el) => {
      const el$ = $(el);
      const name = el$.find('.product-item__title a').text().trim();
      const price = el$.find('.price__current').text().replace(/\s+/g, ' ').trim();

      if (name && price && /\$/.test(price)) {
        items.push({ name, price });
      }
    });

    // Deduplicate by normalized name
    const byName = new Map();
    for (const it of items) {
      const key = normalize(it.name);
      if (!byName.has(key) || it.price.length > byName.get(key).price.length) {
        byName.set(key, it);
      }
    }

    const data = Array.from(byName.values());
    CACHE = { data, fetchedAt: now, ttlMs: CACHE.ttlMs };

    console.log(`✅ Scraped ${data.length} used paddles`);
    return data;
  } catch (err) {
    console.error("❌ Scrape failed:", err.message);
    if (CACHE.data) {
      console.warn("⚠️ Using stale cache due to scrape failure");
      return CACHE.data;
    }
    throw err;
  }
}

// Enhanced matching with model aliases
function bestMatch(model, dataset) {
  const q = normalize(model);
  if (!q) return null;

  // Model aliases for common variations
  const ALIASES = {
    "peresus pro 4": "peresus pro iv",
    "peresus pro iv": "peresus pro iv",
    "ben johns perseus": "peresus pro iv",
    "joola perseus": "peresus pro iv",
    "perseus pro": "peresus pro",
    "bantam exps": "bantam exps",
    "bantam xl": "bantam xl",
    "onyx pro": "onyx"
  };

  let normalizedQuery = q;
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (normalizedQuery.includes(alias)) {
      normalizedQuery = target;
      break;
    }
  }

  // 1. Substring match
  for (const item of dataset) {
    const n = normalize(item.name);
    if (n.includes(normalizedQuery) || normalizedQuery.includes(n)) {
      return item;
    }
  }

  // 2. Token overlap fallback
  const qTokens = normalizedQuery.split(" ").filter(Boolean);
  let best = null;
  for (const item of dataset) {
    const n = normalize(item.name);
    const hits = qTokens.filter(t => n.includes(t)).length;
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { ...item, hits };
    }
  }
  return best;
}

// Public API — never reveals the source URL
app.post("/offer", async (req, res) => {
  try {
    const { model, condition, notes } = req.body || {};
    if (!model || !condition) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: model, condition"
      });
    }

    const dataset = await scrapeUsedPaddles();
    const match = bestMatch(model, dataset);

    if (!match) {
      return res.status(200).json({
        ok: true,
        found: false,
        offer: null,
        message: "Model not currently available for offer calculation.",
        echo: { submittedModel: model, condition, notes: notes || "" }
      });
    }

    const parsed = priceParse(match.price);
    if (!parsed) {
      return res.status(200).json({
        ok: true,
        found: true,
        offer: null,
        message: "Price unavailable for matched model.",
        echo: { submittedModel: model, condition, notes: notes || "" }
      });
    }

    const fixedOffer = Math.round((parsed.mid * 0.5 + Number.EPSILON) * 100) / 100;

    res.json({
      ok: true,
      found: true,
      offer: fixedOffer,
      referencePrice: match.price,
      referenceMidpoint: +parsed.mid.toFixed(2),
      policy: "Offer equals 50% of the current used-price midpoint.",
      echo: {
        model: match.name,
        submittedModel: model,
        condition,
        notes: notes || ""
      }
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({
      ok: false,
      error: "Offer calculation failed. Please try again shortly."
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Offer API is running on http://localhost:${PORT}`);
  console.log(`💡 Send POST requests to http://localhost:${PORT}/offer`);
});