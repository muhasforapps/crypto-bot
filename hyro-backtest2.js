/**
 * HyroTrader Challenge Backtest v2 — EXTENDED SWEEP
 * ─────────────────────────────────────────────────
 * Runs two passes:
 *   Pass 1 (15m) — original timeframe, more variants incl. asymmetric R:R
 *   Pass 2 (1H)  — hourly candles, same variants (fewer trades, stronger signals)
 *
 * New variants vs v1:
 *   E-match-2    TP 2% / SL 2%
 *   F-match-4    TP 4% / SL 4%
 *   G-asym-3:2   TP 3% / SL 2%  ← 1.5:1 R:R
 *   H-asym-2:1   TP 4% / SL 2%  ← 2:1 R:R
 *   I-asym-5:3   TP 5% / SL 3%  ← 1.67:1 R:R
 *   J-big-3:3    TP 3% / SL 3%, bigOnly
 *   K-big-asym   TP 5% / SL 3%, bigOnly
 */

const axios = require('axios');

// ── Shared config ─────────────────────────────────────────────────────────────
const INITIAL_BALANCE = 10000;
const TRADE_NOTIONAL  = 500;
const MAX_POSITIONS   = 2;
const MAX_COINS       = 4;
const GRID_STEP_15    = 0.005;
const GRID_STEP_1H    = 0.010;
const GRID_BIG        = 0.01;
const BIG_MOVE_PCT    = 10;
const EMA_FAST        = 20;
const EMA_SLOW        = 50;
const MIN_EMA_SEP     = 0.008;
const SWITCH_COOL     = 16;
const MIN_TREND_PCT   = 0.72;
const RSI_PERIOD      = 14;
const RSI_LONG_MAX    = 70;
const RSI_SHORT_MIN   = 30;
const SL_COOL_15      = 2;    // candles after SL (15m)
const SL_COOL_1H      = 1;    // candles after SL (1H)
const DAILY_DD_HALT   = 0.04;
const DAILY_DD_FLAT   = 0.045;
const MAX_LOSS_FLAT   = 0.09;
const PROFIT_TARGET   = 0.10;
const DAYS            = 30;
const MIN_VOL_USD     = 30_000_000;
const MIN_CHANGE      = 2;
const TOP_N           = 40;
const FETCH_COINS     = 12;

// ── Variants ─────────────────────────────────────────────────────────────────
const VARIANTS = [
  // originals
  { name: 'baseline',    tp: 0.0067, tpBig: 0.05, sl: 0.03, bigOnly: false },
  { name: 'A-big-1:1',   tp: 0.05,   tpBig: 0.05, sl: 0.05, bigOnly: true  },
  { name: 'B-match-3',   tp: 0.03,   tpBig: 0.03, sl: 0.03, bigOnly: false },
  { name: 'C-scalp-1',   tp: 0.01,   tpBig: 0.01, sl: 0.01, bigOnly: false },
  { name: 'D-wider-SL',  tp: 0.0067, tpBig: 0.05, sl: 0.05, bigOnly: false },
  // new
  { name: 'E-match-2',   tp: 0.02,   tpBig: 0.02, sl: 0.02, bigOnly: false },
  { name: 'F-match-4',   tp: 0.04,   tpBig: 0.04, sl: 0.04, bigOnly: false },
  { name: 'G-asym-3:2',  tp: 0.03,   tpBig: 0.05, sl: 0.02, bigOnly: false },
  { name: 'H-asym-4:2',  tp: 0.04,   tpBig: 0.05, sl: 0.02, bigOnly: false },
  { name: 'I-asym-5:3',  tp: 0.05,   tpBig: 0.05, sl: 0.03, bigOnly: false },
  { name: 'J-big-3:3',   tp: 0.03,   tpBig: 0.03, sl: 0.03, bigOnly: true  },
  { name: 'K-big-asym',  tp: 0.05,   tpBig: 0.05, sl: 0.03, bigOnly: true  },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period).fill(seed);
  let ema = seed;
  for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); result.push(ema); }
  return result;
}

