/**
 * 15-Min Price Action Backtest
 * Session: Asian only 00:00-09:00 UTC
 * Pairs: GBP/JPY, GBP/USD, EUR/GBP, NZD/USD (best performers)
 * Liquidity sweep on 15min chart
 * Yahoo Finance gives ~60 days of 15min data
 */

const yf = require('yahoo-finance2');
const yahooFinance = new yf.default();

const LOT         = 0.1;
const LOOKBACK    = 16;      // 16 × 15min = 4H swing window
const MIN_SWEEP   = 0.15;    // 15% of ATR
const MAX_HOLD    = 16;      // 16 candles = 4H max hold
const COOLDOWN    = 2;       // 2 candles = 30min cooldown per pair
const MAX_PER_DAY = 10;      // max 10 trades/day across all pairs

// Sessions (UTC hours)
function inSession(ts) {
  const h = new Date(ts).getUTCHours();
  return h >= 0 && h < 9;   // Asian session only
}
function sessionLabel(ts) {
  const h = new Date(ts).getUTCHours();
  if (h >= 7 && h < 9)  return 'Asian-Late';
  if (h >= 0 && h < 7)  return 'Asian-Early';
  return 'Other';
}

const PAIRS = [
  { symbol: 'GBPJPY=X', name: 'GBP/JPY', decimals: 3 },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', decimals: 5 },
  { symbol: 'EURGBP=X', name: 'EUR/GBP', decimals: 5 },
  { symbol: 'NZDUSD=X', name: 'NZD/USD', decimals: 5 },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

function toDist(usd, price, pair) {
  if (pair.name.includes('JPY'))    return usd / (LOT * 100000 / price);
  if (pair.name.startsWith('USD/')) return usd / (LOT * 100000 / price);
  return usd / (LOT * 100000);
}

function detectSweep(candles, pair, tpUsd, slUsd) {
  if (candles.length < LOOKBACK + 2) return null;
  const c    = candles[candles.length - 1];
  const prev = candles.slice(-(LOOKBACK + 1), -1);
  const atr  = calcATR(candles);

  const swingHi = Math.max(...prev.map(x => x.high));
  const swingLo = Math.min(...prev.map(x => x.low));

  const tp = toDist(tpUsd, c.close, pair);
  const sl = toDist(slUsd, c.close, pair);

  if (c.high > swingHi + atr * MIN_SWEEP && c.close < swingHi) {
    return { direction: 'SHORT', entry: c.close, tp: c.close - tp, sl: c.close + sl };
  }
  if (c.low < swingLo - atr * MIN_SWEEP && c.close > swingLo) {
    return { direction: 'LONG',  entry: c.close, tp: c.close + tp, sl: c.close - sl };
  }
  return null;
}

function runBacktest(pairData, tpUsd, slUsd) {
  const allTrades = [];
  const dailyPnl  = {};
  const cooldown  = {};
  const maxLen    = Math.max(...pairData.map(p => p.candles.length));

  let dayTrades = 0, currentDate = null;

  for (let i = LOOKBACK + 15; i < maxLen - MAX_HOLD - 1; i++) {
    // Date tracking using first pair's timestamp
    const refTs  = pairData[0].candles[i]?.ts;
    const dateStr = refTs ? new Date(refTs).toISOString().slice(0, 10) : String(i);
    if (dateStr !== currentDate) {
      currentDate = dateStr;
      dayTrades = 0;
    }
    if (dayTrades >= MAX_PER_DAY) continue;

    for (const { pair, candles } of pairData) {
      if (i >= candles.length - MAX_HOLD - 1) continue;

      const ts = candles[i]?.ts ?? 0;
      if (!ts || !inSession(ts)) continue;

      const lastIdx = cooldown[pair.name] ?? -COOLDOWN;
      if (i - lastIdx < COOLDOWN) continue;

      const sig = detectSweep(candles.slice(0, i + 1), pair, tpUsd, slUsd);
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
        if (pair.name.includes('JPY'))    pnl = diff * LOT * 100000 / ex.close;
        else if (pair.name.startsWith('USD/')) pnl = diff * LOT * 100000 / ex.close;
        else pnl = diff * LOT * 100000;
        pnl = Math.max(-slUsd, Math.min(tpUsd, pnl));
      }

      const sess = sessionLabel(ts);
      allTrades.push({ pair: pair.name, outcome, pnl, date: dateStr, sess });
      if (!dailyPnl[dateStr]) dailyPnl[dateStr] = 0;
      dailyPnl[dateStr] += pnl;
      cooldown[pair.name] = i;
      dayTrades++;
      if (dayTrades >= MAX_PER_DAY) break;
    }
  }

  const days   = Object.keys(dailyPnl).sort();
  const total  = allTrades.reduce((s, t) => s + t.pnl, 0);
  const wins   = allTrades.filter(t => t.pnl > 0).length;
  const n      = allTrades.length;
  const wr     = n ? (wins / n * 100).toFixed(1) : '0';
  const avgDay = days.length ? total / days.length : 0;

  let peak = 0, maxDD = 0, run = 0;
  for (const t of allTrades) {
    run += t.pnl; if (run > peak) peak = run;
    if (run - peak < maxDD) maxDD = run - peak;
  }

  return { allTrades, dailyPnl, days, total, wins, n, wr, avgDay, maxDD };
}

