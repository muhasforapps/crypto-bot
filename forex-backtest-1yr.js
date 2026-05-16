/**
 * 1-Year Backtest — 1H candles, Asian session, RSI + Sweep
 * Yahoo Finance provides ~2 years of 1H data
 * LOOKBACK=4 candles = 4H swing (same window as 5min×48)
 * Session: 00:00–07:00 UTC
 */

const yf = require('yahoo-finance2');
const yahooFinance = new yf.default();

const LOT         = 0.1;
const LOOKBACK    = 4;       // 4 × 1H = 4H swing window
const MIN_SWEEP   = 0.15;
const MAX_HOLD    = 4;       // 4H max hold
const COOLDOWN    = 1;       // 1H cooldown per pair
const MAX_PER_DAY = 10;
const RSI_PERIOD  = 14;
const RSI_OB      = 55;
const RSI_OS      = 45;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 0 && h < 7;
}

const PAIRS = [
  { symbol: 'GBPJPY=X', name: 'GBP/JPY', decimals: 3 },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', decimals: 5 },
  { symbol: 'EURGBP=X', name: 'EUR/GBP', decimals: 5 },
  { symbol: 'NZDUSD=X', name: 'NZD/USD', decimals: 5 },
];

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

function toDist(usd, price, pair) {
  if (pair.name.includes('JPY'))    return usd / (LOT * 100000 / price);
  if (pair.name.startsWith('USD/')) return usd / (LOT * 100000 / price);
  return usd / (LOT * 100000);
}

function detectSignal(candles, pair, tpUsd, slUsd, useRsi) {
  const need = LOOKBACK + RSI_PERIOD + 2;
  if (candles.length < need) return null;

  const c    = candles[candles.length - 1];
  const prev = candles.slice(-(LOOKBACK + 1), -1);
  const atr  = calcATR(candles);
  const rsi  = calcRSI(candles);

  const swingHi = Math.max(...prev.map(x => x.high));
  const swingLo = Math.min(...prev.map(x => x.low));

  const tp = toDist(tpUsd, c.close, pair);
  const sl = toDist(slUsd, c.close, pair);

  if (c.high > swingHi + atr * MIN_SWEEP && c.close < swingHi) {
    if (useRsi && rsi < RSI_OB) return null;
    return { direction: 'SHORT', entry: c.close, tp: c.close - tp, sl: c.close + sl };
  }
  if (c.low < swingLo - atr * MIN_SWEEP && c.close > swingLo) {
    if (useRsi && rsi > RSI_OS) return null;
    return { direction: 'LONG',  entry: c.close, tp: c.close + tp, sl: c.close - sl };
  }
  return null;
}

function runBacktest(pairData, tpUsd, slUsd, useRsi) {
  const allTrades = [];
  const dailyPnl  = {};
  const cooldown  = {};
  const maxLen    = Math.max(...pairData.map(p => p.candles.length));

  let dayTrades = 0, currentDate = null;
  const startIdx = LOOKBACK + RSI_PERIOD + 5;

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

      const sig = detectSignal(candles.slice(0, i + 1), pair, tpUsd, slUsd, useRsi);
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

      const month = dateStr.slice(0, 7);
      allTrades.push({ pair: pair.name, outcome, pnl, date: dateStr, month });
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

  let peak = 0, maxDD = 0, run = 0;
  for (const t of allTrades) {
    run += t.pnl; if (run > peak) peak = run;
    if (run - peak < maxDD) maxDD = run - peak;
  }

  return { allTrades, dailyPnl, days, total, wins, n, wr, avgDay, maxDD };
}

