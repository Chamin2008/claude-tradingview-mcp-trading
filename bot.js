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
  symbol:              process.env.SYMBOL    || "BTC/USD",
  timeframe:           "15m",                              // signal timeframe
  trendTimeframe:      "4H",                               // macro trend filter
  maxTradeSizeUSD:     _maxTradeSize,
  maxTotalExposureUSD: parseFloat(process.env.MAX_TOTAL_EXPOSURE_USD || String(_maxTradeSize * 5)),
  maxTradesPerDay:     parseInt(process.env.MAX_TRADES_PER_DAY || "100"),
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

async function fetchCandles(timeframe, limit, startIso = null) {
  const tf  = TIMEFRAME_MAP[timeframe] || "15Min";
  let url = `https://data.alpaca.markets/v1beta3/crypto/us/bars` +
    `?symbols=${encodeURIComponent(CONFIG.symbol)}&timeframe=${tf}&limit=${limit}&sort=asc`;
  if (startIso) url += `&start=${encodeURIComponent(startIso)}`;

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
  if (closes.length < period) return [];
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
  // Wilder's smoothed RSI — matches TradingView
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low  - prev.close),
    );
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Trade Tracking ───────────────────────────────────────────────────────────

const STATE_FILE  = "safety-check-log.json";
const CSV_FILE    = "trades.csv";
const CSV_HEADERS = "Date,Time (UTC),Symbol,Side,Qty,Amount USD,Stop Price,Order ID,Mode,Signal\n";

