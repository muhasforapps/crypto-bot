/**
 * Risk-Reward Optimizer
 *
 * Takes the best entry (wait-for-red, score ≥ 6) and tests every exit
 * strategy to find the one that maximises R:R and hits $500/month on $1000.
 *
 * Also tests lowering minGain24h to 20% to get more signals.
 *
 * Usage:  node backtest-rr.js
 */

require('dotenv').config();
const axios          = require('axios');
const { analyzeCandles } = require('./src/analysis');

const CFG = {
  interval      : '240',        // 4h candles
  fetchLimit    : 200,          // ~33 days
  scanStep      : 2,            // every 8h
  lookback      : 60,
  scoreThreshold: 6,
  minVolumeUSDT : 500_000,
  requestDelay  : 220,
  maxForward    : 42,           // max candles to hold (7 days = 42 × 4h)
};

// ── Exit strategies ──────────────────────────────────────────────────────────
// type 'fixed'   : exit after N 4h candles regardless
// type 'tpsl'    : exit at TP (price drops X%) or SL (price rises X%)
// type 'trail'   : trailing stop — stop trails down as price falls
// type 'partial' : exit half at tp1, trail remaining half
const EXIT_STRATS = [
  { name: 'Fixed 48h (baseline)',      type: 'fixed',                    candles: 12 },
  { name: 'Fixed 72h',                 type: 'fixed',                    candles: 18 },
  { name: 'TP15 / SL15',              type: 'tpsl',   tp: 15, sl: 15              },
  { name: 'TP20 / SL15',              type: 'tpsl',   tp: 20, sl: 15              },
  { name: 'TP25 / SL15',              type: 'tpsl',   tp: 25, sl: 15              },
  { name: 'TP30 / SL20',              type: 'tpsl',   tp: 30, sl: 20              },
  { name: 'Trail 15%',                 type: 'trail',  trail: 15                  },
  { name: 'Trail 20%',                 type: 'trail',  trail: 20                  },
  { name: 'Trail 25%',                 type: 'trail',  trail: 25                  },
  { name: 'Partial 50%@TP15 + Trail15',type: 'partial',tp1: 15, trail: 15, split: 0.5 },
  { name: 'Partial 50%@TP20 + Trail20',type: 'partial',tp1: 20, trail: 20, split: 0.5 },
  { name: 'Partial 50%@TP25 + Trail20',type: 'partial',tp1: 25, trail: 20, split: 0.5 },
];

// ── Simulate one exit on candle data ─────────────────────────────────────────
// entryIdx: index of entry candle (the red candle close)
// entryPrice: the close price of that candle
// Returns { returnPct, exitReason, holdCandles }
function simulateExit(candles, entryIdx, entryPrice, strat) {
  const maxEnd = Math.min(entryIdx + CFG.maxForward, candles.length - 1);

  if (strat.type === 'fixed') {
    const exitIdx = Math.min(entryIdx + strat.candles, maxEnd);
    const ret = (entryPrice - candles[exitIdx].close) / entryPrice * 100;
    return { returnPct: ret, exitReason: 'timeout', holdCandles: strat.candles };
  }

  const tpPrice = strat.tp   ? entryPrice * (1 - strat.tp  / 100) : null;
  const slPrice = strat.sl   ? entryPrice * (1 + strat.sl  / 100) : null;

  let trailStop   = strat.trail ? entryPrice * (1 + strat.trail / 100) : null;
  let lowestClose = entryPrice;

  // Partial exit state
  let leg1Done    = false;
  let leg1Ret     = 0;

  for (let j = entryIdx + 1; j <= maxEnd; j++) {
    const c = candles[j];

    // ── Stop loss / trail hit (price rose) ──────────────────────────────────
    const stopLevel = trailStop ?? slPrice ?? null;
    if (stopLevel && c.high >= stopLevel) {
      if (strat.type === 'partial' && leg1Done) {
        const leg2Ret = (entryPrice - stopLevel) / entryPrice * 100;
        const blended = leg1Ret * strat.split + leg2Ret * (1 - strat.split);
        return { returnPct: blended, exitReason: 'trail-stop', holdCandles: j - entryIdx };
      }
      const ret = (entryPrice - stopLevel) / entryPrice * 100;
      return { returnPct: ret, exitReason: 'stop', holdCandles: j - entryIdx };
    }

    // ── Take profit hit (price fell to TP) ──────────────────────────────────
    if (tpPrice && c.low <= tpPrice) {
      if (strat.type === 'partial' && !leg1Done) {
        // Lock in leg1
        leg1Ret  = strat.tp;
        leg1Done = true;
        // Set trailing stop for leg2 from TP level
        trailStop = tpPrice * (1 + strat.trail / 100);
        lowestClose = tpPrice;
        continue;
      }
      if (strat.type !== 'partial') {
        const ret = (entryPrice - tpPrice) / entryPrice * 100;
        return { returnPct: ret, exitReason: 'tp', holdCandles: j - entryIdx };
      }
    }

    // ── Update trailing stop on new lows ────────────────────────────────────
    if (strat.trail && c.close < lowestClose) {
      lowestClose = c.close;
      trailStop   = lowestClose * (1 + strat.trail / 100);
    }
  }

  // Timeout at maxForward
  const exitPrice = candles[maxEnd].close;
  const rawRet    = (entryPrice - exitPrice) / entryPrice * 100;

  if (strat.type === 'partial' && leg1Done) {
    const leg2Ret = rawRet;
    const blended = leg1Ret * strat.split + leg2Ret * (1 - strat.split);
    return { returnPct: blended, exitReason: 'timeout', holdCandles: CFG.maxForward };
  }

  return { returnPct: rawRet, exitReason: 'timeout', holdCandles: CFG.maxForward };
}

