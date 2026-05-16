/**
 * Fibonacci Grid Short Backtest
 *
 * Logic:
 *  1. Coin pumps 25%+ in 24h → signal fires
 *  2. Find swing_low (lowest point in 2 days before pump)
 *  3. Calculate Fibonacci EXTENSION levels above the pump
 *     (1.272 / 1.414 / 1.618 / 2.000 / 2.618 of the pump range)
 *  4. Place SHORT limit orders at each level as the coin keeps pumping
 *  5. TP = swing_low (rugpull returns to origin = 50-90% collapse)
 *  6. SL = 15% above the highest filled grid level (coin defies gravity)
 *  7. Hold up to 7 days — after that force-exit
 *
 * No "wait for red candle" — blind entry at resistance levels.
 * More of the pump = better average entry = bigger profit when it dumps.
 *
 * Usage:  node backtest-fib.js
 */

require('dotenv').config();
const axios          = require('axios');
const { analyzeCandles } = require('./src/analysis');

const CFG = {
  interval         : '240',
  fetchLimit       : 90,
  scanStep         : 1,
  lookback         : 60,
  scoreThreshold   : 5,
  minGain24h       : 25,
  minVolumeUSDT    : 300_000,
  requestDelay     : 220,
  maxHoldCandles   : 0,       // 0 = scan right up to latest candle
  swingLookback    : 12,      // candles to look back for swing_low (2 days of 4h)
  slBufferAboveTop : 0.15,    // SL placed 15% above highest filled grid level
};

// Fibonacci extension ratios — where the coin might pump to next
const FIB_RATIOS = [1.0, 1.272, 1.414, 1.618, 2.000, 2.618];

// Best strategy from previous run: trail20 + levelSL8%, 4 Fib levels
// Now testing aggressive posTotal values — user can hold 50% drawdown
const BASE = { ratios: [1.0, 1.272, 1.618, 2.000], split: 'equal', trailPct: 20, levelSl: 8 };

const GRID_CONFIGS = [
  // ── 5x leverage — scale up position size ──────────────────────────────────
  { ...BASE, lev: 5,  posTotal: 0.12, label: ' 5x  pos12%  [baseline]'  },
  { ...BASE, lev: 5,  posTotal: 0.20, label: ' 5x  pos20%'              },
  { ...BASE, lev: 5,  posTotal: 0.25, label: ' 5x  pos25%'              },
  { ...BASE, lev: 5,  posTotal: 0.30, label: ' 5x  pos30%'              },
  { ...BASE, lev: 5,  posTotal: 0.40, label: ' 5x  pos40%'              },
  { ...BASE, lev: 5,  posTotal: 0.50, label: ' 5x  pos50%'              },
  // ── 10x leverage — same posTotal but 2× the punch (and 2× the risk) ──────
  { ...BASE, lev: 10, posTotal: 0.12, label: '10x  pos12%'              },
  { ...BASE, lev: 10, posTotal: 0.20, label: '10x  pos20%'              },
  { ...BASE, lev: 10, posTotal: 0.25, label: '10x  pos25%'              },
  // ── 5x, 5-level grid, heavy split (more $ at higher Fib = better avg entry)
  { ...BASE, lev: 5,  posTotal: 0.30, split: 'heavy', label: ' 5x  pos30%  heavy-split' },
];

// ── Fibonacci grid builder ────────────────────────────────────────────────────
function buildGrid(swingLow, pumpHigh, cfg) {
  const range  = pumpHigh - swingLow;
  const levels = [];

  for (const ratio of cfg.ratios) {
    const price = swingLow + range * ratio;
    levels.push({ ratio, price, filled: false, fillPrice: null });
  }

  // Assign position fractions per level
  if (cfg.split === 'equal') {
    const f = 1 / levels.length;
    levels.forEach(l => l.frac = f);
  } else {
    // 'heavy': back-loaded — more position at higher Fibonacci levels (better avg entry)
    const weights = levels.map((_, i) => i + 1);               // 1,2,3,4
    const total   = weights.reduce((a, b) => a + b, 0);
    levels.forEach((l, i) => l.frac = weights[i] / total);
  }

  return levels;
}

