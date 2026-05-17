/**
 * Altcoin EMA Grid — 1-Year Backtest (1H candles)
 * - Scans Bybit top movers today (same filter as live bot)
 * - Fetches 365 days of 1H candles per coin (9 pages × 1000)
 * - Runs bidirectional EMA20/50 grid: LONG when EMA20>EMA50, SHORT when EMA20<EMA50
 * - Prints monthly P&L breakdown + scale-up table
 */

const axios = require('axios');

const TRADE_SIZE    = 200;
const MAX_ACTIVE    = 4;
const CYCLE_GAP     = 0.02;
const TP_PCT        = CYCLE_GAP / 3;   // 0.67% per position
const GRID_STEP     = 0.005;
const EMA_FAST      = 20;
const EMA_SLOW      = 50;
const INTERVAL      = '60';            // 1-hour candles
const DAYS          = 365;
const MIN_VOL_USD   = 20_000_000;
const MIN_CHANGE    = 1.5;
const TOP_N         = 30;

// Same trend filters as live bot
const MIN_EMA_SEP   = 0.004;
const SWITCH_COOL   = 4;              // 4 × 1H = 4H cooldown (same as 16 × 15min)
const MIN_TREND_PCT = 0.55;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function calcEMA(values, period) {
  const k    = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period).fill(seed);
  let ema = seed;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

async function fetchTickers() {
  const res = await axios.get(
    'https://api.bybit.com/v5/market/tickers?category=linear',
    { timeout: 10000 }
  );
  return res.data.result.list
    .filter(t =>
      t.symbol.endsWith('USDT') &&
      !t.symbol.includes('1000') &&
      !t.symbol.includes('USDC')
    )
    .map(t => ({
      symbol:    t.symbol,
      change24h: parseFloat(t.price24hPcnt) * 100,
      vol24h:    parseFloat(t.turnover24h),
    }))
    .filter(t => t.vol24h >= MIN_VOL_USD && Math.abs(t.change24h) >= MIN_CHANGE)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h))
    .slice(0, TOP_N);
}

async function fetchKlines(symbol) {
  const totalNeeded = DAYS * 24;    // 365 × 24 = 8760 candles
  const perPage     = 1000;
  const pages       = Math.ceil(totalNeeded / perPage);
  let   all         = [];
  let   end         = undefined;

  for (let p = 0; p < pages; p++) {
    const url =
      `https://api.bybit.com/v5/market/kline?category=linear` +
      `&symbol=${symbol}&interval=${INTERVAL}&limit=${perPage}` +
      (end ? `&end=${end}` : '');
    try {
      const res = await axios.get(url, { timeout: 15000 });
      if (res.data.retCode !== 0) break;
      const page = res.data.result.list.map(c => ({
        ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4],
      }));
      if (!page.length) break;
      all = all.concat(page);
      end = Math.min(...page.map(c => c.ts)) - 1;
    } catch { break; }
    await sleep(150);
  }

  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

