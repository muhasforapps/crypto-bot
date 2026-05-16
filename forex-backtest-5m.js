/**
 * 5-Min Candle Backtest with Indicators
 * RSI(14) + EMA(9/21) layered on liquidity sweep
 * Session: Asian 00:00-07:00 UTC
 * Pairs: GBP/JPY, GBP/USD, EUR/GBP, NZD/USD
 * Variants: sweep-only | +RSI | +EMA | +RSI+EMA
 */

const yf = require('yahoo-finance2');
const yahooFinance = new yf.default();

const LOT         = 0.1;
const LOOKBACK    = 48;      // 48 × 5min = 4H swing window
const MIN_SWEEP   = 0.15;
const MAX_HOLD    = 24;      // 24 × 5min = 2H max hold
const COOLDOWN    = 6;       // 6 × 5min = 30min cooldown
const MAX_PER_DAY = 30;
const RSI_PERIOD  = 14;
const EMA_FAST    = 9;
const EMA_SLOW    = 21;
const RSI_OB      = 55;      // RSI must be > 55 to confirm SHORT sweep
const RSI_OS      = 45;      // RSI must be < 45 to confirm LONG sweep

const sleep = ms => new Promise(r => setTimeout(r, ms));

function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 0 && h < 7;   // Asian early only
}

const PAIRS = [
  { symbol: 'GBPJPY=X', name: 'GBP/JPY', decimals: 3 },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', decimals: 5 },
  { symbol: 'EURGBP=X', name: 'EUR/GBP', decimals: 5 },
  { symbol: 'NZDUSD=X', name: 'NZD/USD', decimals: 5 },
];

// ── Indicators ────────────────────────────────────────────────────────────────

function calcATR(candles, period = 14) {
  const slice = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close),
    );
  }
  return sum / period;
}

