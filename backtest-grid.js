/**
 * Grid Entry Backtest
 *
 * Same signal detection as backtest.js, but tests multiple ways
 * to scale into the short position across grid levels as the coin
 * keeps pumping after the signal fires.
 *
 * Usage:  node backtest-grid.js
 */

require('dotenv').config();
const axios          = require('axios');
const { analyzeCandles } = require('./src/analysis');

// ── Config (same as main backtest) ───────────────────────────────────────────
const CFG = {
  interval       : '240',
  fetchLimit     : 200,
  scanStep       : 2,
  lookback       : 60,
  minGain24h     : 30,
  scoreThreshold : 6,      // high-conviction only (81% win rate from backtest)
  minVolumeUSDT  : 500_000,
  requestDelay   : 220,
  exitCandles    : 12,     // 48h from signal (12 × 4h)
  forwardCandles : 18,     // 72h window used to check grid fills
};

// ── Grid strategies to compare ───────────────────────────────────────────────
// levels[]: % above signal price to place each order
// parts[]:  fraction of total position allocated at each level
// wait_red: skip fixed levels, enter after first red 4h close post-signal
const STRATEGIES = [
  {
    name  : 'Baseline  single entry',
    levels: [0],
    parts : [1.00],
  },
  {
    name  : 'Grid-4 equal    +0/10/20/30%',
    levels: [0, 10, 20, 30],
    parts : [0.25, 0.25, 0.25, 0.25],
  },
  {
    name  : 'Grid-4 top-heavy +0/10/20/30%',
    levels: [0, 10, 20, 30],
    parts : [0.10, 0.20, 0.30, 0.40],   // more weight at higher prices = better avg entry
  },
  {
    name  : 'Grid-3 spread   +0/20/40%',
    levels: [0, 20, 40],
    parts : [0.333, 0.333, 0.334],
  },
  {
    name  : 'Grid-4 skip0    +10/20/30/40%',
    levels: [10, 20, 30, 40],
    parts : [0.25, 0.25, 0.25, 0.25],   // skip the signal candle, wait for continuation
  },
  {
    name  : 'Grid-2 half     +0/25%',
    levels: [0, 25],
    parts : [0.50, 0.50],
  },
  {
    name  : 'Wait-for-red    first red close',
    waitRed: true,                        // enter after first 4h red candle post-signal
    parts : [1.00],
  },
  {
    name  : 'Grid-5 fine     +0/8/16/24/32%',
    levels: [0, 8, 16, 24, 32],
    parts : [0.20, 0.20, 0.20, 0.20, 0.20],
  },
];

// ── Bybit helpers ────────────────────────────────────────────────────────────
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
  return res.data.result.list
    .reverse()
    .map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
}

// ── Grid trade simulator ─────────────────────────────────────────────────────
function simulateGridTrade(candles, signalIdx, strategy) {
  const signalPrice = candles[signalIdx].close;
  const exitIdx     = Math.min(signalIdx + CFG.exitCandles, candles.length - 1);
  const exitPrice   = candles[exitIdx].close;

  let filledQty  = 0;   // total units shorted
  let filledCost = 0;   // total USD allocated to fills
  const fills    = [];

  if (strategy.waitRed) {
    // Enter full position at the close of the first 4h red candle after signal
    for (let j = signalIdx + 1; j <= signalIdx + CFG.forwardCandles && j < candles.length; j++) {
      if (candles[j].close < candles[j].open) {
        const entryPrice = candles[j].close;
        filledCost = 1.0;                         // 100% of position (normalised)
        filledQty  = filledCost / entryPrice;
        fills.push({ level: 'red-close', price: entryPrice });
        break;
      }
    }
  } else {
    for (let li = 0; li < strategy.levels.length; li++) {
      const targetPrice = signalPrice * (1 + strategy.levels[li] / 100);
      const fraction    = strategy.parts[li];

      let fillPrice = null;

      if (li === 0 && strategy.levels[0] === 0) {
        // Level 0 at signal price → always fills immediately
        fillPrice = signalPrice;
      } else {
        // Check if any future candle's HIGH touches this level within 72h
        for (let j = signalIdx + 1; j <= signalIdx + CFG.forwardCandles && j < candles.length; j++) {
          if (candles[j].high >= targetPrice) {
            fillPrice = targetPrice;
            break;
          }
        }
      }

      if (fillPrice !== null) {
        filledCost += fraction;
        filledQty  += fraction / fillPrice;
        fills.push({ level: strategy.levels[li], price: fillPrice });
      }
    }
  }

  if (filledQty === 0 || filledCost === 0) return null;  // nothing filled

  const avgEntry = filledCost / filledQty;   // weighted average entry price

  // Short return based on avg entry vs 48h-from-signal exit
  const returnPct = (avgEntry - exitPrice) / avgEntry * 100;

  // MAE relative to avg entry (max candle HIGH in forward window vs avg entry)
  const futureHighs = candles.slice(signalIdx + 1, signalIdx + CFG.forwardCandles + 1).map(c => c.high);
  const maxHigh     = Math.max(...futureHighs);
  const mae         = Math.max(0, (maxHigh - avgEntry) / avgEntry * 100);

  return {
    signalPrice,
    avgEntry    : +avgEntry.toFixed(6),
    exitPrice,
    returnPct   : +returnPct.toFixed(2),
    mae         : +mae.toFixed(2),
    filledPct   : +(filledCost * 100).toFixed(1),  // % of position that got filled
    fills,
  };
}

