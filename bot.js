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

const _maxTradeSize = parseFloat(process.env.MAX_TRADE_SIZE_USD || "100");

const CONFIG = {
  symbol:              process.env.SYMBOL       || "BTC/USD",
  timeframe:           process.env.TIMEFRAME    || "5m",
  maxTradeSizeUSD:     _maxTradeSize,
  maxTotalExposureUSD: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USD || String(_maxTradeSize * 5)),
  maxTradesPerDay:     parseInt(process.env.MAX_TRADES_PER_DAY    || "100"),
  paperTrading:        process.env.PAPER_TRADING !== "false",
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

// ─── Fetch with timeout ───────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  return res;
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(limit = 50) {
  const tf  = TIMEFRAME_MAP[CONFIG.timeframe] || "1Min";
  const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars` +
    `?symbols=${encodeURIComponent(CONFIG.symbol)}&timeframe=${tf}&limit=${limit}&sort=desc`;

  const res = await fetchWithTimeout(url, {
    headers: {
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (!res.ok) throw new Error(`Market data error: ${res.status}`);
  const data = await res.json();

  const bars = data.bars?.[CONFIG.symbol];
  if (!bars || bars.length === 0) throw new Error(`No candle data for ${CONFIG.symbol}`);

  return bars.reverse().map((b) => ({
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
const CSV_HEADERS   = "Date,Time (UTC),Symbol,Side,Amount USD,Order ID,Mode,Signal\n";

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

async function getPositionValue() {
  const pos = await getPosition();
  if (!pos) return 0;
  return parseFloat(pos.market_value) || 0;
}

async function closePosition() {
  const symbol = CONFIG.symbol.replace("/", "");
  const res = await fetchWithTimeout(
    `${CONFIG.alpaca.baseUrl}/v2/positions/${symbol}`,
    {
      method: "DELETE",
      headers: {
        "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
        "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      },
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || JSON.stringify(data));
  return data;
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

  const res = await fetchWithTimeout(`${CONFIG.alpaca.baseUrl}/v2/orders`, {
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
  const symbol = CONFIG.symbol.replace("/", "");
  const res = await fetchWithTimeout(
    `${CONFIG.alpaca.baseUrl}/v2/positions/${symbol}`,
    {
      headers: {
        "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
        "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      },
    }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Position check failed (${res.status}): ${err.message || JSON.stringify(err)}`);
  }
  return await res.json();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // Hard kill after 4.5min — cron runs every 5 minutes, must not overlap
  const killTimer = setTimeout(() => {
    console.error("⚠️  270s timeout — forcing exit to avoid overlap with next cron run");
    process.exit(1);
  }, 270_000);
  killTimer.unref();

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
  const emaFastSeries = calcEMASeries(closes, 3);
  const emaSlowSeries = calcEMASeries(closes, 8);
  const rsi           = calcRSI(closes, 14);

  const emaFastCurr = emaFastSeries.at(-1);
  const emaFastPrev = emaFastSeries.at(-2);
  const emaSlowCurr = emaSlowSeries.at(-1);
  const emaSlowPrev = emaSlowSeries.at(-2);

  console.log(`  EMA(3):  $${emaFastCurr.toFixed(2)}  (prev $${emaFastPrev.toFixed(2)})`);
  console.log(`  EMA(8):  $${emaSlowCurr.toFixed(2)}  (prev $${emaSlowPrev.toFixed(2)})`);
  console.log(`  RSI(14): ${rsi !== null ? rsi.toFixed(2) : "N/A"}`);
  console.log(`  Trend:   EMA3 is ${emaFastCurr > emaSlowCurr ? "ABOVE ↑ (bullish)" : "BELOW ↓ (bearish)"}`);

  // State-based signal — fires whenever conditions are met
  const bullish       = emaFastCurr > emaSlowCurr;
  const positionValue = await getPositionValue();
  const canBuyMore    = positionValue + CONFIG.maxTradeSizeUSD <= CONFIG.maxTotalExposureUSD;
  console.log(`  Position: $${positionValue.toFixed(2)} / $${CONFIG.maxTotalExposureUSD} max exposure`);

  console.log(`\n── Signal ${"─".repeat(47)}`);

  let signal = "NONE";
  let side   = null;

  if (bullish && rsi !== null && rsi < 70 && canBuyMore) {
    signal = "BUY";
    side   = "buy";
    console.log(`  🟢 BUY — EMA3 above EMA8, RSI ${rsi.toFixed(2)} < 70, exposure $${positionValue.toFixed(2)} → $${(positionValue + CONFIG.maxTradeSizeUSD).toFixed(2)}`);
  } else if (!bullish && rsi !== null && rsi > 30 && positionValue > 0) {
    signal = "SELL";
    side   = "sell";
    console.log(`  🔴 SELL — EMA3 below EMA8, RSI ${rsi.toFixed(2)} > 30, selling $${CONFIG.maxTradeSizeUSD} of $${positionValue.toFixed(2)}`);
  } else if (bullish && positionValue > 0 && !canBuyMore) {
    signal = "HOLD";
    console.log(`  🟡 HOLD — EMA3 above EMA8, at max exposure $${positionValue.toFixed(2)}`);
  } else if (!bullish && positionValue === 0) {
    signal = "WAIT";
    console.log(`  ⏸  WAIT — EMA3 below EMA8, flat — waiting for bullish trend`);
  } else {
    console.log(`  ⏸  No action — RSI filter blocked (RSI: ${rsi?.toFixed(2)})`);
  }

  // Execute trade
  console.log(`\n── Action ${"─".repeat(47)}`);

  const entry = {
    timestamp,
    symbol:      CONFIG.symbol,
    timeframe:   CONFIG.timeframe,
    price,
    indicators:  { ema3: emaFastCurr, ema8: emaSlowCurr, rsi },
    signal,
    orderPlaced: false,
    orderId:     null,
    side:        null,
    amountUSD:   null,
    paperTrading: CONFIG.paperTrading,
  };

  if (side) {
    entry.side      = side;
    entry.amountUSD = CONFIG.maxTradeSizeUSD;

    try {
      const sellAmount = Math.min(CONFIG.maxTradeSizeUSD, positionValue);
      const order = side === "buy"
        ? await placeOrder("buy", CONFIG.maxTradeSizeUSD)
        : await placeOrder("sell", sellAmount);
      entry.orderId     = order.id;
      entry.orderPlaced = true;
      const modeLabel   = CONFIG.paperTrading ? "PAPER" : "LIVE";
      console.log(`  ✅ ${modeLabel} ${side.toUpperCase()} placed — ${order.id}`);
    } catch (err) {
      console.log(`  ❌ ORDER FAILED — ${err.message}`);
      entry.error = err.message;
    }
  }

  // Save
  state.trades.push(entry);
  saveState(state);
  logToCsv(entry);

  console.log(`\n  Logged. Next check ~1 min.`);
  console.log(`${"═".repeat(57)}\n`);
}

async function closeAll() {
  checkOnboarding();
  console.log(`\n${"═".repeat(57)}`);
  console.log(`  Close All — ${CONFIG.symbol}`);
  console.log(`${"═".repeat(57)}\n`);

  const pos = await getPosition();
  if (!pos || parseFloat(pos.qty) <= 0) {
    console.log("  No open position — nothing to close.\n");
    return;
  }

  console.log(`  Position: ${pos.qty} BTC @ avg $${parseFloat(pos.avg_entry_price).toFixed(2)}`);
  console.log(`  Market value: $${parseFloat(pos.market_value).toFixed(2)}`);
  console.log(`  Unrealised P&L: $${parseFloat(pos.unrealized_pl).toFixed(2)}\n`);

  const order = await closePosition();
  console.log(`  ✅ Close order placed — ${order.id}`);
  console.log(`${"═".repeat(57)}\n`);
}

const cmd = process.argv[2];
if (cmd === "--close-all") {
  closeAll().catch((err) => { console.error("Error:", err.message); process.exit(1); });
} else {
  run().catch((err) => { console.error("Bot error:", err.message); process.exit(1); });
}