// ── Simulate one grid trade with per-fill individual stop losses ──────────────
function simulateFibGrid(candles, signalIdx, cfg, capital) {
  const start    = Math.max(0, signalIdx - CFG.swingLookback);
  const swingLow = Math.min(...candles.slice(start, signalIdx - 1).map(c => c.low));
  const pumpHigh = Math.max(...candles.slice(Math.max(0, signalIdx - 2), signalIdx + 1).map(c => c.high));
  if (swingLow <= 0 || pumpHigh <= swingLow) return null;

  const levels  = buildGrid(swingLow, pumpHigh, cfg);
  const tpPrice = swingLow;

  // Each fill tracks its own state independently
  // state: 'open' | 'partial_sl' | 'master_sl' | 'tp' | 'trail' | 'timeout'
  const fills = [];
  let lowestClose = Infinity;

  const maxEnd = Math.min(signalIdx + CFG.maxHoldCandles, candles.length - 1);

  for (let j = signalIdx; j <= maxEnd; j++) {
    const c = candles[j];

    // ── 1. Fill new levels (price pumps to limit order) ────────────────────
    const newThisCandle = new Set();
    for (const lvl of levels) {
      if (!lvl.filled && c.high >= lvl.price) {
        lvl.filled = true;
        // Per-level SL: tighter for early entries, scaled for higher ones
        let slPct = cfg.levelSl ?? null;
        if (slPct && cfg.levelSlScale) slPct = slPct * lvl.ratio;   // scale by Fib ratio
        fills.push({
          ratio      : lvl.ratio,
          fillPrice  : lvl.price,
          frac       : lvl.frac,
          state      : 'open',
          levelSlPrice: slPct ? lvl.price * (1 + slPct / 100) : null,
          exitPrice  : null,
          pnl        : null,
        });
        newThisCandle.add(fills.length - 1);
      }
    }

    const openFills = fills.filter(f => f.state === 'open');
    if (openFills.length === 0 && fills.length === 0) continue;
    if (openFills.length === 0) break;

    // ── 2. Per-fill individual SL (skip fills that just opened this candle) ─
    if (cfg.levelSl) {
      for (let fi = 0; fi < fills.length; fi++) {
        const fill = fills[fi];
        if (fill.state !== 'open') continue;
        if (newThisCandle.has(fi))  continue;   // just opened, give it one candle
        if (fill.levelSlPrice && c.high >= fill.levelSlPrice) {
          fill.state     = 'partial_sl';
          fill.exitPrice = fill.levelSlPrice;
          const notional = capital * cfg.posTotal * fill.frac * cfg.lev;
          fill.pnl = notional * (fill.fillPrice - fill.levelSlPrice) / fill.fillPrice;
        }
      }
    }

    const stillOpen = fills.filter(f => f.state === 'open');
    if (stillOpen.length === 0) break;

    // ── 3. Update trailing low ────────────────────────────────────────────
    if (cfg.trailPct && c.close < lowestClose) lowestClose = c.close;

    // ── 4. Master SL — 15% above highest OPEN fill ────────────────────────
    const highestOpen = Math.max(...stillOpen.map(f => f.fillPrice));
    const masterSl    = highestOpen * (1 + CFG.slBufferAboveTop);
    if (c.high >= masterSl) {
      for (const fill of stillOpen) {
        fill.state     = 'master_sl';
        fill.exitPrice = masterSl;
        const notional = capital * cfg.posTotal * fill.frac * cfg.lev;
        fill.pnl = notional * (fill.fillPrice - masterSl) / fill.fillPrice;
      }
      break;
    }

    // ── 5. Trailing stop across all open fills ────────────────────────────
    if (cfg.trailPct && lowestClose < Infinity) {
      const trailStop   = lowestClose * (1 + cfg.trailPct / 100);
      const lowestEntry = Math.min(...stillOpen.map(f => f.fillPrice));
      if (c.high >= trailStop && lowestClose < lowestEntry) {
        for (const fill of stillOpen) {
          fill.state     = 'trail';
          fill.exitPrice = trailStop;
          const notional = capital * cfg.posTotal * fill.frac * cfg.lev;
          fill.pnl = notional * (fill.fillPrice - trailStop) / fill.fillPrice;
        }
        break;
      }
    }

    // ── 6. TP: rugpull returns to swing_low ───────────────────────────────
    if (c.low <= tpPrice) {
      for (const fill of stillOpen) {
        fill.state     = 'tp';
        fill.exitPrice = tpPrice;
        const notional = capital * cfg.posTotal * fill.frac * cfg.lev;
        fill.pnl = notional * (fill.fillPrice - tpPrice) / fill.fillPrice;
      }
      break;
    }
  }

  // ── 7. Timeout: force-exit remaining open fills ────────────────────────
  const timeoutPrice = candles[maxEnd].close;
  for (const fill of fills.filter(f => f.state === 'open')) {
    fill.state     = 'timeout';
    fill.exitPrice = timeoutPrice;
    const notional = capital * cfg.posTotal * fill.frac * cfg.lev;
    fill.pnl = notional * (fill.fillPrice - timeoutPrice) / fill.fillPrice;
  }

  if (fills.length === 0) return null;

  // ── Aggregate P&L ─────────────────────────────────────────────────────────
  const totalPnl    = fills.reduce((s, f) => s + (f.pnl ?? 0), 0);
  const totalMargin = fills.reduce((s, f) => s + capital * cfg.posTotal * f.frac, 0);
  const totalFee    = fills.reduce((s, f) => {
    return s + capital * cfg.posTotal * f.frac * cfg.lev * 0.00055 * 2;
  }, 0);

  // Summary exit reason = most decisive close (tp > trail > master_sl > partial_sl > timeout)
  const priority = { tp: 5, trail: 4, master_sl: 3, partial_sl: 2, timeout: 1 };
  const exitReason = fills.reduce((best, f) =>
    (priority[f.state] ?? 0) > (priority[best] ?? 0) ? f.state : best, 'timeout');

  const partialSlCount = fills.filter(f => f.state === 'partial_sl').length;

  return {
    swingLow, pumpHigh, tpPrice,
    fills          : fills.map(f => ({ ratio: f.ratio, price: +f.fillPrice.toFixed(6), state: f.state })),
    filledCount    : fills.length,
    totalLevels    : levels.length,
    avgEntry       : fills.reduce((s,f) => s + f.fillPrice * f.frac, 0) /
                     fills.reduce((s,f) => s + f.frac, 0),
    exitReason,
    partialSlCount,
    retOnDeployed  : totalMargin > 0 ? +(totalPnl / totalMargin * 100).toFixed(2) : 0,
    retOnCapital   : +(totalPnl / capital * 100).toFixed(4),
    totalMargin, totalPnl, totalFee,
  };
}