// ── Backtest per symbol ───────────────────────────────────────────────────────
function backtestSymbol(symbol, candles, fundingRate) {
  const results = STRATEGIES.map(() => []);  // one array of trades per strategy

  const start = CFG.lookback + 6;
  const end   = candles.length - CFG.forwardCandles - 1;

  for (let i = start; i < end; i += CFG.scanStep) {
    const priceNow    = candles[i].close;
    const price24hAgo = candles[i - 6].close;
    const gain24h     = (priceNow - price24hAgo) / price24hAgo * 100;

    if (gain24h < CFG.minGain24h) continue;

    const window = candles.slice(i - CFG.lookback, i + 1);
    const { score, signals } = analyzeCandles(window, fundingRate);

    if (score < CFG.scoreThreshold) continue;

    for (let si = 0; si < STRATEGIES.length; si++) {
      const trade = simulateGridTrade(candles, i, STRATEGIES[si]);
      if (trade) {
        results[si].push({
          symbol,
          time    : new Date(candles[i].time).toISOString().slice(0, 16),
          gain24h : +gain24h.toFixed(2),
          score,
          ...trade,
        });
      }
    }
  }

  return results;
}

// ── Statistics ────────────────────────────────────────────────────────────────
const mean   = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const median = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const winRate = (arr, key = 'returnPct') =>
  arr.length ? (arr.filter(t => t[key] > 0).length / arr.length * 100).toFixed(1) : '0.0';
const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

// ── Capital simulation ────────────────────────────────────────────────────────
function simulateCapital(trades, startingCapital = 1000, positionPct = 0.10) {
  let capital = startingCapital;
  for (const t of [...trades].sort((a, b) => a.time.localeCompare(b.time))) {
    const targetPos = capital * positionPct;
    const deployed  = targetPos * (t.filledPct / 100);  // only deployed capital
    const fee       = deployed * 0.0011;                 // 0.055% × 2
    const pnl       = deployed * (t.returnPct / 100);
    capital         = Math.max(0, capital + pnl - fee);
  }
  return capital;
}

