/**
 * Backtest: replay the short-signal scanner over last ~33 days of 4h candles.
 *
 * For every 8h step, it checks which coins were up 30%+ in the prior 24h,
 * runs the signal analysis, and records what price did in the next 24/48/72h.
 *
 * Usage:  node backtest.js
 */

require('dotenv').config();
const axios    = require('axios');
const { analyzeCandles } = require('./src/analysis');

// ── Config ──────────────────────────────────────────────────────────────────
const CFG = {
  interval       : '240',       // 4h candles  (6 candles = 24h)
  fetchLimit     : 200,         // ~33 days of 4h candles per symbol
  scanStep       : 2,           // check every 2 candles = every 8h
  win24h         : 6,           // candles ahead for 24h outcome
  win48h         : 12,          // candles ahead for 48h outcome
  win72h         : 18,          // candles ahead for 72h outcome
  lookback       : 60,          // candles used for indicator calculation
  minGain24h     : 30,          // % — trigger threshold
  scoreThreshold : 4,           // signal score to count as an alert
  minVolumeUSDT  : 500_000,     // daily volume filter (skip micro-caps)
  requestDelay   : 220,         // ms between Bybit requests
};

const http = axios.create({ baseURL: 'https://api.bybit.com', timeout: 15000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Bybit helpers ────────────────────────────────────────────────────────────
async function getAllSymbols() {
  const res = await http.get('/v5/market/tickers', { params: { category: 'linear' } });
  return res.data.result.list
    .filter(t => t.symbol.endsWith('USDT'))
    .filter(t => parseFloat(t.volume24h) * parseFloat(t.lastPrice) >= CFG.minVolumeUSDT)
    .map(t => ({
      symbol      : t.symbol,
      fundingRate : parseFloat(t.fundingRate ?? 0),
    }));
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

// ── Backtest core ────────────────────────────────────────────────────────────
function backtestSymbol(symbol, candles, fundingRate) {
  const trades = [];

  // Need lookback candles behind + 6 for 24h-change + forward window ahead
  const start = CFG.lookback + 6;
  const end   = candles.length - CFG.win72h - 1;

  for (let i = start; i < end; i += CFG.scanStep) {
    // 24h change: 6 × 4h candles = 24h
    const priceNow  = candles[i].close;
    const price24hAgo = candles[i - 6].close;
    const gain24h   = (priceNow - price24hAgo) / price24hAgo * 100;

    if (gain24h < CFG.minGain24h) continue;

    // Run signal analysis on the lookback window ending at i
    const window  = candles.slice(i - CFG.lookback, i + 1);
    const result  = analyzeCandles(window, fundingRate);

    if (result.score < CFG.scoreThreshold) continue;

    // Measure outcomes (short = profit when price drops)
    const entry   = priceNow;
    const p24h    = candles[i + CFG.win24h].close;
    const p48h    = candles[i + CFG.win48h].close;
    const p72h    = candles[i + CFG.win72h].close;

    // Short return = (entry - exit) / entry × 100  (positive = price fell = profit)
    const ret24h  = (entry - p24h) / entry * 100;
    const ret48h  = (entry - p48h) / entry * 100;
    const ret72h  = (entry - p72h) / entry * 100;

    // Max adverse excursion: highest price reached after entry (risk for short)
    const futureHigh = Math.max(...candles.slice(i + 1, i + CFG.win72h + 1).map(c => c.high));
    const mae        = (futureHigh - entry) / entry * 100;  // how much it ripped against you

    // Max favourable excursion: lowest price reached (best-case for short)
    const futureLow  = Math.min(...candles.slice(i + 1, i + CFG.win72h + 1).map(c => c.low));
    const mfe        = (entry - futureLow) / entry * 100;   // how far it dropped in your favour

    trades.push({
      symbol,
      time    : new Date(candles[i].time).toISOString().slice(0, 16),
      gain24h : +gain24h.toFixed(2),
      score   : result.score,
      signals : result.signals.map(s => s.name),
      entry,
      ret24h  : +ret24h.toFixed(2),
      ret48h  : +ret48h.toFixed(2),
      ret72h  : +ret72h.toFixed(2),
      mae     : +mae.toFixed(2),   // positive = bad for short (price went up)
      mfe     : +mfe.toFixed(2),   // positive = good for short (price went down)
    });
  }

  return trades;
}

// ── Statistics helpers ───────────────────────────────────────────────────────
function mean(arr)   { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function winRate(arr, key) {
  if (!arr.length) return 0;
  return (arr.filter(t => t[key] > 0).length / arr.length * 100).toFixed(1);
}
function fmt(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }

// ── Report ───────────────────────────────────────────────────────────────────
function printReport(allTrades) {
  const N = allTrades.length;

  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║              BACKTEST RESULTS — last ~33 days                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Total signals fired : ${N}`);

  if (N === 0) {
    console.log('No trades — try lowering scoreThreshold or minGain24h in CFG.');
    return;
  }

  // ── Overall win rates ──
  console.log('\n── Win Rates (short profitable = price fell after entry) ──────');
  console.log(`  24h win rate : ${winRate(allTrades, 'ret24h')}%  (avg ${fmt(mean(allTrades.map(t => t.ret24h)))}  median ${fmt(median(allTrades.map(t => t.ret24h)))})`);
  console.log(`  48h win rate : ${winRate(allTrades, 'ret48h')}%  (avg ${fmt(mean(allTrades.map(t => t.ret48h)))}  median ${fmt(median(allTrades.map(t => t.ret48h)))})`);
  console.log(`  72h win rate : ${winRate(allTrades, 'ret72h')}%  (avg ${fmt(mean(allTrades.map(t => t.ret72h)))}  median ${fmt(median(allTrades.map(t => t.ret72h)))})`);

  // ── Risk profile ──
  const avgMAE = mean(allTrades.map(t => t.mae));
  const avgMFE = mean(allTrades.map(t => t.mfe));
  console.log('\n── Risk Profile ───────────────────────────────────────────────');
  console.log(`  Avg max adverse excursion (MAE)  : +${avgMAE.toFixed(2)}%  ← how far it ripped after signal`);
  console.log(`  Avg max favourable excursion (MFE): +${avgMFE.toFixed(2)}%  ← max drop available to capture`);
  console.log(`  Reward/Risk ratio                : ${(avgMFE / (avgMAE || 1)).toFixed(2)}`);

  // ── By signal score bucket ──
  console.log('\n── By Signal Score ────────────────────────────────────────────');
  const buckets = {};
  for (const t of allTrades) {
    const b = t.score;
    if (!buckets[b]) buckets[b] = [];
    buckets[b].push(t);
  }
  console.log('  Score  Count  WR-24h  WR-48h  WR-72h  Avg-48h');
  for (const score of Object.keys(buckets).sort((a, b) => +b - +a)) {
    const ts = buckets[score];
    const row = [
      String(score).padStart(5),
      String(ts.length).padStart(6),
      (winRate(ts, 'ret24h') + '%').padStart(7),
      (winRate(ts, 'ret48h') + '%').padStart(7),
      (winRate(ts, 'ret72h') + '%').padStart(7),
      fmt(mean(ts.map(t => t.ret48h))).padStart(9),
    ];
    console.log('  ' + row.join('  '));
  }

  // ── Signal effectiveness ──
  console.log('\n── Signal Hit-Rate (did 24h outcome win when this signal was present?) ──');
  const sigStats = {};
  for (const t of allTrades) {
    for (const sig of t.signals) {
      if (!sigStats[sig]) sigStats[sig] = { count: 0, wins: 0 };
      sigStats[sig].count++;
      if (t.ret24h > 0) sigStats[sig].wins++;
    }
  }
  const sigRows = Object.entries(sigStats)
    .map(([name, s]) => ({ name, count: s.count, wr: (s.wins / s.count * 100).toFixed(1) }))
    .sort((a, b) => +b.wr - +a.wr);

  console.log('  Signal                Count   WR-24h');
  for (const r of sigRows) {
    console.log(`  ${r.name.padEnd(24)} ${String(r.count).padStart(4)}   ${r.wr}%`);
  }

  // ── Top coins by win rate (≥3 trades) ──
  const bySymbol = {};
  for (const t of allTrades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
    bySymbol[t.symbol].push(t);
  }
  const symbolRows = Object.entries(bySymbol)
    .filter(([, ts]) => ts.length >= 3)
    .map(([sym, ts]) => ({
      sym,
      count  : ts.length,
      wr48h  : +winRate(ts, 'ret48h'),
      avg48h : +mean(ts.map(t => t.ret48h)).toFixed(2),
    }))
    .sort((a, b) => b.wr48h - a.wr48h)
    .slice(0, 10);

  if (symbolRows.length) {
    console.log('\n── Top Symbols (≥3 signals, best 48h win rate) ───────────────');
    console.log('  Symbol           Signals  WR-48h  Avg-48h');
    for (const r of symbolRows) {
      console.log(`  ${r.sym.padEnd(16)} ${String(r.count).padStart(6)}  ${String(r.wr48h).padStart(6)}%  ${fmt(r.avg48h).padStart(8)}`);
    }
  }

  // ── Best & worst individual trades ──
  const sorted48 = [...allTrades].sort((a, b) => b.ret48h - a.ret48h);
  console.log('\n── Best 5 Trades (48h short return) ──────────────────────────');
  for (const t of sorted48.slice(0, 5)) {
    console.log(`  ${t.symbol.padEnd(16)} ${t.time}  gain:+${t.gain24h}%  ret48h:${fmt(t.ret48h)}  score:${t.score}`);
  }

  console.log('\n── Worst 5 Trades (48h short return) ─────────────────────────');
  for (const t of sorted48.slice(-5).reverse()) {
    console.log(`  ${t.symbol.padEnd(16)} ${t.time}  gain:+${t.gain24h}%  ret48h:${fmt(t.ret48h)}  MAE:+${t.mae}%`);
  }

  // ── Capital simulation ────────────────────────────────────────────────────
  simulateCapital(allTrades);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('⚠️  Past performance does not guarantee future results.');
  console.log('   Always use a stop loss. This is not financial advice.\n');
}

// ── Capital simulation ────────────────────────────────────────────────────────
// Uses actual MAE to determine liquidations, includes Bybit taker fees (0.055%)
function simulateCapital(allTrades, startingCapital = 1000) {
  console.log('\n── $1000 Capital Simulation (48h hold, chronological) ─────────');
  console.log('   MAE used to detect liquidations. Fee: 0.055% taker × 2 sides.\n');

  const sorted = [...allTrades].sort((a, b) => a.time.localeCompare(b.time));

  const scenarios = [
    { label: 'Safe     5% pos  1x lev', posSize: 0.05, leverage: 1  },
    { label: 'Moderate 10% pos  1x lev', posSize: 0.10, leverage: 1  },
    { label: 'Moderate 10% pos  2x lev', posSize: 0.10, leverage: 2  },
    { label: 'Bold     20% pos  2x lev', posSize: 0.20, leverage: 2  },
    { label: 'Risky    20% pos  3x lev', posSize: 0.20, leverage: 3  },
  ];

  // Score ≥ 6 only (high-conviction filter from backtest stats)
  const highConv = sorted.filter(t => t.score >= 6);

  for (const allSet of [
    { tag: 'All signals (score ≥ 4)', trades: sorted   },
    { tag: 'High conviction (score ≥ 6)', trades: highConv },
  ]) {
    console.log(`  ┌─ ${allSet.tag} — ${allSet.trades.length} trades ─────────────────────────────`);
    console.log(`  │  Strategy               Final $    Return    W   L  Liq  Fees`);

    for (const s of scenarios) {
      let capital = startingCapital;
      let wins = 0, losses = 0, liquidations = 0, totalFees = 0;
      const liqThreshold = 100 / s.leverage; // % price move against short that causes liquidation

      for (const t of allSet.trades) {
        if (capital <= 0) break;

        const posValue = capital * s.posSize;
        const fee = posValue * s.leverage * 0.00055 * 2; // open + close fee on leveraged notional

        let pnl;
        if (t.mae >= liqThreshold) {
          // Price ripped past liquidation level before coming back
          pnl = -posValue;
          liquidations++;
        } else {
          // Clamp at -100% of position (can't lose more than you put in)
          const leveragedRet = Math.max(t.ret48h * s.leverage, -100) / 100;
          pnl = posValue * leveragedRet;
          if (pnl > 0) wins++; else losses++;
        }

        capital = Math.max(0, capital + pnl - fee);
        totalFees += fee;
      }

      const totalRet = ((capital - startingCapital) / startingCapital * 100).toFixed(1);
      const sign = capital >= startingCapital ? '+' : '';
      console.log(
        `  │  ${s.label}` +
        `   $${capital.toFixed(0).padStart(6)}` +
        `  ${(sign + totalRet + '%').padStart(7)}` +
        `  ${String(wins).padStart(3)}` +
        `  ${String(losses).padStart(3)}` +
        `  ${String(liquidations).padStart(3)}` +
        `  $${totalFees.toFixed(0).padStart(4)}`
      );
    }

    console.log('  └────────────────────────────────────────────────────────────');
    console.log();
  }

  // Per-trade breakdown for high-conviction, moderate scenario
  const refScenario = { posSize: 0.10, leverage: 1, liqThreshold: 100 };
  let capital = startingCapital;
  console.log('  Monthly breakdown (high-conviction, 10% pos, 1x lev):');
  const byMonth = {};
  for (const t of highConv) {
    const month = t.time.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { trades: 0, pnl: 0 };
    const posValue = capital * refScenario.posSize;
    const leveragedRet = Math.max(t.ret48h, -100) / 100;
    const pnl = posValue * leveragedRet - posValue * 0.00110;
    byMonth[month].trades++;
    byMonth[month].pnl += pnl;
    capital = Math.max(0, capital + pnl);
  }
  for (const [month, d] of Object.entries(byMonth)) {
    const sign = d.pnl >= 0 ? '+' : '';
    console.log(`    ${month}  trades:${d.trades}  P&L: ${sign}$${d.pnl.toFixed(2)}  balance: $${capital.toFixed(2)}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     Crypto Short Scanner — Backtest   ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Candle interval  : 4h`);
  console.log(`History          : ~33 days`);
  console.log(`Trigger          : 24h gain >= ${CFG.minGain24h}%`);
  console.log(`Alert threshold  : score >= ${CFG.scoreThreshold}`);
  console.log(`Scan step        : every 8h\n`);

  let symbols;
  try {
    symbols = await getAllSymbols();
    console.log(`Fetching ${symbols.length} symbols from Bybit...\n`);
  } catch (err) {
    console.error('Failed to load symbols:', err.message);
    process.exit(1);
  }

  const allTrades = [];
  let done = 0;

  for (const { symbol, fundingRate } of symbols) {
    try {
      const candles = await getKlines(symbol);
      if (candles.length < CFG.lookback + CFG.win72h + 10) {
        done++;
        continue; // not enough history
      }
      const trades = backtestSymbol(symbol, candles, fundingRate);
      allTrades.push(...trades);
      if (trades.length) {
        process.stdout.write(`  ${symbol.padEnd(16)} ${trades.length} signal(s)\n`);
      }
    } catch (err) {
      // silently skip symbols with API errors
    }

    done++;
    if (done % 20 === 0) {
      process.stdout.write(`  ... ${done}/${symbols.length} symbols processed, ${allTrades.length} trades so far\n`);
    }

    await sleep(CFG.requestDelay);
  }

  printReport(allTrades);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