// ── Bybit ─────────────────────────────────────────────────────────────────────
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

// ── Backtest per symbol ───────────────────────────────────────────────────────
function backtestSymbol(symbol, candles, fundingRate, minGain24h) {
  // One trade list per exit strategy
  const results = EXIT_STRATS.map(() => []);

  const start = CFG.lookback + 6;
  const end   = candles.length - CFG.maxForward - 2;

  for (let i = start; i < end; i += CFG.scanStep) {
    const priceNow    = candles[i].close;
    const price24hAgo = candles[i - 6].close;
    const gain24h     = (priceNow - price24hAgo) / price24hAgo * 100;
    if (gain24h < minGain24h) continue;

    const { score } = analyzeCandles(candles.slice(i - CFG.lookback, i + 1), fundingRate);
    if (score < CFG.scoreThreshold) continue;

    // Wait-for-red entry
    let entryIdx   = null;
    let entryPrice = null;
    for (let j = i + 1; j <= i + 18 && j < candles.length; j++) {
      if (candles[j].close < candles[j].open) {
        entryIdx   = j;
        entryPrice = candles[j].close;
        break;
      }
    }
    if (!entryIdx) continue;  // never got a red candle

    for (let si = 0; si < EXIT_STRATS.length; si++) {
      const { returnPct, exitReason, holdCandles } = simulateExit(candles, entryIdx, entryPrice, EXIT_STRATS[si]);
      results[si].push({
        symbol,
        time        : new Date(candles[i].time).toISOString().slice(0, 16),
        gain24h     : +gain24h.toFixed(2),
        score,
        entryPrice,
        returnPct   : +Math.max(returnPct, -100).toFixed(2),  // cap loss at -100%
        exitReason,
        holdCandles,
      });
    }
  }

  return results;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
const mean    = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const median  = arr => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s.length % 2 ? s[Math.floor(s.length/2)] : (s[Math.floor(s.length/2)-1]+s[Math.floor(s.length/2)])/2;
};
const wr      = arr => arr.length ? (arr.filter(t => t.returnPct > 0).length / arr.length * 100).toFixed(1) : '0';
const fmt     = n   => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

function simulateCapital(trades, posSize = 0.10, startCap = 1000) {
  let cap = startCap;
  for (const t of [...trades].sort((a, b) => a.time.localeCompare(b.time))) {
    const pos = cap * posSize;
    const pnl = pos * (t.returnPct / 100);
    const fee = pos * 0.0011;
    cap = Math.max(0, cap + pnl - fee);
  }
  return cap;
}