function calcRSI(candles, period = RSI_PERIOD) {
  if (candles.length < period + 2) return 50;
  const slice = candles.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i].close - slice[i-1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcEMA(candles, period) {
  if (candles.length < period) return candles[candles.length - 1].close;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}

// ── Signal detection ──────────────────────────────────────────────────────────

function toDist(usd, price, pair) {
  if (pair.name.includes('JPY'))    return usd / (LOT * 100000 / price);
  if (pair.name.startsWith('USD/')) return usd / (LOT * 100000 / price);
  return usd / (LOT * 100000);
}

function detectSignal(candles, pair, tpUsd, slUsd, useRsi, useEma) {
  const need = LOOKBACK + RSI_PERIOD + EMA_SLOW + 2;
  if (candles.length < need) return null;

  const c    = candles[candles.length - 1];
  const prev = candles.slice(-(LOOKBACK + 1), -1);
  const atr  = calcATR(candles);

  const swingHi = Math.max(...prev.map(x => x.high));
  const swingLo = Math.min(...prev.map(x => x.low));

  const rsi  = calcRSI(candles);
  const emaF = calcEMA(candles, EMA_FAST);
  const emaS = calcEMA(candles, EMA_SLOW);

  const tp = toDist(tpUsd, c.close, pair);
  const sl = toDist(slUsd, c.close, pair);

  // SHORT: wick above swing high, close back below
  if (c.high > swingHi + atr * MIN_SWEEP && c.close < swingHi) {
    if (useRsi && rsi < RSI_OB)    return null; // RSI not high enough → skip
    if (useEma && c.close > emaS)  return null; // price above slow EMA → still bullish → skip
    return { direction: 'SHORT', entry: c.close, tp: c.close - tp, sl: c.close + sl, rsi };
  }

  // LONG: wick below swing low, close back above
  if (c.low < swingLo - atr * MIN_SWEEP && c.close > swingLo) {
    if (useRsi && rsi > RSI_OS)    return null; // RSI not low enough → skip
    if (useEma && c.close < emaS)  return null; // price below slow EMA → still bearish → skip
    return { direction: 'LONG',  entry: c.close, tp: c.close + tp, sl: c.close - sl, rsi };
  }

  return null;
}

// ── Backtest engine ───────────────────────────────────────────────────────────

function runBacktest(pairData, tpUsd, slUsd, useRsi, useEma) {
  const allTrades = [];
  const dailyPnl  = {};
  const cooldown  = {};
  const maxLen    = Math.max(...pairData.map(p => p.candles.length));

  let dayTrades = 0, currentDate = null;
  const startIdx = LOOKBACK + RSI_PERIOD + EMA_SLOW + 5;

  for (let i = startIdx; i < maxLen - MAX_HOLD - 1; i++) {
    const refTs   = pairData[0].candles[i]?.ts;
    const dateStr = refTs ? new Date(refTs).toISOString().slice(0, 10) : String(i);
    if (dateStr !== currentDate) { currentDate = dateStr; dayTrades = 0; }
    if (dayTrades >= MAX_PER_DAY) continue;

    for (const { pair, candles } of pairData) {
      if (i >= candles.length - MAX_HOLD - 1) continue;
      const ts = candles[i]?.ts ?? 0;
      if (!ts || !inSession(ts)) continue;

      const lastIdx = cooldown[pair.name] ?? -COOLDOWN;
      if (i - lastIdx < COOLDOWN) continue;

      const sig = detectSignal(candles.slice(0, i + 1), pair, tpUsd, slUsd, useRsi, useEma);
      if (!sig) continue;

      let pnl = 0, outcome = 'TO';
      for (let j = i + 1; j <= i + MAX_HOLD && j < candles.length; j++) {
        const cx = candles[j];
        if (sig.direction === 'SHORT') {
          if (cx.high >= sig.sl) { outcome = 'SL'; pnl = -slUsd; break; }
          if (cx.low  <= sig.tp) { outcome = 'TP'; pnl = +tpUsd; break; }
        } else {
          if (cx.low  <= sig.sl) { outcome = 'SL'; pnl = -slUsd; break; }
          if (cx.high >= sig.tp) { outcome = 'TP'; pnl = +tpUsd; break; }
        }
      }
      if (outcome === 'TO') {
        const ex   = candles[Math.min(i + MAX_HOLD, candles.length - 1)];
        const diff = sig.direction === 'SHORT' ? sig.entry - ex.close : ex.close - sig.entry;
        if (pair.name.includes('JPY'))         pnl = diff * LOT * 100000 / ex.close;
        else if (pair.name.startsWith('USD/')) pnl = diff * LOT * 100000 / ex.close;
        else                                   pnl = diff * LOT * 100000;
        pnl = Math.max(-slUsd, Math.min(tpUsd, pnl));
      }

      allTrades.push({ pair: pair.name, outcome, pnl, date: dateStr });
      if (!dailyPnl[dateStr]) dailyPnl[dateStr] = 0;
      dailyPnl[dateStr] += pnl;
      cooldown[pair.name] = i;
      dayTrades++;
      if (dayTrades >= MAX_PER_DAY) break;
    }
  }

  const total  = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins   = allTrades.filter(t => t.pnl > 0).length;
  const n      = allTrades.length;
  const wr     = n ? (wins / n * 100).toFixed(1) : '0';
  const days   = Object.keys(dailyPnl).sort();
  const avgDay = days.length ? total / days.length : 0;
  const mo     = avgDay * 22;

  let peak = 0, maxDD = 0, run = 0;
  for (const t of allTrades) {
    run += t.pnl; if (run > peak) peak = run;
    if (run - peak < maxDD) maxDD = run - peak;
  }

  return { allTrades, dailyPnl, days, total, wins, n, wr, avgDay, mo, maxDD };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFetching 5-min candles (~60 days)...\n');
  const pairData = [];
  for (const pair of PAIRS) {
    try {
      const period1 = new Date(Date.now() - 58 * 24 * 3600 * 1000);
      const result  = await yahooFinance.chart(pair.symbol,
        { interval: '5m', period1 }, { validateResult: false });
      const candles = result.quotes
        .filter(q => q.open && q.high && q.low && q.close)
        .map(q => ({ ts: q.date ? new Date(q.date).getTime() : 0,
                     open: q.open, high: q.high, low: q.low, close: q.close }));
      pairData.push({ pair, candles });
      console.log(`  ${pair.name}: ${candles.length} candles`);
    } catch (e) { console.log(`  ${pair.name}: ERROR ${e.message}`); }
    await sleep(800);
  }

  const tpSlCombos = [
    { tp: 15, sl: 5  },
    { tp: 20, sl: 5  },
    { tp: 20, sl: 10 },
    { tp: 25, sl: 10 },
    { tp: 30, sl: 10 },
  ];

  const variants = [
    { name: 'Sweep only  ', useRsi: false, useEma: false },
    { name: 'Sweep+RSI   ', useRsi: true,  useEma: false },
    { name: 'Sweep+EMA   ', useRsi: false, useEma: true  },
    { name: 'Sweep+RSI+EMA', useRsi: true,  useEma: true  },
  ];

  let bestResult = null, bestVariant = '', bestTp = 0, bestSl = 0;

  for (const v of variants) {
    console.log(`\n══ ${v.name.trim()} (RSI>${RSI_OB} / EMA21 trend) ════════════════════════════════`);
    console.log('  TP    SL   R:R   Trades  WR%    Total$   AvgDay  MaxDD   Mo@1lot');
    console.log('  ──────────────────────────────────────────────────────────────');

    for (const { tp, sl } of tpSlCombos) {
      const r   = runBacktest(pairData, tp, sl, v.useRsi, v.useEma);
      const rr  = (tp / sl).toFixed(1);
      const mo1 = r.mo / LOT;
      const flag = r.total > 0 && r.n >= 30 ? ' ✅' : '';
      if (r.total > 0 && r.n >= 20 && (!bestResult || r.total > bestResult.total))
        { bestResult = r; bestVariant = v.name.trim(); bestTp = tp; bestSl = sl; }
      console.log(
        `  $${String(tp).padEnd(3)} $${String(sl).padEnd(4)} ${rr}:1` +
        `  ${String(r.n).padStart(6)}  ${(r.wr+'%').padStart(5)}` +
        `  ${r.total>=0?'+':'-'}$${Math.abs(r.total).toFixed(0).padStart(6)}` +
        `  ${r.avgDay>=0?'+':'-'}$${Math.abs(r.avgDay).toFixed(1).padStart(5)}` +
        `  -$${Math.abs(r.maxDD).toFixed(0).padStart(5)}` +
        `  ${mo1>=0?'+':'-'}$${Math.abs(mo1).toFixed(0).padStart(5)}${flag}`
      );
    }
  }

  if (!bestResult) { console.log('\n  No profitable config found.'); return; }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`  OVERALL BEST: ${bestVariant}  |  $${bestTp} TP / $${bestSl} SL`);
  console.log(`  Trades: ${bestResult.n}  WR: ${bestResult.wr}%  Total: +$${bestResult.total.toFixed(2)}`);
  console.log(`  Avg/day: +$${bestResult.avgDay.toFixed(2)}  MaxDD: -$${Math.abs(bestResult.maxDD).toFixed(2)}`);

  // Per-pair breakdown
  const pairs = {};
  for (const t of bestResult.allTrades) {
    if (!pairs[t.pair]) pairs[t.pair] = { n:0, wins:0, pnl:0 };
    pairs[t.pair].n++; pairs[t.pair].pnl += t.pnl;
    if (t.pnl > 0) pairs[t.pair].wins++;
  }
  console.log('\n  By pair:');
  for (const [p, v] of Object.entries(pairs).sort((a,b)=>b[1].pnl-a[1].pnl)) {
    console.log(`  ${p.padEnd(10)} ${String(v.n).padStart(4)} trades  WR:${(v.wins/v.n*100).toFixed(0)}%  P&L:${v.pnl>=0?'+':''}$${v.pnl.toFixed(0)}`);
  }

  // Day-by-day
  console.log('\n  Day-by-day P&L:');
  let run = 0;
  for (const date of bestResult.days) {
    const d   = bestResult.dailyPnl[date];
    run += d;
    const bar = d > 0
      ? '█'.repeat(Math.min(Math.round(d / 2), 30))
      : '▒'.repeat(Math.min(Math.round(Math.abs(d) / 2), 30));
    const cnt = bestResult.allTrades.filter(t => t.date === date).length;
    console.log(`  ${date}  ${(d>=0?'+':'') + '$'+d.toFixed(0).padStart(4)}  run:${run>=0?'+':''}$${run.toFixed(0).padStart(5)}  ${String(cnt).padStart(2)}tr  ${bar}`);
  }

  // Scale-up
  console.log('\n  Scale-up (live trading guide):');
  for (const lot of [0.1, 0.2, 0.3, 0.5, 1.0]) {
    const scale = lot / LOT;
    const dp = bestResult.avgDay * scale, mp = dp * 22, dd = Math.abs(bestResult.maxDD) * scale;
    const flag = mp >= 500 ? ' ✅' : mp >= 200 ? ' 🔸' : '';
    console.log(`  ${lot.toFixed(1)} lot  +$${dp.toFixed(0)}/day  +$${mp.toFixed(0)}/month  MaxDD:-$${dd.toFixed(0)}${flag}`);
  }
  console.log(`\n${'═'.repeat(66)}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