function calcRSIArray(closes, period = RSI_PERIOD) {
  const out = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

async function fetchTickers() {
  const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 });
  return res.data.result.list
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000') && !t.symbol.includes('USDC'))
    .map(t => ({ symbol: t.symbol, change24h: parseFloat(t.price24hPcnt) * 100, vol24h: parseFloat(t.turnover24h) }))
    .filter(t => t.vol24h >= MIN_VOL_USD && Math.abs(t.change24h) >= MIN_CHANGE)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, TOP_N);
}

async function fetchKlines(symbol, interval) {
  const candlesPerDay = interval === '60' ? 24 : 96;
  const totalNeeded = DAYS * candlesPerDay;
  const perPage = 1000;
  let all = [], end;
  for (let p = 0; p < Math.ceil(totalNeeded / perPage); p++) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${perPage}` + (end ? `&end=${end}` : '');
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data.retCode !== 0) break;
    const page = res.data.result.list.map(c => ({ ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4] }));
    if (!page.length) break;
    all = all.concat(page);
    end = Math.min(...page.map(c => c.ts)) - 1;
    await sleep(120);
  }
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

function runPortfolio(coinSeries, change24hMap, cfg, gridStep, slCoolCandles) {
  const coins = Object.keys(coinSeries);
  if (!coins.length) return null;

  const tsSet = new Set();
  for (const sym of coins) for (const c of coinSeries[sym]) tsSet.add(c.ts);
  const timeline = [...tsSet].sort((a, b) => a - b);

  const ema20 = {}, ema50 = {}, rsiArr = {}, idxByTs = {};
  for (const sym of coins) {
    const closes = coinSeries[sym].map(c => c.close);
    ema20[sym]  = calcEMA(closes, EMA_FAST);
    ema50[sym]  = calcEMA(closes, EMA_SLOW);
    rsiArr[sym] = calcRSIArray(closes, RSI_PERIOD);
    idxByTs[sym] = new Map(coinSeries[sym].map((c, i) => [c.ts, i]));
  }

  const active = {};
  let equity = INITIAL_BALANCE, realizedPnl = 0;
  const trades = [];
  let curDay = null, dayStart = INITIAL_BALANCE, dayPeak = INITIAL_BALANCE;
  let maxDailyDD = 0;
  const haltDays = new Set(), flatDays = new Set();
  let breached = false, breachDay = null;
  let stopped = false, halted = false;

  for (const ts of timeline) {
    if (stopped) break;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (day !== curDay) { curDay = day; dayStart = equity; dayPeak = equity; halted = false; }

    let unrealized = 0;
    for (const sym of Object.keys(active)) {
      const i = idxByTs[sym]?.get(ts); if (i == null) continue;
      const px = coinSeries[sym][i].close;
      for (const p of active[sym].positions) {
        unrealized += p.mode === 'long' ? (px - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - px) / p.entry * TRADE_NOTIONAL;
      }
    }
    equity = INITIAL_BALANCE + realizedPnl + unrealized;
    if (equity > dayPeak) dayPeak = equity;
    const dailyDD = (dayPeak - equity) / INITIAL_BALANCE;
    const totalPnlPct = (equity - INITIAL_BALANCE) / INITIAL_BALANCE;
    if (dailyDD > maxDailyDD) maxDailyDD = dailyDD;
    if (!breached && (dailyDD >= 0.05 || totalPnlPct <= -0.10)) { breached = true; breachDay = day; }

    const flatAll = (type) => {
      for (const sym of Object.keys(active)) {
        const i = idxByTs[sym]?.get(ts); if (i == null) continue;
        const px = coinSeries[sym][i].close;
        for (const p of active[sym].positions) {
          const pnl = p.mode === 'long' ? (px - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - px) / p.entry * TRADE_NOTIONAL;
          realizedPnl += pnl; trades.push({ ts, sym, type, pnl });
        }
        active[sym].positions = [];
      }
    };

    if (totalPnlPct <= -MAX_LOSS_FLAT) { flatAll('maxloss-flat'); stopped = true; flatDays.add(day); continue; }
    if (totalPnlPct >= PROFIT_TARGET)  { flatAll('target');        stopped = true; continue; }
    if (dailyDD >= DAILY_DD_FLAT && !flatDays.has(day)) { flatAll('day-flat'); flatDays.add(day); halted = true; }
    else if (dailyDD >= DAILY_DD_HALT) { halted = true; haltDays.add(day); }

    for (const sym of coins) {
      const i = idxByTs[sym]?.get(ts); if (i == null) continue;
      const c = coinSeries[sym][i];
      if (i < EMA_SLOW + 1) continue;
      const e20 = ema20[sym][i], e50 = ema50[sym][i];
      const newMode = e20 > e50 ? 'long' : 'short';
      const emaSep = Math.abs(e20 - e50) / e50;
      const isBig = Math.abs(change24hMap[sym] || 0) >= BIG_MOVE_PCT;
      const tpPct = isBig ? cfg.tpBig : cfg.tp;

      const a = active[sym];
      if (a) {
        for (let pi = a.positions.length - 1; pi >= 0; pi--) {
          const p = a.positions[pi];
          const slHit = p.mode === 'long' ? c.low <= p.sl : c.high >= p.sl;
          if (slHit) {
            const pnl = p.mode === 'long' ? (p.sl - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - p.sl) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl; trades.push({ ts, sym, type: 'sl', pnl });
            a.positions.splice(pi, 1);
            a.cooldownUntilIdx = i + slCoolCandles;
            continue;
          }
          const tpHit = p.mode === 'long' ? c.high >= p.tp : c.low <= p.tp;
          if (tpHit) {
            const pnl = p.mode === 'long' ? (p.tp - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - p.tp) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl; trades.push({ ts, sym, type: 'tp', pnl });
            a.positions.splice(pi, 1);
          }
        }
        if (a.mode !== newMode && (i - (a.lastSwitch ?? -SWITCH_COOL)) >= SWITCH_COOL) {
          for (const p of a.positions) {
            const pnl = p.mode === 'long' ? (c.close - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - c.close) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl; trades.push({ ts, sym, type: 'switch', pnl });
          }
          a.positions = []; a.mode = newMode; a.lastSwitch = i;
        }
      }

      const allowNewEntries = !halted && !stopped;
      if (!allowNewEntries) continue;
      if (cfg.bigOnly && !isBig) continue;
      if (!a) {
        if (Object.keys(active).length >= MAX_COINS) continue;
        let trendCount = 0;
        for (let j = EMA_SLOW; j <= i; j++) {
          if (Math.abs(ema20[sym][j] - ema50[sym][j]) / ema50[sym][j] >= MIN_EMA_SEP) trendCount++;
        }
        if (trendCount / (i - EMA_SLOW + 1) < MIN_TREND_PCT) continue;
        active[sym] = { mode: newMode, positions: [], lastSwitch: -SWITCH_COOL };
      }
      const s = active[sym];
      if (s.positions.length >= MAX_POSITIONS) continue;
      if (emaSep < MIN_EMA_SEP) continue;
      if (s.cooldownUntilIdx && i < s.cooldownUntilIdx) continue;
      const rsi = rsiArr[sym][i];
      if (s.mode === 'long'  && rsi > RSI_LONG_MAX)  continue;
      if (s.mode === 'short' && rsi < RSI_SHORT_MIN) continue;
      const lastEntry = s.positions.length ? s.positions[s.positions.length - 1].entry : null;
      const dist = lastEntry ? Math.abs(c.close - lastEntry) / lastEntry : 1;
      if (dist < gridStep) continue;
      const tp = s.mode === 'long' ? c.close * (1 + tpPct) : c.close * (1 - tpPct);
      const sl = s.mode === 'long' ? c.close * (1 - cfg.sl) : c.close * (1 + cfg.sl);
      s.positions.push({ entry: c.close, tp, sl, mode: s.mode });
    }
  }

  let finalUnrealized = 0;
  for (const sym of Object.keys(active)) {
    const last = coinSeries[sym][coinSeries[sym].length - 1].close;
    for (const p of active[sym].positions) {
      finalUnrealized += p.mode === 'long' ? (last - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - last) / p.entry * TRADE_NOTIONAL;
    }
  }
  const finalEquity = INITIAL_BALANCE + realizedPnl + finalUnrealized;
  const counts = {}, sums = {};
  for (const t of trades) { counts[t.type] = (counts[t.type]||0)+1; sums[t.type]=(sums[t.type]||0)+t.pnl; }

  return {
    cfg, finalEquity, realizedPnl, finalUnrealized,
    pnlPct: (finalEquity - INITIAL_BALANCE) / INITIAL_BALANCE,
    breached, breachDay, maxDailyDD,
    halts: haltDays.size, flats: flatDays.size,
    stopped, target: trades.some(t => t.type === 'target'),
    counts, sums, totalTrades: trades.length,
  };
}

function printTable(results, label, numCoins) {
  console.log(`\n${'═'.repeat(104)}`);
  console.log(`  ${label}  —  30 days  —  ${numCoins} coins`);
  console.log(`${'═'.repeat(104)}`);
  console.log(`  Variant        Final$     P&L%     MaxDD   TPs   SLs  Switch  WR%   Halt Flat  Status`);
  console.log(`  ${'─'.repeat(100)}`);
  for (const r of results) {
    const tp = r.counts.tp||0, sl = r.counts.sl||0;
    const wr = tp+sl > 0 ? ((tp/(tp+sl))*100).toFixed(0) : ' —';
    const status = r.breached ? '❌BREACH' : r.target ? '✅TARGET' : r.stopped ? '🛑STOP' : r.pnlPct > 0 ? '🟢PROFIT' : '🟠LOSS';
    console.log(
      `  ${r.cfg.name.padEnd(14)} ` +
      `$${r.finalEquity.toFixed(0).padStart(6)}  ` +
      `${(r.pnlPct*100>=0?'+':'')+(r.pnlPct*100).toFixed(2).padStart(6)}%  ` +
      `${(r.maxDailyDD*100).toFixed(2).padStart(5)}%  ` +
      `${String(tp).padStart(4)}  ` +
      `${String(sl).padStart(4)}  ` +
      `${String(r.counts.switch||0).padStart(4)}  ` +
      `${String(wr).padStart(4)}%  ` +
      `${String(r.halts).padStart(3)}  ` +
      `${String(r.flats).padStart(3)}   ` +
      `${status}`
    );
  }
  console.log(`  ${'─'.repeat(100)}`);

  const safe = results.filter(r => !r.breached && r.pnlPct > 0);
  const ranked = [...safe].sort((a,b) => {
    if (a.target !== b.target) return a.target ? -1 : 1;
    return b.pnlPct - a.pnlPct;
  });
  const winner = ranked[0];
  if (!winner) {
    console.log(`  🟠 No profitable non-breaching variant found.`);
  } else {
    const rr = (winner.cfg.tpBig / winner.cfg.sl).toFixed(2);
    console.log(`\n  ✅ WINNER: "${winner.cfg.name}"  →  +${(winner.pnlPct*100).toFixed(2)}%  maxDD ${(winner.maxDailyDD*100).toFixed(2)}%  R:R big=${rr}`);
    console.log(`     TP ${(winner.cfg.tp*100).toFixed(2)}% / TP_BIG ${(winner.cfg.tpBig*100).toFixed(2)}% / SL ${(winner.cfg.sl*100).toFixed(2)}% / bigOnly ${winner.cfg.bigOnly}`);
    console.log(`     Env vars: HYRO_STOP_LOSS_PCT=${winner.cfg.sl} (and adjust TP in bot if needed)`);
  }
  console.log(`${'═'.repeat(104)}\n`);
}

async function main() {
  console.log('\nFetching top movers...');
  const tickers = await fetchTickers();
  console.log(`Found ${tickers.length} candidates\n`);

  const top = tickers.slice(0, FETCH_COINS);

  // ── Pass 1: 15-minute candles ─────────────────────────────────────────────
  console.log(`Fetching 15m klines for ${top.length} coins...`);
  const series15 = {}; const ch24 = {};
  for (const t of top) {
    await sleep(150);
    try {
      const k = await fetchKlines(t.symbol, '15');
      if (k.length < EMA_SLOW + 20) continue;
      series15[t.symbol] = k; ch24[t.symbol] = t.change24h;
      console.log(`  ${t.symbol.padEnd(14)} 15m  ${k.length.toString().padStart(4)} candles  24h:${(t.change24h>=0?'+':'')+t.change24h.toFixed(1)}%`);
    } catch(e) { console.log(`  ${t.symbol}  err: ${e.message}`); }
  }

  console.log(`\nRunning ${VARIANTS.length} variants on 15m...`);
  const res15 = VARIANTS.map(cfg => runPortfolio(series15, ch24, cfg, GRID_STEP_15, SL_COOL_15));
  printTable(res15, 'PASS 1 — 15m CANDLES', Object.keys(series15).length);

  // ── Pass 2: 1H candles ────────────────────────────────────────────────────
  console.log(`Fetching 1H klines for ${top.length} coins...`);
  const series1h = {};
  for (const t of top) {
    await sleep(150);
    try {
      const k = await fetchKlines(t.symbol, '60');
      if (k.length < EMA_SLOW + 20) continue;
      series1h[t.symbol] = k;
      console.log(`  ${t.symbol.padEnd(14)} 1H   ${k.length.toString().padStart(4)} candles`);
    } catch(e) { console.log(`  ${t.symbol}  err: ${e.message}`); }
  }

  console.log(`\nRunning ${VARIANTS.length} variants on 1H...`);
  const res1h = VARIANTS.map(cfg => runPortfolio(series1h, ch24, cfg, GRID_STEP_1H, SL_COOL_1H));
  printTable(res1h, 'PASS 2 — 1H CANDLES', Object.keys(series1h).length);

  // ── Cross-timeframe summary ───────────────────────────────────────────────
  console.log(`${'═'.repeat(104)}`);
  console.log(`  CROSS-TIMEFRAME SUMMARY`);
  console.log(`${'═'.repeat(104)}`);
  console.log(`  Variant        15m P&L%    1H P&L%   15m DD   1H DD   Recommend?`);
  console.log(`  ${'─'.repeat(90)}`);
  for (let i = 0; i < VARIANTS.length; i++) {
    const r15 = res15[i], r1h = res1h[i];
    const both = r15.pnlPct > 0 && r1h.pnlPct > 0 && !r15.breached && !r1h.breached;
    const flag = both ? '⭐ BOTH TFs PROFITABLE' : (r15.pnlPct > 0 && !r15.breached ? '15m only' : r1h.pnlPct > 0 && !r1h.breached ? '1H only' : '✗');
    console.log(
      `  ${VARIANTS[i].name.padEnd(14)} ` +
      `${(r15.pnlPct*100>=0?'+':'')+(r15.pnlPct*100).toFixed(2).padStart(6)}%   ` +
      `${(r1h.pnlPct*100>=0?'+':'')+(r1h.pnlPct*100).toFixed(2).padStart(6)}%   ` +
      `${(r15.maxDailyDD*100).toFixed(2).padStart(5)}%  ` +
      `${(r1h.maxDailyDD*100).toFixed(2).padStart(5)}%   ` +
      `${flag}`
    );
  }
  console.log(`${'═'.repeat(104)}\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
