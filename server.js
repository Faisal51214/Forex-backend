const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());

const API_KEY = "79ac23f931784c85bf93723c61cade7e";

const PAIRS = [
  "EUR/USD","GBP/USD","USD/JPY","XAU/USD","WTI/USD","XAG/USD","AUD/USD","USD/CHF"
];

let cachedPrices = {};
let cachedCandles = {};
let lastFetch = null;

async function fetchAllData() {
  try {
    const fetch = (await import("node-fetch")).default;
    const syms = PAIRS.join(",");
    const priceRes = await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(syms)}&apikey=${API_KEY}`);
    const priceData = await priceRes.json();
    for (const pair of PAIRS) {
      if (priceData[pair]?.price) {
        cachedPrices[pair] = parseFloat(priceData[pair].price);
      }
    }
    for (const pair of PAIRS) {
      const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(pair)}&interval=1h&outputsize=100&apikey=${API_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.values) {
        cachedCandles[pair] = data.values.reverse().map(v => ({
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          datetime: v.datetime
        }));
      }
      await new Promise(r => setTimeout(r, 500));
    }
    lastFetch = new Date().toISOString();
    console.log("Data fetched at", lastFetch);
  } catch(e) {
    console.error("Fetch error:", e.message);
  }
}

fetchAllData();
setInterval(fetchAllData, 5 * 60 * 1000);

app.get("/prices", (req, res) => {
  res.json({ prices: cachedPrices, lastFetch });
});

app.get("/candles/:pair", (req, res) => {
  const pair = decodeURIComponent(req.params.pair);
  res.json({ candles: cachedCandles[pair] || [], lastFetch });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", lastFetch, pairs: Object.keys(cachedPrices).length });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));