// ── Report ────────────────────────────────────────────────────────────────────
function printReport(strategyTrades) {
  const n0 = strategyTrades[0].length;

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          GRID ENTRY BACKTEST — last ~33 days                 ║');
  console.log(`║  Score ≥ ${CFG.scoreThreshold} signals | Exit at 48h from signal | $1000 / 10% pos  ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Baseline signal count: ${n0} trades\n`);

  // Summary comparison table
  console.log('Strategy                          Trades  WR%   Avg-ret  Median  AvgMAE  AvgFill  Final$  Return%');
  console.log('─'.repeat(100));

  const summaryRows = [];

  for (let si = 0; si < STRATEGIES.length; si++) {
    const trades = strategyTrades[si];
    if (!trades.length) continue;

    const rets   = trades.map(t => t.returnPct);
    const maes   = trades.map(t => t.mae);
    const fills  = trades.map(t => t.filledPct);
    const final  = simulateCapital(trades);
    const retPct = ((final - 1000) / 1000 * 100).toFixed(1);

    const row = {
      name    : STRATEGIES[si].name,
      count   : trades.length,
      wr      : winRate(trades),
      avgRet  : mean(rets),
      medRet  : median(rets),
      avgMae  : mean(maes),
      avgFill : mean(fills),
      final,
      retPct,
    };
    summaryRows.push(row);

    console.log(
      row.name.padEnd(33) +
      String(row.count).padStart(7) +
      (row.wr + '%').padStart(6) +
      fmt(row.avgRet).padStart(10) +
      fmt(row.medRet).padStart(8) +
      ('+' + row.avgMae.toFixed(1) + '%').padStart(8) +
      (row.avgFill.toFixed(0) + '%').padStart(9) +
      ('$' + row.final.toFixed(0)).padStart(8) +
      (row.retPct + '%').padStart(9)
    );
  }

  // Best strategy highlight
  const best = summaryRows.sort((a, b) => b.final - a.final)[0];
  console.log('\n★  Best strategy: ' + best.name);
  console.log(`   $1000 → $${best.final.toFixed(2)} (${best.retPct >= 0 ? '+' : ''}${best.retPct}%) | WR: ${best.wr}% | Avg return: ${fmt(best.avgRet)}`);

  // Fill rate analysis — how many levels typically fill
  console.log('\n── Fill Rate Analysis (how much of the position actually deploys) ──');
  for (let si = 0; si < STRATEGIES.length; si++) {
    const trades = strategyTrades[si];
    if (!trades.length || STRATEGIES[si].waitRed) continue;
    const avg = mean(trades.map(t => t.filledPct));
    const full = trades.filter(t => t.filledPct >= 99).length;
    console.log(`  ${STRATEGIES[si].name.padEnd(38)} avg fill: ${avg.toFixed(0).padStart(3)}%  fully filled: ${full}/${trades.length}`);
  }

  // Trade-by-trade detail for best strategy
  const bestIdx  = STRATEGIES.findIndex(s => s.name === best.name);
  const bestTrades = strategyTrades[bestIdx]
    .sort((a, b) => b.returnPct - a.returnPct);

  console.log(`\n── Best 5 individual trades [${best.name}] ──────────────`);
  for (const t of bestTrades.slice(0, 5)) {
    console.log(`  ${t.symbol.padEnd(16)} ${t.time}  +${t.gain24h}% pump  fill:${t.filledPct}%  avgEntry:${t.avgEntry}  ret:${fmt(t.returnPct)}`);
  }

  console.log(`\n── Worst 5 individual trades [${best.name}] ─────────────`);
  for (const t of bestTrades.slice(-5).reverse()) {
    console.log(`  ${t.symbol.padEnd(16)} ${t.time}  +${t.gain24h}% pump  fill:${t.filledPct}%  MAE:+${t.mae}%  ret:${fmt(t.returnPct)}`);
  }

  // Equity curve month by month for best strategy
  console.log(`\n── Monthly P&L [${best.name}] ─────────────────────────`);
  let capital = 1000;
  const byMonth = {};
  for (const t of strategyTrades[bestIdx].sort((a, b) => a.time.localeCompare(b.time))) {
    const month     = t.time.slice(0, 7);
    const deployed  = capital * 0.10 * (t.filledPct / 100);
    const pnl       = deployed * (t.returnPct / 100) - deployed * 0.0011;
    capital         = Math.max(0, capital + pnl);
    if (!byMonth[month]) byMonth[month] = { trades: 0, pnl: 0, endBal: 0 };
    byMonth[month].trades++;
    byMonth[month].pnl   += pnl;
    byMonth[month].endBal = capital;
  }
  for (const [month, d] of Object.entries(byMonth)) {
    const sign = d.pnl >= 0 ? '+' : '';
    console.log(`  ${month}  trades:${d.trades}  P&L: ${sign}$${d.pnl.toFixed(2)}  balance: $${d.endBal.toFixed(2)}`);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('⚠️  Past performance does not guarantee future results. Not financial advice.\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Crypto Short — Grid Entry Backtest  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Testing ${STRATEGIES.length} entry strategies | Score ≥ ${CFG.scoreThreshold} | 4h candles\n`);

  let symbols;
  try {
    symbols = await getAllSymbols();
    console.log(`Fetching ${symbols.length} symbols...\n`);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }

  // One results array per strategy
  const strategyTrades = STRATEGIES.map(() => []);
  let done = 0;

  for (const { symbol, fundingRate } of symbols) {
    try {
      const candles = await getKlines(symbol);
      if (candles.length < CFG.lookback + CFG.forwardCandles + 10) { done++; continue; }

      const symbolResults = backtestSymbol(symbol, candles, fundingRate);
      for (let si = 0; si < STRATEGIES.length; si++) {
        strategyTrades[si].push(...symbolResults[si]);
      }

      if (symbolResults[0].length) {
        process.stdout.write(`  ${symbol.padEnd(16)} ${symbolResults[0].length} signal(s)\n`);
      }
    } catch { /* skip */ }

    done++;
    if (done % 20 === 0) {
      process.stdout.write(`  ... ${done}/${symbols.length} symbols | baseline signals so far: ${strategyTrades[0].length}\n`);
    }
    await sleep(CFG.requestDelay);
  }

  printReport(strategyTrades);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