// ── Bybit helpers ─────────────────────────────────────────────────────────────
const http  = axios.create({ baseURL: 'https://api.bybit.com', timeout: 15000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getAllSymbols() {
  const res = await http.get('/v5/market/tickers', { params: { category: 'linear' } });
  return res.data.result.list
    .filter(t => t.symbol.endsWith('USDT'))
    .filter(t => parseFloat(t.volume24h) * parseFloat(t.lastPrice) >= CFG.minVolumeUSDT)
    .map(t => ({ symbol: t.symbol, fundingRate: parseFloat(t.fundingRate ?? 0) }));
}

async function getKlines(symbol) {
  const res = await http.get('/v5/market/kline', {
    params: { category: 'linear', symbol, interval: CFG.interval, limit: CFG.fetchLimit },
  });
  return res.data.result.list.reverse().map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ── Signal detection ──────────────────────────────────────────────────────────
function collectSignals(symbol, candles, fundingRate) {
  const signals = [];
  const start = CFG.lookback + CFG.swingLookback + 2;
  const end   = candles.length - CFG.maxHoldCandles - 2;

  for (let i = start; i < end; i += CFG.scanStep) {
    const gain24h = (candles[i].close - candles[i-6].close) / candles[i-6].close * 100;
    if (gain24h < CFG.minGain24h || gain24h > 150) continue;

    const { score } = analyzeCandles(candles.slice(i - CFG.lookback, i + 1), fundingRate);
    if (score < CFG.scoreThreshold) continue;

    const day = new Date(candles[i].time).toISOString().slice(0, 10);
    signals.push({ symbol, day, time: new Date(candles[i].time).toISOString().slice(0,16),
                   gain24h: +gain24h.toFixed(2), score, candles, signalIdx: i });
  }
  return signals;
}

// Collect ALL pumpers regardless of score — so user can see why coins were filtered
function collectAllPumpers(symbol, candles, fundingRate) {
  const pumpers = [];
  const start = CFG.lookback + CFG.swingLookback + 2;
  const end   = candles.length - CFG.maxHoldCandles - 2;

  for (let i = start; i < end; i += CFG.scanStep) {
    const gain24h = (candles[i].close - candles[i-6].close) / candles[i-6].close * 100;
    if (gain24h < CFG.minGain24h) continue;

    const { score } = analyzeCandles(candles.slice(i - CFG.lookback, i + 1), fundingRate);
    const day = new Date(candles[i].time).toISOString().slice(0, 10);
    const passed = gain24h <= 150 && score >= CFG.scoreThreshold;
    pumpers.push({ symbol, day, gain24h: +gain24h.toFixed(2), score, passed });
  }
  return pumpers;
}

function pickBestPerDay(allSignals) {
  const byDay = {};
  for (const s of allSignals) {
    if (!byDay[s.day] || s.score > byDay[s.day].score ||
       (s.score === byDay[s.day].score && s.gain24h > byDay[s.day].gain24h))
      byDay[s.day] = s;
  }
  const sorted = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
  const result = [];
  for (const s of sorted) {
    if (result.length && result[result.length-1].symbol === s.symbol) continue; // no consecutive same coin
    result.push(s);
  }
  return result;
}

function printAllSignals(allSignals) {
  const byDay = {};
  for (const s of allSignals) {
    if (!byDay[s.day]) byDay[s.day] = [];
    byDay[s.day].push(s);
  }
  const days = Object.keys(byDay).sort();
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║      ALL SIGNALS DETECTED                                        ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  for (const day of days) {
    const coins = byDay[day].sort((a, b) => b.score - a.score || b.gain24h - a.gain24h);
    console.log(`\n  ${day}  (${coins.length} signals)`);
    console.log('  ' + '─'.repeat(60));
    for (const c of coins) {
      const star = coins[0] === c ? ' ← picked' : '';
      console.log(`  ${c.symbol.padEnd(22)} gain:${('+'+c.gain24h.toFixed(1)+'%').padStart(8)}  score:${c.score}${star}`);
    }
  }
  console.log('');
}

// ── Stats ─────────────────────────────────────────────────────────────────────
const mean   = arr => arr.length ? arr.reduce((a,b) => a+b, 0) / arr.length : 0;
const fmt    = n   => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const fmtUSD = n   => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);

// ── Report ────────────────────────────────────────────────────────────────────
function printReport(dailySignals, allResults) {
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║      FIBONACCI GRID SHORT — Backtest Results                     ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Trading days: ${dailySignals.length}   TP = return to swing_low   SL = +15% above highest fill\n`);

  // Summary table
  console.log('Config                       Trades  WR%  AvgRet  $1000→  Monthly%  MaxDD%  Worst$  $500?');
  console.log('─'.repeat(95));

  const summaryRows = [];

  for (let ci = 0; ci < GRID_CONFIGS.length; ci++) {
    const trades = allResults[ci].filter(Boolean);
    if (!trades.length) continue;

    // Simulate equity curve with max drawdown tracking
    let capital = 1000, peak = 1000, maxDD = 0, worstCapital = 1000;
    for (const t of trades) {
      capital = Math.max(0, capital + t.totalPnl - t.totalFee);
      if (capital > peak) peak = capital;
      const dd = (peak - capital) / peak * 100;
      if (dd > maxDD) { maxDD = dd; worstCapital = capital; }
    }

    const monthly  = ((capital - 1000) / 1000 * 100).toFixed(1);
    const rets     = trades.map(t => t.retOnDeployed);
    const wr       = (trades.filter(t => t.retOnDeployed > 0).length / trades.length * 100).toFixed(1);
    const hits500  = capital - 1000 >= 500 ? '✓ YES' : `need $${(1000*500/(capital-1000)).toFixed(0)}`;

    summaryRows.push({ ci, capital, monthly, maxDD, trades });

    const ddMark = maxDD > 50 ? ' ⚠' : maxDD > 35 ? ' !' : '';
    const retMark = capital >= 1500 ? ' ★' : capital >= 1350 ? ' ◆' : '';
    console.log(
      GRID_CONFIGS[ci].label.padEnd(28) +
      String(trades.length).padStart(7) +
      (wr+'%').padStart(5) +
      fmt(mean(rets)).padStart(8) +
      ('$'+capital.toFixed(0)).padStart(8) +
      (monthly+'%').padStart(10) +
      (maxDD.toFixed(1)+'%').padStart(8) + ddMark.padEnd(3) +
      ('$'+worstCapital.toFixed(0)).padStart(7) +
      ('  '+hits500) +
      retMark
    );
  }

  summaryRows.sort((a, b) => b.capital - a.capital);
  const bestCi  = summaryRows[0].ci;
  const bestCfg = GRID_CONFIGS[bestCi];
  const best    = allResults[bestCi].filter(Boolean);

  // Trade-by-trade log for best config
  console.log(`\n── Trade log [${bestCfg.label.trim()}] ───────────────────────────────`);
  console.log('  Date        Coin             Gain   Score  SwingLow→ PumpHigh   Fills  AvgEntry   Exit       Ret%   Reason   Hold');
  let capital = 1000;
  for (const t of best) {
    const sig    = dailySignals[best.indexOf(t)];
    const ret    = fmt(t.retOnDeployed).padStart(7);
    const mark   = t.retOnDeployed > 0 ? '✓' : '✗';
    const pnl    = t.totalPnl - t.totalFee;
    capital      = Math.max(0, capital + pnl);
    const fillStr = t.fills.map(f => {
      const icon = f.state === 'partial_sl' ? '✗' : f.state === 'tp' || f.state === 'trail' || f.state === 'timeout' ? '✓' : '~';
      return `${icon}${f.ratio.toFixed(2)}x`;
    }).join(' ');
    const pslNote = t.partialSlCount > 0 ? ` [${t.partialSlCount}pSL]` : '';
    console.log(
      `  ${mark} ${sig.day}  ${sig.symbol.padEnd(16)} +${sig.gain24h}%  ${sig.score}` +
      `  [${fillStr}]${pslNote}` +
      `  avg:$${t.avgEntry.toFixed(4)}  exit:$${t.exitReason.padEnd(9)}` +
      `  ${ret}  bal:$${capital.toFixed(0)}`
    );
  }

  // Monthly breakdown
  console.log(`\n── Monthly P&L [${bestCfg.label.trim()}] ────────────────────────────`);
  capital = 1000;
  const byMonth = {};
  for (const t of best) {
    const sig   = dailySignals[best.indexOf(t)];
    const month = sig.day.slice(0, 7);
    const pnl   = t.totalPnl - t.totalFee;
    capital     = Math.max(0, capital + pnl);
    if (!byMonth[month]) byMonth[month] = { n: 0, pnl: 0, bal: 0 };
    byMonth[month].n++;
    byMonth[month].pnl += pnl;
    byMonth[month].bal  = capital;
  }
  for (const [m, d] of Object.entries(byMonth)) {
    console.log(`  ${m}  ${d.n} trades  P&L: ${fmtUSD(d.pnl)}  balance: $${d.bal.toFixed(2)}`);
  }

  // Grid fill distribution
  console.log(`\n── Fibonacci Level Fill Rate [${bestCfg.label.trim()}] ──────────────`);
  const fillCounts = best.reduce((acc, t) => { acc[t.filledCount] = (acc[t.filledCount]||0)+1; return acc; }, {});
  for (const [n, count] of Object.entries(fillCounts).sort((a,b)=>+a[0]-+b[0])) {
    const pct = (count/best.length*100).toFixed(0);
    const bar = '█'.repeat(Math.round(count/best.length*20));
    console.log(`  ${n} level(s) filled: ${String(count).padStart(2)} trades (${pct}%)  ${bar}`);
  }

  // $500 path
  console.log('\n── Path to $500/month ───────────────────────────────────────────────');
  for (const row of summaryRows.slice(0, 5)) {
    const profit = row.capital - 1000;
    const path   = profit >= 500
      ? '✓ HITS $500'
      : profit > 0
        ? `need $${(1000 * 500 / profit).toFixed(0)} capital OR increase posTotal`
        : 'losing strategy';
    console.log(`  ${GRID_CONFIGS[row.ci].label.padEnd(40)} profit $${profit.toFixed(0).padStart(5)}  ${path}`);
  }

  console.log('\n⚠️  Not financial advice. These are rugpull coins — they can also keep pumping.\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  Fibonacci Grid Short Backtest — 1/day       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Entry: blind limit orders at Fib extensions | TP: swing_low | SL: +15% above top fill\n`);

  const symbols = await getAllSymbols();
  console.log(`Fetching ${symbols.length} symbols...\n`);

  const allSignals = [];
  const allPumpers = [];
  let done = 0;

  for (const { symbol, fundingRate } of symbols) {
    try {
      const candles = await getKlines(symbol);
      if (candles.length < CFG.lookback + CFG.maxHoldCandles + CFG.swingLookback + 5) { done++; continue; }
      allSignals.push(...collectSignals(symbol, candles, fundingRate));
      allPumpers.push(...collectAllPumpers(symbol, candles, fundingRate));
    } catch { }
    done++;
    if (done % 30 === 0) process.stdout.write(`  ${done}/${symbols.length}  signals: ${allSignals.length}\n`);
    await sleep(CFG.requestDelay);
  }

  // Print all pumpers grouped by day
  const pumpersByDay = {};
  for (const p of allPumpers) {
    if (!pumpersByDay[p.day]) pumpersByDay[p.day] = [];
    pumpersByDay[p.day].push(p);
  }
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║      ALL PUMPERS (25%+ gain, any score)                          ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  for (const day of Object.keys(pumpersByDay).sort()) {
    const coins = pumpersByDay[day].sort((a, b) => b.score - a.score || b.gain24h - a.gain24h);
    console.log(`\n  ${day}  (${coins.length} pumpers)`);
    console.log('  ' + '─'.repeat(65));
    console.log('  ' + 'Symbol'.padEnd(22) + 'Gain'.padStart(9) + '  Score  Status');
    for (const c of coins) {
      const status = c.gain24h > 150 ? '⛔ skip (>150% parabolic)' : c.passed ? '✓ qualifies' : `✗ score too low (need ${CFG.scoreThreshold})`;
      console.log(`  ${c.symbol.padEnd(22)} ${('+'+c.gain24h.toFixed(1)+'%').padStart(8)}    ${c.score}    ${status}`);
    }
  }

  printAllSignals(allSignals);
  const daily = pickBestPerDay(allSignals);
  console.log(`\nTrading days: ${daily.length}`);

  const allResults = GRID_CONFIGS.map(() => []);

  for (const sig of daily) {
    for (let ci = 0; ci < GRID_CONFIGS.length; ci++) {
      allResults[ci].push(simulateFibGrid(sig.candles, sig.signalIdx, GRID_CONFIGS[ci], 1000));
    }
  }

  printReport(daily, allResults);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
