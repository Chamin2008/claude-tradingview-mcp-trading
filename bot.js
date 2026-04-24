import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    process.exit(1);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:          process.env.SYMBOL       || "BTC/USD",
  timeframe:       process.env.TIMEFRAME    || "1m",
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD  || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "100"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  alpaca: {
    apiKey:    process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl:   process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
  },
};

const TIMEFRAME_MAP = {
  "1m": "1Min", "5m": "5Min", "15m": "15Min",
  "30m": "30Min", "1H": "1Hour", "4H": "4Hour", "1D": "1Day",
};

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(limit = 50) {
  const tf = TIMEFRAME_MAP[CONFIG.timeframe] || "1Min";
  const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars` +
    `?symbols=${encodeURIComponent(CONFIG.symbol)}&timeframe=${tf}&limit=${limit}&sort=asc`;

  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (!res.ok) throw new Error(`Market data error: ${res.status}`);
  const data = await res.json();

  const bars = data.bars?.[CONFIG.symbol];
  if (!bars || bars.length === 0) throw new Error(`No candle data for ${CONFIG.symbol}`);

  return bars.map((b) => ({
    time:   new Date(b.t).getTime(),
    open:   parseFloat(b.o),
    high:   parseFloat(b.h),
    low:    parseFloat(b.l),
    close:  parseFloat(b.c),
    volume: parseFloat(b.v),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMASeries(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const series = [ema];
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

// ─── Trade Tracking ───────────────────────────────────────────────────────────

const STATE_FILE = "safety-check-log.json";
const CSV_FILE   = "trades.csv";
const CSV_HEADERS = "Date,Time (UTC),Symbol,Side,Amount USD,Order ID,Mode,Signal\n";

function loadState() {
  if (!existsSync(STATE_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function countTodaysTrades(state) {
  const today = new Date().toISOString().slice(0, 10);
  return state.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

function initCsv() {
  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS);
}

function logToCsv(entry) {
  const now = new Date(entry.timestamp);
  const row = [
    now.toISOString().slice(0, 10),
    now.toISOString().slice(11, 19),
    entry.symbol,
    entry.side || "-",
    entry.amountUSD || "-",
    entry.orderId  || "-",
    entry.paperTrading ? "PAPER" : "LIVE",
    entry.signal,
  ].join(",");
  appendFileSync(CSV_FILE, row + "\n");
}

// ─── Alpaca Execution ─────────────────────────────────────────────────────────

async function placeOrder(side, amountUSD) {
  const body = {
    symbol:        CONFIG.symbol,
    side,
    type:          "market",
    time_in_force: "gtc",
    notional:      amountUSD.toFixed(2),
  };

  const res = await fetch(`${CONFIG.alpaca.baseUrl}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      "Content-Type":        "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
}

