/**
 * HyroTrader Challenge Backtest — MULTI-VARIANT COMPARISON
 * ────────────────────────────────────────────────────────────────────────────
 * Tests several TP/SL configurations on the SAME 30 days of Bybit data so we
 * can pick the one most likely to pass the challenge without breaching.
 *
 * Variants tested:
 *   baseline:    current bot — TP 0.67%/5%, SL 3% (the one that lost -9% live)
 *   A-big-only:  only coins >10% 24h, TP 5%, SL 5% (1:1 on big movers only)
 *   B-match-3:   TP 3% / SL 3% for all coins (1:1)
 *   C-scalp-1:   TP 1% / SL 1% tight scalp (1:1)
 *   D-wider-SL:  current TPs but SL widened to 5% (more breathing room)
 *
 * All other parameters (EMA20/50, $500 notional, 4 coins, daily-DD guard) are
 * held constant so the variants are directly comparable.
 */

const axios = require('axios');

// ── Shared config ─────────────────────────────────────────────────────────────
const INITIAL_BALANCE = 10000;
const TRADE_NOTIONAL  = 500;
const MAX_POSITIONS   = 4;
const MAX_COINS       = 4;
const GRID_STEP       = 0.005;
const GRID_BIG        = 0.01;
const BIG_MOVE_PCT    = 10;
const EMA_FAST        = 20;
const EMA_SLOW        = 50;
const MIN_EMA_SEP     = 0.004;
const SWITCH_COOL     = 16;
const MIN_TREND_PCT   = 0.55;
const DAILY_DD_HALT   = 0.04;
const DAILY_DD_FLAT   = 0.045;
const MAX_LOSS_FLAT   = 0.09;
const PROFIT_TARGET   = 0.10;
const INTERVAL        = '15';
const DAYS            = 30;
const MIN_VOL_USD     = 30_000_000;
const MIN_CHANGE      = 2;
const TOP_N           = 40;
const FETCH_COINS     = 12;

// ── Variants ─────────────────────────────────────────────────────────────────
const VARIANTS = [
  { name: 'baseline',    tp: 0.0067, tpBig: 0.05, sl: 0.03, bigOnly: false },
  { name: 'A-big-1:1',   tp: 0.05,   tpBig: 0.05, sl: 0.05, bigOnly: true  },
  { name: 'B-match-3',   tp: 0.03,   tpBig: 0.03, sl: 0.03, bigOnly: false },
  { name: 'C-scalp-1',   tp: 0.01,   tpBig: 0.01, sl: 0.01, bigOnly: false },
  { name: 'D-wider-SL',  tp: 0.0067, tpBig: 0.05, sl: 0.05, bigOnly: false },
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

async function fetchTickers() {
  const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 });
  return res.data.result.list
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000') && !t.symbol.includes('USDC'))
    .map(t => ({ symbol: t.symbol, change24h: parseFloat(t.price24hPcnt) * 100, vol24h: parseFloat(t.turnover24h) }))
    .filter(t => t.vol24h >= MIN_VOL_USD && Math.abs(t.change24h) >= MIN_CHANGE)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, TOP_N);
}