async function main() {
  console.log('\nFetching 15-min candles (~60 days)...\n');
  const pairData = [];
  for (const pair of PAIRS) {
    try {
      const period1 = new Date(Date.now() - 58 * 24 * 3600 * 1000);
      const result  = await yahooFinance.chart(pair.symbol,
        { interval: '15m', period1 }, { validateResult: false });
      const candles = result.quotes
        .filter(q => q.open && q.high && q.low && q.close)
        .map(q => ({ ts: q.date ? new Date(q.date).getTime() : 0,
                     open: q.open, high: q.high, low: q.low, close: q.close }));
      pairData.push({ pair, candles });
      console.log(`  ${pair.name}: ${candles.length} candles`);
    } catch (e) { console.log(`  ${pair.name}: ERROR ${e.message}`); }
    await sleep(800);
  }

  // Grid: TP × SL combos
  const configs = [
    { tp: 10, sl: 5  },
    { tp: 15, sl: 5  },
    { tp: 15, sl: 10 },
    { tp: 20, sl: 5  },
    { tp: 20, sl: 10 },
    { tp: 25, sl: 10 },
    { tp: 30, sl: 10 },
    { tp: 40, sl: 10 },
  ];

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  15-MIN PRICE ACTION — Asian only (00-09 UTC) — 4 pairs — ~60 days');
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  TP    SL   R:R   Trades  WR%    Total$   AvgDay  MaxDD   Mo@1lot');
  console.log('  ──────────────────────────────────────────────────────────────');

  let best = null;
  for (const { tp, sl } of configs) {
    const r   = runBacktest(pairData, tp, sl);
    const rr  = (tp / sl).toFixed(1);
    const mo  = r.avgDay / LOT * 1.0 * 22;
    const flag = r.total > 0 && r.n >= 30 ? ' ✅' : '';
    if (r.total > 0 && r.n >= 20 && (!best || r.total > best.total))
      best = { ...r, tp, sl };
    console.log(
      `  $${String(tp).padEnd(3)} $${String(sl).padEnd(4)} ${rr}:1` +
      `  ${String(r.n).padStart(6)}  ${(r.wr+'%').padStart(5)}` +
      `  ${(r.total>=0?'+':'')}$${Math.abs(r.total).toFixed(0).padStart(6)}` +
      `  ${(r.avgDay>=0?'+':'-')}$${Math.abs(r.avgDay).toFixed(1).padStart(5)}` +
      `  -$${Math.abs(r.maxDD).toFixed(0).padStart(5)}` +
      `  ${mo>=0?'+':'-'}$${Math.abs(mo).toFixed(0).padStart(5)}${flag}`
    );
  }

  if (!best) { console.log('\n  No profitable config found.'); return; }

  console.log(`\n══ BEST: $${best.tp} TP / $${best.sl} SL ══════════════════════════════════════`);
  console.log(`  Trades: ${best.n}  WR: ${best.wr}%  Total: +$${best.total.toFixed(2)}`);
  console.log(`  Avg/day: +$${best.avgDay.toFixed(2)}  MaxDD: -$${Math.abs(best.maxDD).toFixed(2)}\n`);

  // Per-session breakdown
  const sess = {};
  for (const t of best.allTrades) {
    if (!sess[t.sess]) sess[t.sess] = { n:0, wins:0, pnl:0 };
    sess[t.sess].n++; sess[t.sess].pnl += t.pnl;
    if (t.pnl > 0) sess[t.sess].wins++;
  }
  console.log('  By session:');
  for (const [s, v] of Object.entries(sess).sort((a,b)=>b[1].pnl-a[1].pnl)) {
    console.log(`  ${s.padEnd(10)} ${String(v.n).padStart(4)} trades  WR:${(v.wins/v.n*100).toFixed(0)}%  P&L:${v.pnl>=0?'+':''}$${v.pnl.toFixed(0)}`);
  }

  // Per-pair breakdown
  const pairs = {};
  for (const t of best.allTrades) {
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
  for (const date of best.days) {
    const d   = best.dailyPnl[date];
    run += d;
    const bar = d > 0
      ? '█'.repeat(Math.min(Math.round(d / 3), 25))
      : '▒'.repeat(Math.min(Math.round(Math.abs(d) / 3), 25));
    const cnt = best.allTrades.filter(t => t.date === date).length;
    console.log(`  ${date}  ${(d>=0?'+':'') + '$'+d.toFixed(0).padStart(4)}  run:${run>=0?'+':''}$${run.toFixed(0).padStart(5)}  ${String(cnt).padStart(2)}tr  ${bar}`);
  }

  // Scale-up
  console.log('\n  Scale-up:');
  for (const lot of [0.1, 0.3, 0.5, 1.0]) {
    const scale = lot / LOT;
    const dp = best.avgDay * scale, mp = dp * 22, dd = Math.abs(best.maxDD) * scale;
    const flag = mp >= 500 ? ' ✅' : mp >= 200 ? ' 🔸' : '';
    console.log(`  ${lot.toFixed(1)} lot  +$${dp.toFixed(0)}/day  +$${mp.toFixed(0)}/month  MaxDD:-$${dd.toFixed(0)}${flag}`);
  }
  console.log('\n══════════════════════════════════════════════════════════════════');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
