/**
 * Leverage backtest — 1 best coin per day
 *
 * Each calendar day: pick the single highest-score signal.
 * Enter at first red 4h close. Exit via TP or SL on candle data.
 * Test leverage 3x → 25x with appropriate TP/SL per level.
 *
 * Usage:  node backtest-leverage.js
 */

require('dotenv').config();
const axios          = require('axios');
const { analyzeCandles } = require('./src/analysis');

const CFG = {
  interval      : '240',
  fetchLimit    : 200,
  scanStep      : 1,          // every 4h — finer scan for 1-per-day selection
  lookback      : 60,
  scoreThreshold: 5,          // slightly looser — we pick best per day anyway
  minGain24h    : 25,
  minVolumeUSDT : 300_000,
  requestDelay  : 220,
  maxHoldCandles: 42,         // up to 7 days — let the dump fully play out
};

// ── Leverage configurations ───────────────────────────────────────────────────
// Wide SL variants: coin will dump within a week, so survive the bounce first.
// At Nx leverage, max SL price% = ~(100/N - 1)% before liquidation.
const LEVERAGE_CONFIGS = [
  // ── Wide SL, lower leverage: ride out the volatility ─────────────────────
  { lev:  3, tp: 35, sl: 20, pos: 0.15, label: ' 3x  TP35% SL20%  pos15%' },
  { lev:  3, tp: 30, sl: 25, pos: 0.15, label: ' 3x  TP30% SL25%  pos15%' },
  { lev:  5, tp: 30, sl: 15, pos: 0.10, label: ' 5x  TP30% SL15%  pos10%' },
  { lev:  5, tp: 25, sl: 15, pos: 0.12, label: ' 5x  TP25% SL15%  pos12%' },
  { lev:  5, tp: 25, sl: 18, pos: 0.10, label: ' 5x  TP25% SL18%  pos10%' },
  { lev:  5, tp: 30, sl: 18, pos: 0.10, label: ' 5x  TP30% SL18%  pos10%' },
  // ── Trailing stop: lock in profit as it dumps, wide initial SL ───────────
  { lev:  5, tp: null, sl: 18, trail: 12, pos: 0.10, label: ' 5x  Trail12% SL18% pos10%' },
  { lev:  3, tp: null, sl: 25, trail: 15, pos: 0.15, label: ' 3x  Trail15% SL25% pos15%' },
  // ── Previous best for comparison ─────────────────────────────────────────
  { lev: 10, tp: 20, sl:  6, pos: 0.06, label: '10x  TP20% SL6%   pos6%  [prev]' },
];

