// server.js
// Live used-paddle pricing → FIXED offer (50% of midpoint). Source never shown to user.
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";

const app = express();
app.use(express.json());

// Add CORS middleware
app.use((req, res, next) => {
  const allowedOrigin = 'https://webuypickleball.newwebgrids.com';
  const origin = req.headers.origin;

  // Allow only your WordPress site
  if (origin === allowedOrigin) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight (OPTIONS) requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// 🔒 INTERNAL ONLY — do not expose in responses
const SOURCE_URL = "https://www.pickleballwarehouse.com/usedpaddles.html";

// Simple in-memory cache (5-minute TTL)
let CACHE = { data: null, fetchedAt: 0, ttlMs: 5 * 60 * 1000 };

function normalize(str = "") {
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

function priceParse(priceText) {
  // Returns { lo, hi, mid } or null
  const nums = (priceText.match(/[\d]+\.\d{2}/g) || []).map(v => parseFloat(v));
  if (!nums.length) return null;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const mid = (lo + hi) / 2;
  return { lo, hi, mid };
}

async function scrapeUsedPaddles() {
  const now = Date.now();
  if (CACHE.data && now - CACHE.fetchedAt < CACHE.ttlMs) return CACHE.data;

  try {
    const res = await fetch(SOURCE_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

    const html = await res.text();
    const $ = cheerio.load(html);

    const items = [];

    // Broad selector to capture product items
    $("[data-product-item], .product, .grid-item, li, .item").each((_, el) => {
      const el$ = $(el);
      const nameText =
        el$.find(".product-title, .title, .name, a[title]").first().text().trim() ||
        el$.find("a").first().attr("title") ||
        el$.find("a").first().text().trim();

      const priceText =
        el$.find(".price, .product-price, .sale-price, .amount, .pricing")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();

      // Heuristic: keep only if name and price with $ are present
      if (nameText && /\$[\d]/.test(priceText)) {
        items.push({ name: nameText, price: priceText });
      }
    });

    // Deduplicate by normalized name (keep most complete price)
    const byName = new Map();
    for (const it of items) {
      const key = normalize(it.name);
      if (!byName.has(key) || it.price.length > byName.get(key).price.length) {
        byName.set(key, it);
      }
    }

    const data = Array.from(byName.values());
    CACHE = { data, fetchedAt: now, ttlMs: CACHE.ttlMs };
    return data;
  } catch (err) {
    console.error("Scraping error:", err.message);
    throw err;
  }
}

function bestMatch(model, dataset) {
  const q = normalize(model);
  if (!q) return null;

  // 1. Substring match (longer overlap wins)
  let candidate = null;
  for (const item of dataset) {
    const n = normalize(item.name);
    if (n.includes(q) || q.includes(n)) {
      const score = Math.min(n.length, q.length);
      if (!candidate || score > candidate.score) {
        candidate = { ...item, score };
      }
    }
  }
  if (candidate) return candidate;

  // 2. Fallback: token overlap
  const qTokens = q.split(" ").filter(Boolean);
  let alt = null;
  for (const item of dataset) {
    const n = normalize(item.name);
    const hits = qTokens.filter(t => n.includes(t)).length;
    if (hits > 0 && (!alt || hits > alt.hits || (hits === alt.hits && item.name.length > alt.name.length))) {
      alt = { ...item, hits };
    }
  }
  return alt;
}

// Public API — never reveals the source URL in responses
app.post("/offer", async (req, res) => {
  try {
    const { model, condition, notes } = req.body || {};
    if (!model || !condition) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields: model, condition",
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
        echo: { submittedModel: model, condition, notes: notes || "" },
      });
    }

    const parsed = priceParse(match.price);
    if (!parsed) {
      return res.status(200).json({
        ok: true,
        found: true,
        offer: null,
        message: "Price unavailable for matched model.",
        echo: { submittedModel: model, condition, notes: notes || "" },
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
        notes: notes || "",
      },
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({
      ok: false,
      error: "Offer calculation failed. Please try again shortly.",
    });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Offer API is running on http://localhost:${PORT}`);
  console.log(`💡 Send POST requests to http://localhost:${PORT}/offer`);
});