async function main() {
  console.log('\nFetching 1H candles (~365 days)...\n');
  const pairData = [];
  for (const pair of PAIRS) {
    try {
      const period1 = new Date(Date.now() - 365 * 24 * 3600 * 1000);
      const result  = await yahooFinance.chart(pair.symbol,
        { interval: '1h', period1 }, { validateResult: false });
      const candles = result.quotes
        .filter(q => q.open && q.high && q.low && q.close)
        .map(q => ({ ts: q.date ? new Date(q.date).getTime() : 0,
                     open: q.open, high: q.high, low: q.low, close: q.close }));
      pairData.push({ pair, candles });
      console.log(`  ${pair.name}: ${candles.length} candles`);
    } catch (e) { console.log(`  ${pair.name}: ERROR ${e.message}`); }
    await sleep(800);
  }

  const configs = [
    { tp: 15, sl: 5  },
    { tp: 20, sl: 5  },
    { tp: 20, sl: 10 },
    { tp: 25, sl: 10 },
    { tp: 30, sl: 10 },
  ];

  let bestRsi = null, bestBase = null;

  for (const [label, useRsi] of [['Sweep only', false], ['Sweep + RSI(14)', true]]) {
    console.log(`\n══ ${label} — 1H — Asian 00-07 UTC — 1 year ════════════════════════`);
    console.log('  TP    SL   R:R   Trades  WR%    Total$   AvgDay  MaxDD   Mo@1lot');
    console.log('  ──────────────────────────────────────────────────────────────');
    for (const { tp, sl } of configs) {
      const r   = runBacktest(pairData, tp, sl, useRsi);
      const rr  = (tp / sl).toFixed(1);
      const mo1 = r.avgDay / LOT * 22;
      const flag = r.total > 0 && r.n >= 50 ? ' ✅' : '';
      if (useRsi && r.total > 0 && r.n >= 30 && (!bestRsi || r.total > bestRsi.total))
        bestRsi = { ...r, tp, sl };
      if (!useRsi && r.total > 0 && r.n >= 30 && (!bestBase || r.total > bestBase.total))
        bestBase = { ...r, tp, sl };
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

  const best = bestRsi || bestBase;
  const bestLabel = bestRsi ? 'Sweep + RSI' : 'Sweep only';
  if (!best) { console.log('\n  No profitable config found.'); return; }

  console.log(`\n══ BEST OVER 1 YEAR: ${bestLabel}  $${best.tp} TP / $${best.sl} SL ══════════`);
  console.log(`  Trades: ${best.n}  WR: ${best.wr}%  Total: ${best.total>=0?'+':''}$${best.total.toFixed(2)}`);
  console.log(`  Avg/day: ${best.avgDay>=0?'+':''}$${best.avgDay.toFixed(2)}  MaxDD: -$${Math.abs(best.maxDD).toFixed(2)}`);

  // Monthly breakdown
  const monthly = {};
  for (const t of best.allTrades) {
    if (!monthly[t.month]) monthly[t.month] = { n:0, wins:0, pnl:0 };
    monthly[t.month].n++; monthly[t.month].pnl += t.pnl;
    if (t.pnl > 0) monthly[t.month].wins++;
  }
  console.log('\n  Monthly P&L:');
  let cumRun = 0;
  for (const [m, v] of Object.entries(monthly).sort()) {
    cumRun += v.pnl;
    const bar = v.pnl > 0
      ? '█'.repeat(Math.min(Math.round(v.pnl / 5), 25))
      : '▒'.repeat(Math.min(Math.round(Math.abs(v.pnl) / 5), 25));
    const wr = (v.wins / v.n * 100).toFixed(0);
    console.log(
      `  ${m}  ${String(v.n).padStart(3)}tr  WR:${wr.padStart(3)}%` +
      `  ${v.pnl>=0?'+':''}$${v.pnl.toFixed(0).padStart(5)}` +
      `  run:${cumRun>=0?'+':''}$${cumRun.toFixed(0).padStart(6)}  ${bar}`
    );
  }

  // Per-pair
  const pairs = {};
  for (const t of best.allTrades) {
    if (!pairs[t.pair]) pairs[t.pair] = { n:0, wins:0, pnl:0 };
    pairs[t.pair].n++; pairs[t.pair].pnl += t.pnl;
    if (t.pnl > 0) pairs[t.pair].wins++;
  }
  console.log('\n  By pair (1 year):');
  for (const [p, v] of Object.entries(pairs).sort((a,b)=>b[1].pnl-a[1].pnl)) {
    console.log(`  ${p.padEnd(10)} ${String(v.n).padStart(4)} trades  WR:${(v.wins/v.n*100).toFixed(0)}%  P&L:${v.pnl>=0?'+':''}$${v.pnl.toFixed(0)}`);
  }

  // Scale-up
  console.log('\n  Scale-up:');
  for (const lot of [0.1, 0.2, 0.3, 0.5, 1.0]) {
    const scale = lot / LOT;
    const dp = best.avgDay * scale, mp = dp * 22, dd = Math.abs(best.maxDD) * scale;
    const flag = mp >= 500 ? ' ✅' : mp >= 200 ? ' 🔸' : '';
    console.log(`  ${lot.toFixed(1)} lot  ${dp>=0?'+':''}$${dp.toFixed(0)}/day  ${mp>=0?'+':''}$${mp.toFixed(0)}/month  MaxDD:-$${dd.toFixed(0)}${flag}`);
  }
  console.log(`\n${'═'.repeat(66)}`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