function runGrid(candles, symbol) {
  if (candles.length < EMA_SLOW + 20) return null;

  const closes = candles.map(c => c.close);
  const ema20  = calcEMA(closes, EMA_FAST);
  const ema50  = calcEMA(closes, EMA_SLOW);

  // Pre-filter: skip coins that don't trend at least MIN_TREND_PCT of the time
  let trendCount = 0;
  for (let i = EMA_SLOW; i < candles.length; i++) {
    if (Math.abs(ema20[i] - ema50[i]) / ema50[i] >= MIN_EMA_SEP) trendCount++;
  }
  const trendPct = trendCount / (candles.length - EMA_SLOW);
  if (trendPct < MIN_TREND_PCT) return { symbol, skipped: true, trendPct };

  let mode       = null;
  let positions  = [];
  let trades     = [];
  let closedPnl  = 0;
  let peak       = 0;
  let runPnl     = 0;
  let maxDD      = 0;
  let switches   = 0;
  let lastSwitch = -SWITCH_COOL;

  const monthlyPnl = {};

  for (let i = EMA_SLOW + 1; i < candles.length; i++) {
    const c       = candles[i];
    const newMode = ema20[i] > ema50[i] ? 'long' : 'short';
    const month   = new Date(c.ts).toISOString().slice(0, 7);
    const emaSep  = Math.abs(ema20[i] - ema50[i]) / ema50[i];

    // Mode switch with cooldown
    if (mode && newMode !== mode && (i - lastSwitch) >= SWITCH_COOL) {
      for (const pos of positions) {
        const pnl = pos.mode === 'long'
          ? (c.close - pos.entry) / pos.entry * TRADE_SIZE
          : (pos.entry - c.close) / pos.entry * TRADE_SIZE;
        trades.push({ type: 'switch', pnl, month });
        closedPnl += pnl;
        runPnl    += pnl;
        if (!monthlyPnl[month]) monthlyPnl[month] = 0;
        monthlyPnl[month] += pnl;
      }
      positions  = [];
      lastSwitch = i;
      switches++;
    }
    mode = newMode;

    // Check TPs
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      let pnl = null, exitPrice;

      if (pos.mode === 'long') {
        exitPrice = pos.entry * (1 + TP_PCT);
        if (c.high >= exitPrice)
          pnl = (exitPrice - pos.entry) / pos.entry * TRADE_SIZE;
      } else {
        exitPrice = pos.entry * (1 - TP_PCT);
        if (c.low <= exitPrice)
          pnl = (pos.entry - exitPrice) / pos.entry * TRADE_SIZE;
      }

      if (pnl !== null) {
        trades.push({ type: 'tp', pnl, month });
        closedPnl += pnl;
        runPnl    += pnl;
        if (!monthlyPnl[month]) monthlyPnl[month] = 0;
        monthlyPnl[month] += pnl;
        positions.splice(pi, 1);
      }
    }

    if (runPnl > peak) peak = runPnl;
    const dd = runPnl - peak;
    if (dd < maxDD) maxDD = dd;

    // Open new grid position when trend is strong
    if (positions.length < MAX_ACTIVE && emaSep >= MIN_EMA_SEP) {
      const lastEntry = positions.length ? positions[positions.length - 1].entry : null;
      const dist      = lastEntry ? Math.abs(c.close - lastEntry) / lastEntry : 1;
      if (dist >= GRID_STEP) {
        positions.push({ entry: c.close, mode });
      }
    }
  }

  // Unrealized P&L on open positions at end of backtest
  const last = closes[closes.length - 1];
  let openPnl = 0;
  for (const pos of positions) {
    openPnl += pos.mode === 'long'
      ? (last - pos.entry) / pos.entry * TRADE_SIZE
      : (pos.entry - last) / pos.entry * TRADE_SIZE;
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const wr   = trades.length ? (wins / trades.length * 100).toFixed(1) : '0';

  return {
    symbol, mode,
    n: trades.length, wins, wr,
    closedPnl, openPnl,
    total: closedPnl + openPnl,
    maxDD, switches, monthlyPnl,
    candles: candles.length,
    trendPct,
  };
}