async function fetchKlines(symbol) {
  const totalNeeded = DAYS * 24 * 4;
  const perPage = 1000;
  let all = [], end;
  for (let p = 0; p < Math.ceil(totalNeeded / perPage); p++) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${INTERVAL}&limit=${perPage}` + (end ? `&end=${end}` : '');
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

// ── Portfolio simulation with variant config ─────────────────────────────────
function runPortfolio(coinSeries, change24hMap, cfg) {
  const coins = Object.keys(coinSeries);
  if (!coins.length) return null;

  const tsSet = new Set();
  for (const sym of coins) for (const c of coinSeries[sym]) tsSet.add(c.ts);
  const timeline = [...tsSet].sort((a, b) => a - b);

  const ema20 = {}, ema50 = {}, idxByTs = {};
  for (const sym of coins) {
    const closes = coinSeries[sym].map(c => c.close);
    ema20[sym] = calcEMA(closes, EMA_FAST);
    ema50[sym] = calcEMA(closes, EMA_SLOW);
    idxByTs[sym] = new Map(coinSeries[sym].map((c, i) => [c.ts, i]));
  }

  const active = {};
  let equity = INITIAL_BALANCE;
  let realizedPnl = 0;
  const trades = [];

  let curDay = null, dayStart = INITIAL_BALANCE, dayPeak = INITIAL_BALANCE;
  let maxDailyDD = 0;
  const haltDays = new Set(), flatDays = new Set();
  let breached = false, breachDay = null;
  let stopped = false, halted = false;

  for (const ts of timeline) {
    if (stopped) break;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (day !== curDay) {
      curDay = day; dayStart = equity; dayPeak = equity; halted = false;
    }

    // Mark-to-market
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

    // Risk guards
    if (totalPnlPct <= -MAX_LOSS_FLAT) {
      for (const sym of Object.keys(active)) {
        const i = idxByTs[sym]?.get(ts); if (i == null) continue;
        const px = coinSeries[sym][i].close;
        for (const p of active[sym].positions) {
          const pnl = p.mode === 'long' ? (px - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - px) / p.entry * TRADE_NOTIONAL;
          realizedPnl += pnl;
          trades.push({ ts, sym, type: 'maxloss-flat', pnl });
        }
        active[sym].positions = [];
      }
      stopped = true; flatDays.add(day);
      continue;
    }
    if (totalPnlPct >= PROFIT_TARGET) {
      for (const sym of Object.keys(active)) {
        const i = idxByTs[sym]?.get(ts); if (i == null) continue;
        const px = coinSeries[sym][i].close;
        for (const p of active[sym].positions) {
          const pnl = p.mode === 'long' ? (px - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - px) / p.entry * TRADE_NOTIONAL;
          realizedPnl += pnl;
          trades.push({ ts, sym, type: 'target', pnl });
        }
        active[sym].positions = [];
      }
      stopped = true;
      continue;
    }
    if (dailyDD >= DAILY_DD_FLAT && !flatDays.has(day)) {
      for (const sym of Object.keys(active)) {
        const i = idxByTs[sym]?.get(ts); if (i == null) continue;
        const px = coinSeries[sym][i].close;
        for (const p of active[sym].positions) {
          const pnl = p.mode === 'long' ? (px - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - px) / p.entry * TRADE_NOTIONAL;
          realizedPnl += pnl;
          trades.push({ ts, sym, type: 'day-flat', pnl });
        }
        active[sym].positions = [];
      }
      flatDays.add(day); halted = true;
    } else if (dailyDD >= DAILY_DD_HALT) {
      halted = true; haltDays.add(day);
    }

    // Per-coin management
    for (const sym of coins) {
      const i = idxByTs[sym]?.get(ts); if (i == null) continue;
      const c = coinSeries[sym][i];
      if (i < EMA_SLOW + 1) continue;
      const e20 = ema20[sym][i], e50 = ema50[sym][i];
      const newMode = e20 > e50 ? 'long' : 'short';
      const emaSep = Math.abs(e20 - e50) / e50;
      const isBig = Math.abs(change24hMap[sym] || 0) >= BIG_MOVE_PCT;
      const tpPct = isBig ? cfg.tpBig : cfg.tp;
      const gridStep = isBig ? GRID_BIG : GRID_STEP;

      const a = active[sym];
      if (a) {
        for (let pi = a.positions.length - 1; pi >= 0; pi--) {
          const p = a.positions[pi];
          const slHit = p.mode === 'long' ? c.low <= p.sl : c.high >= p.sl;
          if (slHit) {
            const pnl = p.mode === 'long' ? (p.sl - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - p.sl) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl;
            trades.push({ ts, sym, type: 'sl', pnl });
            a.positions.splice(pi, 1);
            continue;
          }
          const tpHit = p.mode === 'long' ? c.high >= p.tp : c.low <= p.tp;
          if (tpHit) {
            const pnl = p.mode === 'long' ? (p.tp - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - p.tp) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl;
            trades.push({ ts, sym, type: 'tp', pnl });
            a.positions.splice(pi, 1);
          }
        }

        if (a.mode !== newMode && (i - (a.lastSwitch ?? -SWITCH_COOL)) >= SWITCH_COOL) {
          for (const p of a.positions) {
            const pnl = p.mode === 'long' ? (c.close - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - c.close) / p.entry * TRADE_NOTIONAL;
            realizedPnl += pnl;
            trades.push({ ts, sym, type: 'switch', pnl });
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
      const lastEntry = s.positions.length ? s.positions[s.positions.length - 1].entry : null;
      const dist = lastEntry ? Math.abs(c.close - lastEntry) / lastEntry : 1;
      if (dist < gridStep) continue;
      const tp = s.mode === 'long' ? c.close * (1 + tpPct) : c.close * (1 - tpPct);
      const sl = s.mode === 'long' ? c.close * (1 - cfg.sl) : c.close * (1 + cfg.sl);
      s.positions.push({ entry: c.close, tp, sl, mode: s.mode });
    }
  }

  // Final mark-to-market
  let finalUnrealized = 0;
  for (const sym of Object.keys(active)) {
    const last = coinSeries[sym][coinSeries[sym].length - 1].close;
    for (const p of active[sym].positions) {
      finalUnrealized += p.mode === 'long' ? (last - p.entry) / p.entry * TRADE_NOTIONAL : (p.entry - last) / p.entry * TRADE_NOTIONAL;
    }
  }
  const finalEquity = INITIAL_BALANCE + realizedPnl + finalUnrealized;

  // Counts
  const counts = {}, sums = {};
  for (const t of trades) {
    counts[t.type] = (counts[t.type] || 0) + 1;
    sums[t.type]   = (sums[t.type] || 0) + t.pnl;
  }

  return {
    cfg, finalEquity, realizedPnl, finalUnrealized,
    pnlPct: (finalEquity - INITIAL_BALANCE) / INITIAL_BALANCE,
    breached, breachDay, maxDailyDD,
    halts: haltDays.size, flats: flatDays.size,
    stopped, target: trades.some(t => t.type === 'target'),
    counts, sums, totalTrades: trades.length,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nFetching top movers...');
  const tickers = await fetchTickers();
  console.log(`Found ${tickers.length} candidates\n`);

  console.log(`Fetching ${FETCH_COINS} sets of klines...`);
  const top = tickers.slice(0, FETCH_COINS);
  const series = {}; const ch24 = {};
  for (const t of top) {
    await sleep(150);
    try {
      const k = await fetchKlines(t.symbol);
      if (k.length < EMA_SLOW + 20) continue;
      series[t.symbol] = k;
      ch24[t.symbol] = t.change24h;
      console.log(`  ${t.symbol.padEnd(14)} ${k.length.toString().padStart(5)} candles  24h:${(t.change24h>=0?'+':'')+t.change24h.toFixed(1)}%`);
    } catch (e) { console.log(`  ${t.symbol}  err: ${e.message}`); }
  }
  console.log('');

  // Run each variant
  const results = [];
  for (const cfg of VARIANTS) {
    console.log(`Running ${cfg.name}...  TP:${(cfg.tp*100).toFixed(2)}%/${(cfg.tpBig*100).toFixed(2)}% SL:${(cfg.sl*100).toFixed(2)}% bigOnly:${cfg.bigOnly}`);
    const r = runPortfolio(series, ch24, cfg);
    results.push(r);
  }

  // ── Comparison table ─────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(96)}`);
  console.log(`  VARIANT COMPARISON — 30 days — ${Object.keys(series).length} coins eligible`);
  console.log(`${'═'.repeat(96)}`);
  console.log(`  Variant       Final$    P&L%      MaxDD   TPs   SLs   Switch  Halt  Flat  Status`);
  console.log(`  ${'─'.repeat(92)}`);
  for (const r of results) {
    const status = r.breached ? '❌BREACH' : r.target ? '✅TARGET' : r.stopped ? '🛑STOPPED' : r.pnlPct > 0 ? '🟢PROFIT' : '🟠LOSS';
    const tp = r.counts.tp || 0, sl = r.counts.sl || 0, sw = r.counts.switch || 0;
    console.log(
      `  ${r.cfg.name.padEnd(13)} ` +
      `$${r.finalEquity.toFixed(0).padStart(6)}  ` +
      `${(r.pnlPct*100>=0?'+':'')+(r.pnlPct*100).toFixed(2).padStart(6)}%  ` +
      `${(r.maxDailyDD*100).toFixed(2).padStart(5)}%  ` +
      `${String(tp).padStart(4)}  ` +
      `${String(sl).padStart(4)}  ` +
      `${String(sw).padStart(5)}   ` +
      `${String(r.halts).padStart(3)}   ` +
      `${String(r.flats).padStart(3)}   ` +
      `${status}`
    );
  }
  console.log(`  ${'─'.repeat(92)}\n`);

  // Detailed per-variant breakdown
  for (const r of results) {
    const tp = r.counts.tp || 0, sl = r.counts.sl || 0;
    const wr = tp + sl > 0 ? (tp / (tp + sl) * 100).toFixed(0) : '—';
    const rr = r.cfg.tp / r.cfg.sl;
    const beWR = (1 / (1 + rr) * 100).toFixed(0);
    console.log(`  ${r.cfg.name}:`);
    console.log(`    R:R (small/big TP): ${(r.cfg.tp/r.cfg.sl).toFixed(2)} / ${(r.cfg.tpBig/r.cfg.sl).toFixed(2)} | Break-even WR ≥ ${beWR}% | Actual WR ${wr}%`);
    if (r.counts.tp) console.log(`    TP    ${tp}× = +$${(r.sums.tp||0).toFixed(0)}`);
    if (r.counts.sl) console.log(`    SL    ${sl}× = $${(r.sums.sl||0).toFixed(0)}`);
    if (r.counts.switch) console.log(`    SWAP  ${r.counts.switch}× = $${(r.sums.switch||0).toFixed(0)}`);
    console.log('');
  }

  // ── Decision ─────────────────────────────────────────────────────────────
  console.log(`${'═'.repeat(96)}`);
  // Rank: prefer hit target → no breach → highest pnl
  const safe = results.filter(r => !r.breached);
  const ranked = [...safe].sort((a, b) => {
    if (a.target !== b.target) return a.target ? -1 : 1;
    return b.pnlPct - a.pnlPct;
  });
  const winner = ranked[0];
  if (!winner || winner.pnlPct <= 0) {
    console.log(`  🟠 NO PROFITABLE VARIANT FOUND on this 30-day window.`);
    console.log(`  Recommendation: this strategy isn't suited to current market — try different`);
    console.log(`  approach (longer timeframe, different indicators, or wait for market regime change).`);
  } else {
    console.log(`  ✅ WINNER: "${winner.cfg.name}"  →  ${(winner.pnlPct*100).toFixed(2)}% over 30d, maxDD ${(winner.maxDailyDD*100).toFixed(2)}%`);
    console.log(`     Config: TP ${(winner.cfg.tp*100).toFixed(2)}% / TP_BIG ${(winner.cfg.tpBig*100).toFixed(2)}% / SL ${(winner.cfg.sl*100).toFixed(2)}% / bigOnly ${winner.cfg.bigOnly}`);
  }
  console.log(`${'═'.repeat(96)}\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