function loadState() {
  if (!existsSync(STATE_FILE)) return { trades: [], stopPrice: null };
  const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  if (!("stopPrice" in s)) s.stopPrice = null;
  return s;
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function countTodaysTrades(state) {
  const today = new Date().toISOString().slice(0, 10);
  return state.trades.filter((t) => t.timestamp.startsWith(today) && t.orderPlaced).length;
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
    entry.side              || "-",
    entry.qty?.toFixed(6)   || "-",
    entry.amountUSD?.toFixed(2) || "-",
    entry.stopPrice?.toFixed(2) || "-",
    entry.orderId           || "-",
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

async function getAccountEquity() {
  const res = await fetchWithTimeout(`${CONFIG.alpaca.baseUrl}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (!res.ok) throw new Error(`Account fetch failed: ${res.status}`);
  const data = await res.json();
  return parseFloat(data.equity);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // 14.5 min kill switch — cron runs every 15 min, must not overlap
  const killTimer = setTimeout(() => {
    console.error("⚠️  870s timeout — forcing exit to avoid cron overlap");
    process.exit(1);
  }, 870_000);
  killTimer.unref();

  checkOnboarding();
  initCsv();

  const timestamp = new Date().toISOString();
  console.log(`\n${"═".repeat(57)}`);
  console.log(`  Claude Bot — 4H/15m EMA Strategy | ${timestamp}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log(`${"═".repeat(57)}`);

  const state = loadState();
  const todayCount = countTodaysTrades(state);
  console.log(`\n  Trades today: ${todayCount}/${CONFIG.maxTradesPerDay}`);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log("🚫 Daily limit reached — no action.\n");
    return;
  }

  // Fetch both timeframes in parallel
  console.log(`\n── Market Data ─────────────────────────────────────────`);
  const [candles4h, candles15m] = await Promise.all([
    fetchCandles("4H", 1000),
    fetchCandles("15m",  50),
  ]);

  const closes4h  = candles4h.map((c) => c.close);
  const closes15m = candles15m.map((c) => c.close);
  const price     = closes15m.at(-1);
  console.log(`  Price:         $${price.toFixed(2)}`);
  console.log(`  4H bars:       ${candles4h.length}  (need ≥200 for EMA200)`);
  console.log(`  15m bars:      ${candles15m.length}`);

  // 4H trend filter — EMA 200
  const ema200Series = calcEMASeries(closes4h, 200);
  const ema200_4h    = ema200Series.at(-1) ?? null;
  const isUptrend    = ema200_4h !== null && price > ema200_4h;
  console.log(`  EMA(200) 4H:   $${ema200_4h?.toFixed(2) ?? "N/A"}  ${isUptrend ? "↑ price above" : "↓ price below"}`);

  // 15m entry indicators
  const ema12Series = calcEMASeries(closes15m, 12);
  const ema26Series = calcEMASeries(closes15m, 26);
  const rsi         = calcRSI(closes15m, 14);
  const atr         = calcATR(candles15m, 14);

  const ema12Curr = ema12Series.at(-1) ?? null;
  const ema12Prev = ema12Series.at(-2) ?? null;
  const ema26Curr = ema26Series.at(-1) ?? null;
  const ema26Prev = ema26Series.at(-2) ?? null;

  console.log(`  EMA(12) 15m:   $${ema12Curr?.toFixed(2) ?? "N/A"}  (prev $${ema12Prev?.toFixed(2) ?? "N/A"})`);
  console.log(`  EMA(26) 15m:   $${ema26Curr?.toFixed(2) ?? "N/A"}  (prev $${ema26Prev?.toFixed(2) ?? "N/A"})`);
  console.log(`  RSI(14):       ${rsi?.toFixed(2) ?? "N/A"}`);
  console.log(`  ATR(14):       $${atr?.toFixed(2) ?? "N/A"}`);

  if (ema12Curr === null || ema12Prev === null || ema26Curr === null || ema26Prev === null || rsi === null || atr === null || ema200_4h === null) {
    const missing = [
      ema200_4h  === null && `EMA200 4H (have ${candles4h.length} bars, need 200)`,
      ema12Curr  === null && "EMA12 15m",
      ema26Curr  === null && "EMA26 15m",
      rsi        === null && "RSI",
      atr        === null && "ATR",
    ].filter(Boolean).join(", ");
    console.log(`\n⚠️  Missing: ${missing} — skipping.`);
    return;
  }

  // Crossover detection — transition only, not persistent state
  const crossedAbove = ema12Prev <= ema26Prev && ema12Curr > ema26Curr;
  const crossedBelow = ema12Prev >= ema26Prev && ema12Curr < ema26Curr;

  const position      = await getPosition();
  const positionValue = position ? parseFloat(position.market_value) || 0 : 0;
  const hasPosition   = positionValue > 0;

  // Recover stop price if container restarted and wiped state (Railway cron is stateless)
  if (hasPosition && !state.stopPrice && atr) {
    const entryPrice    = parseFloat(position.avg_entry_price);
    state.stopPrice     = entryPrice - atr * 1.5;
    console.log(`  Stop recovered: $${state.stopPrice.toFixed(2)}  (entry $${entryPrice.toFixed(2)} − ATR×1.5)`);
  }
  console.log(`  Position:      $${positionValue.toFixed(2)}${state.stopPrice ? `  |  Stop: $${state.stopPrice.toFixed(2)}` : ""}`);

  console.log(`\n── Signal ${"─".repeat(47)}`);

  let signal         = "NONE";
  let side           = null;
  let tradeAmountUSD = 0;
  let stopPrice      = null;
  let qty            = 0;

  if (hasPosition && state.stopPrice && price <= state.stopPrice) {
    // Stop loss breached — close immediately
    signal = "STOP";
    side   = "sell";
    console.log(`  🛑 STOP HIT — price $${price.toFixed(2)} ≤ stop $${state.stopPrice.toFixed(2)}`);
  } else if (!hasPosition && crossedAbove && isUptrend && rsi < 70) {
    // Entry: EMA12 just crossed above EMA26, price above EMA200 4H, not overbought
    const equity   = await getAccountEquity();
    const stopDist = atr * 1.5;
    stopPrice      = price - stopDist;
    qty            = (equity * 0.01) / stopDist;
    tradeAmountUSD = Math.min(qty * price, CONFIG.maxTradeSizeUSD);
    qty            = tradeAmountUSD / price; // realign qty to capped size

    signal = "BUY";
    side   = "buy";
    console.log(`  🟢 BUY — EMA12 crossed above EMA26`);
    console.log(`     Trend:  price > EMA200 4H ($${ema200_4h.toFixed(2)}) ✓`);
    console.log(`     RSI:    ${rsi.toFixed(2)} < 70 ✓`);
    console.log(`     Stop:   $${stopPrice.toFixed(2)}  (ATR×1.5 = $${stopDist.toFixed(2)})`);
    console.log(`     Size:   $${tradeAmountUSD.toFixed(2)}  (1% of $${equity.toFixed(2)} equity)`);
  } else if (hasPosition && crossedBelow) {
    // Exit: EMA12 just crossed below EMA26
    signal = "SELL";
    side   = "sell";
    console.log(`  🔴 SELL — EMA12 crossed below EMA26, closing $${positionValue.toFixed(2)}`);
  } else if (hasPosition) {
    signal = "HOLD";
    console.log(`  🟡 HOLD — in position $${positionValue.toFixed(2)}, no exit signal`);
  } else {
    signal = "WAIT";
    const reasons = [];
    if (!crossedAbove) reasons.push("no fresh crossover");
    if (!isUptrend)    reasons.push(`price below EMA200 4H ($${ema200_4h.toFixed(2)})`);
    if (rsi >= 70)     reasons.push(`RSI overbought (${rsi.toFixed(2)})`);
    console.log(`  ⏸  WAIT — ${reasons.join(", ") || "flat, watching for crossover"}`);
  }

  // ─── Execute ──────────────────────────────────────────────────────────────

  console.log(`\n── Action ${"─".repeat(47)}`);

  const entry = {
    timestamp,
    symbol:      CONFIG.symbol,
    price,
    indicators:  { ema12: ema12Curr, ema26: ema26Curr, ema200_4h, rsi, atr },
    signal,
    orderPlaced: false,
    orderId:     null,
    side:        null,
    amountUSD:   null,
    qty:         qty || null,
    stopPrice,
    paperTrading: CONFIG.paperTrading,
  };

  if (side) {
    entry.side      = side;
    entry.amountUSD = side === "buy" ? tradeAmountUSD : positionValue;

    try {
      const order = side === "buy"
        ? await placeOrder("buy", tradeAmountUSD)
        : await closePosition();
      entry.orderId     = order.id;
      entry.orderPlaced = true;
      const modeLabel   = CONFIG.paperTrading ? "PAPER" : "LIVE";
      console.log(`  ✅ ${modeLabel} ${side.toUpperCase()} placed — ${order.id}`);

      if (side === "buy") {
        state.stopPrice = stopPrice;
        console.log(`     Stop saved: $${stopPrice.toFixed(2)}`);
      } else {
        state.stopPrice = null;
      }
    } catch (err) {
      console.log(`  ❌ ORDER FAILED — ${err.message}`);
      entry.error = err.message;
    }
  } else {
    console.log(`  No order placed.`);
  }

  state.trades.push(entry);
  saveState(state);
  logToCsv(entry);

  console.log(`\n  Logged. Next check in ~15 min.`);
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

  const state = loadState();
  state.stopPrice = null;
  saveState(state);

  console.log(`${"═".repeat(57)}\n`);
}

const cmd = process.argv[2];
if (cmd === "--close-all") {
  closeAll().catch((err) => { console.error("Error:", err.message); process.exit(1); });
} else {
  run().catch((err) => { console.error("Bot error:", err.message); process.exit(1); });
}