// ── Report ────────────────────────────────────────────────────────────────────
function printReport(stratResults, label) {
  const n = stratResults[0].length;
  console.log(`\n┌─ ${label} — ${n} total signals ──────────────────────────────────────────`);
  console.log('│ Exit Strategy                   Trades  WR%   AvgRet  Median  $1000→   Monthly%  Reason breakdown');
  console.log('│ ' + '─'.repeat(105));

  const rows = [];

  for (let si = 0; si < EXIT_STRATS.length; si++) {
    const trades = stratResults[si];
    if (!trades.length) continue;

    const final   = simulateCapital(trades);
    const monthly = ((final - 1000) / 1000 * 100).toFixed(1);

    const reasons = {};
    for (const t of trades) {
      reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
    }
    const reasonStr = Object.entries(reasons).map(([k,v]) => `${k}:${v}`).join(' ');

    rows.push({ si, name: EXIT_STRATS[si].name, count: trades.length, wr: wr(trades),
                avgRet: mean(trades.map(t=>t.returnPct)), medRet: median(trades.map(t=>t.returnPct)),
                final, monthly, reasonStr });

    const marker = final >= 1500 ? ' ★' : final >= 1400 ? ' ◆' : '';
    console.log(
      '│ ' + EXIT_STRATS[si].name.padEnd(33) +
      String(trades.length).padStart(6) +
      (wr(trades)+'%').padStart(6) +
      fmt(mean(trades.map(t=>t.returnPct))).padStart(9) +
      fmt(median(trades.map(t=>t.returnPct))).padStart(8) +
      ('$'+final.toFixed(0)).padStart(8) +
      (monthly+'%').padStart(10) +
      marker +
      '  ' + reasonStr
    );
  }

  // Best by final capital
  const best = rows.sort((a,b) => b.final - a.final)[0];
  console.log(`└── Best: "${best.name}" → $${best.final.toFixed(2)} (+${best.monthly}%)\n`);

  return rows;
}

function printPositionSizeTable(stratResults, targetProfit = 500, startCap = 1000) {
  console.log(`\n── Position size needed to hit $${targetProfit}/month (on $${startCap}) ──────────────`);
  console.log('  Exit Strategy                   10%pos   15%pos   20%pos   25%pos   30%pos');
  console.log('  ' + '─'.repeat(85));

  for (let si = 0; si < EXIT_STRATS.length; si++) {
    const trades = stratResults[si];
    if (!trades.length) continue;

    const cols = [0.10, 0.15, 0.20, 0.25, 0.30].map(ps => {
      const final = simulateCapital(trades, ps);
      const profit = final - startCap;
      const marker = profit >= targetProfit ? '★' : ' ';
      return `${marker}$${profit.toFixed(0).padStart(5)}`;
    });

    console.log('  ' + EXIT_STRATS[si].name.padEnd(33) + cols.join('  '));
  }
  console.log('\n  ★ = hits $500+ target');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  R:R Optimizer — Target $500/month       ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Entry: wait-for-red | Score ≥ ${CFG.scoreThreshold} | 4h candles\n`);

  let symbols;
  try {
    symbols = await getAllSymbols();
    console.log(`Fetching ${symbols.length} symbols...\n`);
  } catch (err) { console.error(err.message); process.exit(1); }

  // Two passes: gain ≥ 30% and gain ≥ 20%
  const results30 = EXIT_STRATS.map(() => []);
  const results20 = EXIT_STRATS.map(() => []);
  let done = 0;

  for (const { symbol, fundingRate } of symbols) {
    try {
      const candles = await getKlines(symbol);
      if (candles.length < CFG.lookback + CFG.maxForward + 10) { done++; continue; }

      const r30 = backtestSymbol(symbol, candles, fundingRate, 30);
      const r20 = backtestSymbol(symbol, candles, fundingRate, 20);

      for (let si = 0; si < EXIT_STRATS.length; si++) {
        results30[si].push(...r30[si]);
        results20[si].push(...r20[si]);
      }

      if (r30[0].length) process.stdout.write(`  ${symbol.padEnd(16)} ${r30[0].length} signal(s) [≥30%]  ${r20[0].length} [≥20%]\n`);
    } catch { /* skip */ }

    done++;
    if (done % 20 === 0) process.stdout.write(`  ... ${done}/${symbols.length} done\n`);
    await sleep(CFG.requestDelay);
  }

  const rows30 = printReport(results30, 'Gain ≥ 30% filter');
  const rows20 = printReport(results20, 'Gain ≥ 20% filter (more signals)');

  printPositionSizeTable(results30, 500, 1000);

  // Find what gets to $500 with reasonable risk
  console.log('\n── Verdict ──────────────────────────────────────────────────────');
  const allRows = rows30.concat(rows20);
  const hits500 = allRows.filter(r => {
    return [0.10,0.15,0.20].some(ps => simulateCapital(results30[r.si] ?? results20[r.si], ps) - 1000 >= 500);
  });

  if (hits500.length === 0) {
    console.log('  No strategy hits $500 at ≤20% position size (signal count too low this month).');
    console.log('  Best realistic target at 10% pos: see table above.');
  } else {
    for (const r of hits500.slice(0, 3)) {
      for (const ps of [0.10,0.15,0.20]) {
        const final = simulateCapital(results30[r.si], ps);
        if (final - 1000 >= 500) {
          console.log(`  "${r.name}" at ${(ps*100).toFixed(0)}% position → $${(final-1000).toFixed(0)} profit`);
          break;
        }
      }
    }
  }
  console.log('\n⚠️  Not financial advice. Always use a stop loss.\n');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