// ── Exit simulator (price-level TP/SL, candle by candle) ─────────────────────
// Returns { retOnMargin, exitReason } where retOnMargin is % return on posted margin.
function simulateLeveragedExit(candles, entryIdx, entryPrice, cfg) {
  const tpPrice  = cfg.tp    ? entryPrice * (1 - cfg.tp  / 100) : null;
  const slPrice  = entryPrice * (1 + cfg.sl / 100);
  const liqPrice = entryPrice * (1 + (100 / cfg.lev - 0.5) / 100);  // ~100/lev price move

  let trailStop    = cfg.trail ? entryPrice * (1 + cfg.trail / 100) : null;
  let lowestClose  = entryPrice;

  for (let j = entryIdx + 1; j <= Math.min(entryIdx + CFG.maxHoldCandles, candles.length - 1); j++) {
    const c = candles[j];

    // SL checked BEFORE liquidation — a stop order at slPrice executes before liq price is reached.
    // Liquidation only fires if the candle gaps so far above SL that slippage in real life
    // would take you to liq (treated here as a gap scenario if HIGH > liqPrice by 2x the SL distance).
    const gapLiq = entryPrice * (1 + (cfg.sl / 100) * 2 + (100 / cfg.lev - 0.5) / 100);

    // Trailing stop or fixed SL
    const activeStop = trailStop ?? slPrice;
    if (c.high >= activeStop) {
      const execPrice = activeStop;                                          // assume order fills at stop
      const priceRet  = (entryPrice - execPrice) / entryPrice * 100;        // negative for loss
      return { retOnMargin: Math.max(priceRet * cfg.lev, -100), exitReason: trailStop ? 'trail' : 'sl' };
    }

    // Liquidation only if candle gaps so far past SL that real execution would be at liq
    if (c.high >= gapLiq) {
      return { retOnMargin: -100, exitReason: 'gap-liq' };
    }

    // TP hit
    if (tpPrice && c.low <= tpPrice) {
      const priceRet = (entryPrice - tpPrice) / entryPrice * 100;
      return { retOnMargin: priceRet * cfg.lev, exitReason: 'tp' };
    }

    // Update trailing stop on new low close
    if (trailStop && c.close < lowestClose) {
      lowestClose = c.close;
      trailStop = lowestClose * (1 + cfg.trail / 100);
    }
  }

  // Timeout — force exit
  const exitPrice = candles[Math.min(entryIdx + CFG.maxHoldCandles, candles.length - 1)].close;
  const priceRet  = (entryPrice - exitPrice) / entryPrice * 100;
  return { retOnMargin: Math.max(priceRet * cfg.lev, -100), exitReason: 'timeout' };
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

// ── Collect all raw signals across all symbols ────────────────────────────────
function collectSignals(symbol, candles, fundingRate) {
  const signals = [];
  const start = CFG.lookback + 6;
  const end   = candles.length - CFG.maxHoldCandles - 2;

  for (let i = start; i < end; i += CFG.scanStep) {
    const priceNow    = candles[i].close;
    const price24hAgo = candles[i - 6].close;
    const gain24h     = (priceNow - price24hAgo) / price24hAgo * 100;
    if (gain24h < CFG.minGain24h) continue;

    const { score } = analyzeCandles(candles.slice(i - CFG.lookback, i + 1), fundingRate);
    if (score < CFG.scoreThreshold) continue;

    // Find wait-for-red entry
    let entryIdx = null, entryPrice = null;
    for (let j = i + 1; j <= i + 12 && j < candles.length; j++) {
      if (candles[j].close < candles[j].open) {
        entryIdx = j; entryPrice = candles[j].close; break;
      }
    }
    if (!entryIdx) continue;

    const day = new Date(candles[i].time).toISOString().slice(0, 10);

    signals.push({
      symbol,
      day,
      signalTime  : new Date(candles[i].time).toISOString().slice(0, 16),
      gain24h     : +gain24h.toFixed(2),
      score,
      fundingRate,
      candles,      // ref for exit simulation
      entryIdx,
      entryPrice,
    });
  }

  return signals;
}

// ── Pick best signal per calendar day ────────────────────────────────────────
// Rules:
//  1. Highest score wins. Tie-break: highest gain24h.
//  2. Skip coins already up >150% in 24h — parabolic moves can keep going and wreck the short.
//  3. Don't pick the same coin two days in a row — if it didn't dump yesterday, the momentum is still up.
function pickBestPerDay(allSignals) {
  const byDay = {};

  for (const s of allSignals) {
    if (s.gain24h > 150) continue;          // rule 2: skip extreme parabolic pumps

    if (!byDay[s.day] || s.score > byDay[s.day].score ||
       (s.score === byDay[s.day].score && s.gain24h > byDay[s.day].gain24h)) {
      byDay[s.day] = s;
    }
  }

  const sorted = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));

  // Rule 3: remove consecutive same-coin days
  const filtered = [];
  for (const s of sorted) {
    const prev = filtered[filtered.length - 1];
    if (prev && prev.symbol === s.symbol) continue;   // same coin as yesterday → skip
    filtered.push(s);
  }

  return filtered;
}