async function main() {
  console.log('\n═══ ALTCOIN EMA GRID — 1-YEAR BACKTEST (1H candles) ═══\n');
  console.log('Scanning Bybit for current top movers...\n');

  const tickers = await fetchTickers();
  if (!tickers.length) { console.log('No qualifying coins found.'); return; }

  console.log(`Found ${tickers.length} coins  (>$${MIN_VOL_USD/1e6}M vol  |  >±${MIN_CHANGE}%  |  top ${TOP_N})\n`);
  console.log('  Symbol         24H%     Volume');
  console.log('  ─────────────────────────────');
  for (const t of tickers) {
    console.log(
      `  ${t.symbol.padEnd(14)} ` +
      `${(t.change24h >= 0 ? '+' : '') + t.change24h.toFixed(1)}%`.padStart(8) +
      `  $${(t.vol24h / 1e6).toFixed(0)}M`
    );
  }

  console.log(`\nFetching ${DAYS} days of 1H candles & running grid sim...\n`);
  console.log('  Symbol         Candles  TrendQ  Trades   WR%   Closed$    Open$     Total');
  console.log('  ───────────────────────────────────────────────────────────────────────────');

  const results = [];

  for (const t of tickers) {
    process.stdout.write(`  ${t.symbol.padEnd(14)} fetching...`);
    try {
      const candles = await fetchKlines(t.symbol);

      if (candles.length < EMA_SLOW + 20) {
        process.stdout.write(`\r  ${t.symbol.padEnd(14)} — not enough data (${candles.length} candles)\n`);
        continue;
      }

      const r = runGrid(candles, t.symbol);
      if (!r) { process.stdout.write('\r'); continue; }

      if (r.skipped) {
        process.stdout.write(
          `\r  ${t.symbol.padEnd(14)} SKIP  (choppy — trend ${(r.trendPct * 100).toFixed(0)}% of time)\n`
        );
        continue;
      }

      results.push({ ...r, change24h: t.change24h });
      const flag = r.total > 20 ? ' ✅' : r.total < -20 ? ' ❌' : '  ';
      process.stdout.write(
        `\r  ${t.symbol.padEnd(14)} ` +
        `${String(candles.length).padStart(6)}  ` +
        `${(r.trendPct * 100).toFixed(0).padStart(4)}%  ` +
        `${String(r.n).padStart(6)}tr  ` +
        `${(r.wr + '%').padStart(5)}  ` +
        `${r.closedPnl >= 0 ? '+' : ''}$${r.closedPnl.toFixed(0).padStart(7)}  ` +
        `${r.openPnl >= 0 ? '+' : ''}$${r.openPnl.toFixed(0).padStart(6)}  ` +
        `${r.total >= 0 ? '+' : ''}$${r.total.toFixed(0).padStart(7)}${flag}\n`
      );
    } catch (e) {
      process.stdout.write(`\r  ${t.symbol.padEnd(14)} ERR: ${e.message}\n`);
    }
    await sleep(200);
  }

  if (!results.length) { console.log('\nNo results.'); return; }

  results.sort((a, b) => b.total - a.total);
  const winners     = results.filter(r => r.total > 0);
  const losers      = results.filter(r => r.total <= 0);
  const totalAll    = results.reduce((s, r) => s + r.total, 0);
  const totalWin    = winners.reduce((s, r) => s + r.total, 0);
  const avgPerMonth = totalAll / 12;

  // ── Top winners table ────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(76)}`);
  console.log(`  SUMMARY — ${results.length} coins — 365 days — 1H candles — EMA${EMA_FAST}/${EMA_SLOW} grid — $${TRADE_SIZE}/trade`);
  console.log(`${'═'.repeat(76)}`);

  console.log(`\n  TOP WINNERS:`);
  console.log(`  Symbol         Mode    Trades  WR%    Total$    MaxDD    Switches`);
  console.log(`  ──────────────────────────────────────────────────────────────────`);
  for (const r of winners.slice(0, 15)) {
    const bar = '█'.repeat(Math.min(Math.round(r.total / 20), 18));
    console.log(
      `  ${r.symbol.padEnd(14)} ${(r.mode ?? '?').padEnd(6)}  ` +
      `${String(r.n).padStart(5)}tr  ` +
      `${(r.wr + '%').padStart(5)}  ` +
      `+$${r.total.toFixed(0).padStart(7)}  ` +
      `-$${Math.abs(r.maxDD).toFixed(0).padStart(6)}  ` +
      `${String(r.switches).padStart(3)}sw  ${bar}`
    );
  }

  if (losers.length) {
    console.log(`\n  LOSERS (${losers.length}):`);
    for (const r of losers.slice(0, 8)) {
      console.log(
        `  ${r.symbol.padEnd(14)} ${(r.mode ?? '?').padEnd(6)}  ` +
        `${String(r.n).padStart(5)}tr  WR:${r.wr}%  ` +
        `-$${Math.abs(r.total).toFixed(0)}`
      );
    }
  }

  // ── Monthly breakdown for best coin ─────────────────────────────────────────
  const best = results[0];
  if (best) {
    console.log(`\n  BEST COIN — ${best.symbol} — monthly P&L:`);
    console.log(`  Month       Trades  WR%    P&L       Cumulative  Bar`);
    console.log(`  ────────────────────────────────────────────────────────`);
    let cum = 0;
    const monthTrades = {};
    for (const t of []) { /* built below from best.monthlyPnl */ }
    for (const [m, pnl] of Object.entries(best.monthlyPnl).sort()) {
      cum += pnl;
      const bar = pnl > 0
        ? '█'.repeat(Math.min(Math.round(pnl / 5), 22))
        : '▒'.repeat(Math.min(Math.round(Math.abs(pnl) / 5), 22));
      console.log(
        `  ${m}   ` +
        `${(pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0).padStart(8)}  ` +
        `run:${(cum >= 0 ? '+' : '') + '$' + cum.toFixed(0).padStart(8)}  ${bar}`
      );
    }
  }

  // ── All-coin monthly aggregated P&L ─────────────────────────────────────────
  const allMonthly = {};
  for (const r of results) {
    for (const [m, v] of Object.entries(r.monthlyPnl)) {
      if (!allMonthly[m]) allMonthly[m] = 0;
      allMonthly[m] += v;
    }
  }
  console.log(`\n  ALL-COINS COMBINED — monthly P&L (${results.length} coins):`);
  console.log(`  Month       P&L        Cumulative   Bar`);
  console.log(`  ─────────────────────────────────────────────────────`);
  let cumAll = 0;
  let posMonths = 0, negMonths = 0;
  for (const [m, v] of Object.entries(allMonthly).sort()) {
    cumAll += v;
    if (v > 0) posMonths++; else negMonths++;
    const bar = v > 0
      ? '█'.repeat(Math.min(Math.round(v / 30), 20))
      : '▒'.repeat(Math.min(Math.round(Math.abs(v) / 30), 20));
    console.log(
      `  ${m}   ` +
      `${(v >= 0 ? '+' : '') + '$' + v.toFixed(0).padStart(8)}  ` +
      `run:${(cumAll >= 0 ? '+' : '') + '$' + cumAll.toFixed(0).padStart(8)}  ${bar}`
    );
  }
  console.log(`\n  Green months: ${posMonths}  |  Red months: ${negMonths}`);

  // ── Stats ────────────────────────────────────────────────────────────────────
  console.log(`\n  STATS:`);
  console.log(`  Profitable coins:  ${winners.length} / ${results.length}  (${(winners.length / results.length * 100).toFixed(0)}%)`);
  console.log(`  Total P&L (all ${results.length} coins, 365 days):  ${totalAll >= 0 ? '+' : ''}$${totalAll.toFixed(0)}`);
  console.log(`  Winners only:      +$${totalWin.toFixed(0)}`);
  console.log(`  Avg per month:     ${avgPerMonth >= 0 ? '+' : ''}$${avgPerMonth.toFixed(0)}/month`);

  // ── Scale-up table ───────────────────────────────────────────────────────────
  console.log(`\n  SCALE-UP — all ${results.length} coins — avg monthly P&L:`);
  console.log(`  Trade$/pos   Monthly    Yearly`);
  for (const size of [100, 200, 500, 1000]) {
    const sc = size / TRADE_SIZE;
    const mo = avgPerMonth * sc;
    const yr = mo * 12;
    const flag = mo >= 1000 ? ' ✅' : mo >= 500 ? ' 🔸' : mo < 0 ? ' ❌' : '';
    console.log(
      `  $${String(size).padEnd(8)}   ${mo >= 0 ? '+' : ''}$${mo.toFixed(0).padStart(7)}/mo` +
      `  ${yr >= 0 ? '+' : ''}$${yr.toFixed(0).padStart(8)}/yr${flag}`
    );
  }

  console.log(`\n  SCALE-UP — top 10 winners only — avg monthly P&L:`);
  const top10Monthly = winners.slice(0, 10).reduce((s, r) => s + r.total, 0) / 12;
  for (const size of [100, 200, 500, 1000]) {
    const sc = size / TRADE_SIZE;
    const mo = top10Monthly * sc;
    const yr = mo * 12;
    const flag = mo >= 1000 ? ' ✅' : mo >= 500 ? ' 🔸' : mo < 0 ? ' ❌' : '';
    console.log(
      `  $${String(size).padEnd(8)}   ${mo >= 0 ? '+' : ''}$${mo.toFixed(0).padStart(7)}/mo` +
      `  ${yr >= 0 ? '+' : ''}$${yr.toFixed(0).padStart(8)}/yr${flag}`
    );
  }

  console.log(`\n${'═'.repeat(76)}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