async function getPosition() {
  const res = await fetch(
    `${CONFIG.alpaca.baseUrl}/v2/positions/${encodeURIComponent(CONFIG.symbol)}`,
    {
      headers: {
        "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
        "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return await res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  const timestamp = new Date().toISOString();
  console.log(`\n${"═".repeat(57)}`);
  console.log(`  Claude Bot — EMA Crossover | ${timestamp}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`${"═".repeat(57)}`);

  // Daily limit check
  const state = loadState();
  const todayCount = countTodaysTrades(state);
  console.log(`\n  Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log("🚫 Daily limit reached — no action.\n");
    return;
  }

  // Fetch candles
  console.log(`\n── ${CONFIG.symbol} ${CONFIG.timeframe} candles ${"─".repeat(30)}`);
  const candles  = await fetchCandles(50);
  const closes   = candles.map((c) => c.close);
  const price    = closes.at(-1);
  console.log(`  Price:   $${price.toFixed(2)}`);

  // Indicators — need full series for crossover detection
  const ema9Series  = calcEMASeries(closes, 9);
  const ema21Series = calcEMASeries(closes, 21);
  const rsi         = calcRSI(closes, 14);

  const ema9Curr  = ema9Series.at(-1);
  const ema9Prev  = ema9Series.at(-2);
  const ema21Curr = ema21Series.at(-1);
  const ema21Prev = ema21Series.at(-2);

  console.log(`  EMA(9):  $${ema9Curr.toFixed(2)}  (prev $${ema9Prev.toFixed(2)})`);
  console.log(`  EMA(21): $${ema21Curr.toFixed(2)}  (prev $${ema21Prev.toFixed(2)})`);
  console.log(`  RSI(14): ${rsi !== null ? rsi.toFixed(2) : "N/A"}`);
  console.log(`  Trend:   EMA9 is ${ema9Curr > ema21Curr ? "ABOVE ↑ (bullish)" : "BELOW ↓ (bearish)"}`);

  // Crossover detection
  const bullishCross = ema9Prev <= ema21Prev && ema9Curr > ema21Curr;
  const bearishCross = ema9Prev >= ema21Prev && ema9Curr < ema21Curr;

  // Determine signal
  console.log(`\n── Signal ${"─".repeat(47)}`);

  let signal = "NONE";
  let side   = null;

  if (bullishCross) {
    if (rsi !== null && rsi < 70) {
      signal = "BUY";
      side   = "buy";
      console.log(`  🟢 BULLISH CROSS — EMA9 crossed above EMA21`);
      console.log(`     RSI ${rsi.toFixed(2)} < 70 ✅`);
    } else {
      signal = "BUY_FILTERED";
      console.log(`  🟡 Bullish cross detected but RSI ${rsi?.toFixed(2)} ≥ 70 — filtered`);
    }
  } else if (bearishCross) {
    if (rsi !== null && rsi > 30) {
      signal = "SELL";
      side   = "sell";
      console.log(`  🔴 BEARISH CROSS — EMA9 crossed below EMA21`);
      console.log(`     RSI ${rsi.toFixed(2)} > 30 ✅`);
    } else {
      signal = "SELL_FILTERED";
      console.log(`  🟡 Bearish cross detected but RSI ${rsi?.toFixed(2)} ≤ 30 — filtered`);
    }
  } else {
    const direction = ema9Curr > ema21Curr ? "UP" : "DOWN";
    console.log(`  ⏸  No crossover — trend ${direction}, watching...`);
  }

  // Execute trade
  console.log(`\n── Action ${"─".repeat(47)}`);

  const entry = {
    timestamp,
    symbol:      CONFIG.symbol,
    timeframe:   CONFIG.timeframe,
    price,
    indicators:  { ema9: ema9Curr, ema21: ema21Curr, rsi },
    signal,
    orderPlaced: false,
    orderId:     null,
    side:        null,
    amountUSD:   null,
    paperTrading: CONFIG.paperTrading,
  };

  if (side === "sell") {
    const position = await getPosition();
    if (!position || parseFloat(position.qty) <= 0) {
      console.log(`  ⏭  Sell signal but no open BTC position — skipping`);
      signal = "SELL_NO_POSITION";
      side   = null;
    }
  }

  if (side) {
    entry.side      = side;
    entry.amountUSD = CONFIG.maxTradeSizeUSD;

    if (CONFIG.paperTrading) {
      entry.orderId     = `PAPER-${Date.now()}`;
      entry.orderPlaced = true;
      console.log(`  📋 PAPER ${side.toUpperCase()} $${CONFIG.maxTradeSizeUSD} of ${CONFIG.symbol}`);
      console.log(`     Order ID: ${entry.orderId}`);
    } else {
      try {
        const order      = await placeOrder(side, CONFIG.maxTradeSizeUSD);
        entry.orderId     = order.id;
        entry.orderPlaced = true;
        console.log(`  ✅ LIVE ${side.toUpperCase()} placed — ${order.id}`);
      } catch (err) {
        console.log(`  ❌ ORDER FAILED — ${err.message}`);
        entry.error = err.message;
      }
    }
  } else if (signal === "NONE") {
    console.log(`  ⏸  No action — waiting for crossover`);
  }

  // Save
  state.trades.push(entry);
  saveState(state);
  logToCsv(entry);

  console.log(`\n  Logged. Next check ~1 min.`);
  console.log(`${"═".repeat(57)}\n`);
}

run().catch((err) => {
  console.error("Bot error:", err.message);
  process.exit(1);
});