// ── Statistics ────────────────────────────────────────────────────────────────
const mean   = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const fmt    = n   => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const fmtUSD = n   => (n >= 0 ? '+$' : '-$') + Math.abs(n).toFixed(0);

// ── Capital simulation ────────────────────────────────────────────────────────
function simulateCapital(dailyTrades, startCap = 1000) {
  let cap = startCap;
  for (const t of dailyTrades) {
    const margin = cap * t.cfg.pos;
    const fee    = margin * t.cfg.lev * 0.00055 * 2;   // taker fee on notional, both sides
    const pnl    = margin * (t.retOnMargin / 100);
    cap          = Math.max(0, cap + pnl - fee);
  }
  return cap;
}

// ── Report ────────────────────────────────────────────────────────────────────
function printReport(dailySignals, allResults) {
  const nDays = dailySignals.length;
  const nDaysWithSignal = new Set(dailySignals.map(s => s.day)).size;

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        LEVERAGE BACKTEST — 1 Best Coin Per Day                   ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Active days (had signal): ${nDaysWithSignal} / ~33`);
  console.log(`Signals used: ${nDays}\n`);

  // Per-day selection table
  console.log('── Daily Picks ──────────────────────────────────────────────────');
  console.log('  Date        Symbol           +24h   Score  Entry$');
  for (const s of dailySignals) {
    console.log(`  ${s.day}  ${s.symbol.padEnd(16)} +${s.gain24h}%  ${s.score}   ${s.entryPrice}`);
  }

  // Leverage comparison table
  console.log('\n── Leverage Comparison ($1000 starting capital) ──────────────────');
  console.log('  Config                      Trades  WR%   AvgRet(margin)  $1000→   Monthly%  TP  SL  Liq  Timeout');
  console.log('  ' + '─'.repeat(100));

  const tableRows = [];

  for (let ci = 0; ci < LEVERAGE_CONFIGS.length; ci++) {
    const trades = allResults[ci];
    if (!trades.length) continue;

    const rets   = trades.map(t => t.retOnMargin);
    const wins   = trades.filter(t => t.retOnMargin > 0).length;
    const losses = trades.filter(t => t.retOnMargin <= 0 && t.exitReason !== 'liquidated').length;
    const liqs   = trades.filter(t => t.exitReason === 'liquidated').length;
    const tos    = trades.filter(t => t.exitReason === 'timeout').length;
    const final  = simulateCapital(trades);
    const monthly= ((final - 1000) / 1000 * 100).toFixed(1);
    const wr     = (wins / trades.length * 100).toFixed(1);

    tableRows.push({ ci, final, monthly, trades });

    const marker = final >= 1500 ? ' ★' : final >= 1300 ? ' ◆' : '';
    console.log(
      '  ' + LEVERAGE_CONFIGS[ci].label.padEnd(28) +
      String(trades.length).padStart(6) +
      (wr + '%').padStart(6) +
      fmt(mean(rets)).padStart(16) +
      ('$' + final.toFixed(0)).padStart(8) +
      (monthly + '%').padStart(10) +
      String(wins).padStart(4) +
      String(losses).padStart(4) +
      String(liqs).padStart(4) +
      String(tos).padStart(5) +
      marker
    );
  }

  // Monthly P&L breakdown for best config
  tableRows.sort((a, b) => b.final - a.final);
  const bestCi     = tableRows[0].ci;
  const bestCfg    = LEVERAGE_CONFIGS[bestCi];
  const bestTrades = allResults[bestCi];

  console.log(`\n── Monthly P&L breakdown [best: ${bestCfg.label.trim()}] ──`);
  let capital = 1000;
  const byMonth = {};
  for (const t of bestTrades) {
    const month  = t.day.slice(0, 7);
    const margin = capital * bestCfg.pos;
    const fee    = margin * bestCfg.lev * 0.00055 * 2;
    const pnl    = margin * (t.retOnMargin / 100) - fee;
    capital      = Math.max(0, capital + pnl);
    if (!byMonth[month]) byMonth[month] = { trades: 0, pnl: 0, bal: 0 };
    byMonth[month].trades++;
    byMonth[month].pnl += pnl;
    byMonth[month].bal  = capital;
  }
  for (const [m, d] of Object.entries(byMonth)) {
    console.log(`  ${m}  ${d.trades} trades  P&L: ${fmtUSD(d.pnl)}  balance: $${d.bal.toFixed(2)}`);
  }

  // Trade log for best config
  console.log(`\n── Trade log [${bestCfg.label.trim()}] ────────────────────────────`);
  console.log('  Date        Coin             +24h%  Score  Entry→  retMargin  Reason');
  for (const t of bestTrades) {
    const marker = t.retOnMargin > 0 ? '✓' : '✗';
    console.log(
      `  ${marker} ${t.day}  ${t.symbol.padEnd(16)} +${t.gain24h}%  ` +
      `${t.score}  ${t.entryPrice}  ${fmt(t.retOnMargin).padStart(8)}  ${t.exitReason}`
    );
  }

  // $500 path
  console.log('\n── Path to $500/month ───────────────────────────────────────────');
  for (const row of tableRows.slice(0, 5)) {
    const cfg    = LEVERAGE_CONFIGS[row.ci];
    const profit = row.final - 1000;
    const needed = profit >= 500
      ? '✓ Already hits $500'
      : `Need $${(1000 * 500 / profit).toFixed(0)} capital (at same %return)`;
    console.log(`  ${cfg.label.trim().padEnd(30)} profit=$${profit.toFixed(0)}  ${needed}`);
  }

  console.log('\n⚠️  High leverage = high liquidation risk. Always use a stop loss. Not financial advice.\n');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Leverage Backtest — 1 Best Coin / Day   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`Score ≥ ${CFG.scoreThreshold} | Gain ≥ ${CFG.minGain24h}% | 4h candles | 1 trade/day\n`);

  let symbols;
  try {
    symbols = await getAllSymbols();
    console.log(`Fetching ${symbols.length} symbols...\n`);
  } catch (err) { console.error(err.message); process.exit(1); }

  const allSignals = [];
  let done = 0;

  for (const { symbol, fundingRate } of symbols) {
    try {
      const candles = await getKlines(symbol);
      if (candles.length < CFG.lookback + CFG.maxHoldCandles + 10) { done++; continue; }
      const sigs = collectSignals(symbol, candles, fundingRate);
      allSignals.push(...sigs);
      if (sigs.length) process.stdout.write(`  ${symbol.padEnd(16)} ${sigs.length} signal(s)\n`);
    } catch { /* skip */ }

    done++;
    if (done % 25 === 0) process.stdout.write(`  ... ${done}/${symbols.length}  total signals: ${allSignals.length}\n`);
    await sleep(CFG.requestDelay);
  }

  console.log(`\nTotal raw signals: ${allSignals.length}`);

  // Pick 1 best per day
  const dailySignals = pickBestPerDay(allSignals);
  console.log(`Trading days with signal: ${dailySignals.length}\n`);

  // Simulate all leverage configs on the daily picks
  const allResults = LEVERAGE_CONFIGS.map(() => []);

  for (const sig of dailySignals) {
    for (let ci = 0; ci < LEVERAGE_CONFIGS.length; ci++) {
      const { retOnMargin, exitReason } = simulateLeveragedExit(
        sig.candles, sig.entryIdx, sig.entryPrice, LEVERAGE_CONFIGS[ci]
      );
      allResults[ci].push({
        day        : sig.day,
        symbol     : sig.symbol,
        gain24h    : sig.gain24h,
        score      : sig.score,
        entryPrice : sig.entryPrice,
        retOnMargin: +retOnMargin.toFixed(2),
        exitReason,
        cfg        : LEVERAGE_CONFIGS[ci],
      });
    }
  }

  printReport(dailySignals, allResults);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
