import "dotenv/config";
import { writeFileSync } from "fs";

const CONFIG = {
  symbol: process.env.SYMBOL || "BTC/USD",
  alpaca: {
    apiKey:    process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
  },
};

const TIMEFRAME_MAP = { "15m": "15Min", "4H": "4Hour" };

// ─── Data Fetching (with pagination) ─────────────────────────────────────────

async function fetchAllCandles(timeframe, startIso) {
  const tf = TIMEFRAME_MAP[timeframe];
  let all = [], pageToken = null;

  do {
    const url = new URL("https://data.alpaca.markets/v1beta3/crypto/us/bars");
    url.searchParams.set("symbols",   CONFIG.symbol);
    url.searchParams.set("timeframe", tf);
    url.searchParams.set("start",     startIso);
    url.searchParams.set("limit",     "10000");
    url.searchParams.set("sort",      "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        "APCA-API-KEY-ID":     CONFIG.alpaca.apiKey,
        "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      },
    });
    if (!res.ok) throw new Error(`Alpaca API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    const bars = data.bars?.[CONFIG.symbol] || [];
    for (const b of bars) {
      all.push({
        time:  new Date(b.t).getTime(),
        open:  parseFloat(b.o),
        high:  parseFloat(b.h),
        low:   parseFloat(b.l),
        close: parseFloat(b.c),
      });
    }
    pageToken = data.next_page_token || null;
    if (bars.length > 0) process.stdout.write(`\r  Fetched ${all.length} ${timeframe} bars...`);
  } while (pageToken);

  console.log();
  return all;
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function buildEMA200Series(candles4h) {
  const closes = candles4h.map(c => c.close);
  if (closes.length < 200) throw new Error(`Only ${closes.length} 4H bars — need ≥200 for EMA200`);
  const k = 2 / 201;
  let ema = closes.slice(0, 200).reduce((a, b) => a + b, 0) / 200;
  // index 0..198 → null (warmup), index 199 onward → ema value
  const series = new Array(199).fill(null);
  series.push(ema);
  for (let i = 200; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    series.push(ema);
  }
  return series; // parallel to candles4h
}

function calcRSI(closes14) {
  // closes14 must be length 15 (14 diffs)
  let gains = 0, losses = 0;
  for (let i = 1; i < closes14.length; i++) {
    const d = closes14[i] - closes14[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / 14) / avgLoss);
}

function calcATR(candles14) {
  // candles14 must be length 15 (14 TRs)
  let sum = 0;
  for (let i = 1; i < candles14.length; i++) {
    const prev = candles14[i - 1];
    const c    = candles14[i];
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  }
  return sum / 14;
}

// ─── Backtest ─────────────────────────────────────────────────────────────────

async function runBacktest() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  Backtest — 4H/15m EMA Strategy  |  1 Year");
  console.log("══════════════════════════════════════════════════════\n");

  if (!CONFIG.alpaca.apiKey) { console.error("Missing ALPACA_API_KEY in .env"); process.exit(1); }

  console.log("Fetching 4H data (EMA200 trend filter, from 2023-01-01)...");
  const candles4h   = await fetchAllCandles("4H",  "2023-01-01");

  console.log("Fetching 15m data (1 year, from 2025-04-27)...");
  const candles15m  = await fetchAllCandles("15m", "2025-04-27");

  console.log(`\n  4H bars:  ${candles4h.length}`);
  console.log(`  15m bars: ${candles15m.length}\n`);

  // Pre-build EMA200 series (parallel to candles4h)
  const ema200Series = buildEMA200Series(candles4h);

  // Pointer into 4H array — advances as 15m time advances
  let h4idx = 0;

  const EMA12_K = 2 / 13;
  const EMA26_K = 2 / 27;

  // Warmup EMA12 and EMA26 using first 26 bars
  let ema12 = candles15m.slice(0, 12).map(c => c.close).reduce((a, b) => a + b, 0) / 12;
  let ema26 = candles15m.slice(0, 26).map(c => c.close).reduce((a, b) => a + b, 0) / 26;
  for (let i = 12; i < 26; i++) ema12 = candles15m[i].close * EMA12_K + ema12 * (1 - EMA12_K);

  let ema12Prev = ema12;
  let ema26Prev = ema26;

  const STARTING_EQUITY = 100_000;
  let equity     = STARTING_EQUITY;
  let equityPeak = STARTING_EQUITY;
  let maxDrawdown = 0;

  let inPosition = false;
  let entryPrice = 0, stopPrice = 0, entryTime = 0, tradeQty = 0;

  const trades = [];

  for (let i = 26; i < candles15m.length; i++) {
    const c     = candles15m[i];
    const close = c.close;

    // Advance 4H pointer to last complete 4H bar before this 15m candle
    while (h4idx + 1 < candles4h.length && candles4h[h4idx + 1].time <= c.time) h4idx++;
    const ema200 = ema200Series[h4idx];

    // Update 15m EMAs
    ema12Prev = ema12;
    ema26Prev = ema26;
    ema12 = close * EMA12_K + ema12 * (1 - EMA12_K);
    ema26 = close * EMA26_K + ema26 * (1 - EMA26_K);

    if (!ema200) continue; // still in EMA200 warmup

    // RSI and ATR — rolling windows
    if (i < 40) continue; // need enough bars
    const rsi = calcRSI(candles15m.slice(i - 14, i + 1).map(c => c.close));
    const atr = calcATR(candles15m.slice(i - 14, i + 1));

    const crossedAbove = ema12Prev <= ema26Prev && ema12 > ema26;
    const crossedBelow = ema12Prev >= ema26Prev && ema12 < ema26;
    const isUptrend    = close > ema200;

    if (!inPosition) {
      if (crossedAbove && isUptrend && rsi < 70) {
        const stopDist = atr * 1.5;
        tradeQty   = (equity * 0.01) / stopDist;
        entryPrice = close;
        stopPrice  = close - stopDist;
        entryTime  = c.time;
        inPosition = true;
      }
    } else {
      let exitPrice = null, exitReason = null;

      if (close <= stopPrice) {
        exitPrice  = stopPrice;
        exitReason = "STOP";
      } else if (crossedBelow) {
        exitPrice  = close;
        exitReason = "SIGNAL";
      }

      if (exitPrice) {
        const pnl    = (exitPrice - entryPrice) * tradeQty;
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        equity += pnl;
        if (equity > equityPeak) equityPeak = equity;
        const dd = ((equityPeak - equity) / equityPeak) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;

        trades.push({
          entryTime:  new Date(entryTime).toISOString().slice(0, 16).replace("T", " "),
          exitTime:   new Date(c.time).toISOString().slice(0, 16).replace("T", " "),
          entryPrice: +entryPrice.toFixed(2),
          exitPrice:  +exitPrice.toFixed(2),
          stopPrice:  +stopPrice.toFixed(2),
          pnl:        +pnl.toFixed(2),
          pnlPct:     +pnlPct.toFixed(2),
          result:     pnl >= 0 ? "WIN" : "LOSS",
          exitReason,
          equity:     +equity.toFixed(2),
        });

        inPosition = false;
      }
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  const wins      = trades.filter(t => t.result === "WIN");
  const losses    = trades.filter(t => t.result === "LOSS");
  const totalPnl  = equity - STARTING_EQUITY;
  const netReturn = (totalPnl / STARTING_EQUITY) * 100;
  const winRate   = trades.length ? (wins.length / trades.length) * 100 : 0;
  const avgWin    = wins.length   ? wins.reduce((s, t)   => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss   = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = losses.length && avgLoss !== 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0))
    : null;

  const summary = {
    period: "Apr 2025 → Apr 2026",
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +winRate.toFixed(1),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    profitFactor: profitFactor ? +profitFactor.toFixed(2) : "N/A",
    maxDrawdown: +maxDrawdown.toFixed(2),
    netReturn: +netReturn.toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    finalEquity: +equity.toFixed(2),
  };

  console.log("══════════════════════════════════════════════════════");
  console.log("  Results");
  console.log("══════════════════════════════════════════════════════");
  console.log(`  Period:         ${summary.period}`);
  console.log(`  Total trades:   ${summary.totalTrades}  (${summary.wins}W / ${summary.losses}L)`);
  console.log(`  Win rate:       ${summary.winRate}%`);
  console.log(`  Avg win:        $${summary.avgWin}`);
  console.log(`  Avg loss:       $${summary.avgLoss}`);
  console.log(`  Profit factor:  ${summary.profitFactor}`);
  console.log(`  Max drawdown:   -${summary.maxDrawdown}%`);
  console.log(`  Net return:     ${summary.netReturn >= 0 ? "+" : ""}${summary.netReturn}%  ($${summary.totalPnl})`);
  console.log(`  Final equity:   $${summary.finalEquity}  (started $${STARTING_EQUITY.toLocaleString()})`);
  console.log("══════════════════════════════════════════════════════\n");

  // Save CSV for Google Sheets
  const csv = [
    "Entry Time,Exit Time,Entry Price,Exit Price,Stop Price,P&L ($),P&L (%),Result,Exit Reason,Equity After",
    ...trades.map(t =>
      [t.entryTime, t.exitTime, t.entryPrice, t.exitPrice, t.stopPrice,
       t.pnl, t.pnlPct + "%", t.result, t.exitReason, t.equity].join(",")
    ),
  ].join("\n");
  writeFileSync("backtest-results.csv", csv);
  console.log("  Saved → backtest-results.csv\n");

  return { summary, trades };
}

export { runBacktest };

runBacktest().catch(err => { console.error("\nBacktest error:", err.message); process.exit(1); });
