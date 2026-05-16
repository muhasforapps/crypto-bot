/**
 * Altcoin Pump Grid Backtest
 * 1. Scan all Bybit linear perps — find top movers (volume + price change)
 * 2. Fetch 15min candles (7 days) for each pumping coin
 * 3. Run bidirectional EMA20/50 grid:
 *    - EMA20 > EMA50 → LONG grid (ride pump)
 *    - EMA20 < EMA50 → SHORT grid (ride dump)
 *    - Mode switch → close all at current price, flip, new anchor
 * 4. Report per-coin P&L, top winners, total
 */

const axios = require('axios');

const TRADE_SIZE    = 200;    // $200 per grid position
const MAX_ACTIVE    = 4;      // max concurrent positions per coin
const CYCLE_GAP     = 0.02;   // 2% full cycle (3 levels × 0.67%)
const TP_PCT        = CYCLE_GAP / 3;   // 0.67% TP per position
const GRID_STEP     = 0.005;  // min 0.5% gap between entries
const EMA_FAST      = 20;
const EMA_SLOW      = 50;
const INTERVAL      = '15';   // 15-min candles
const DAYS          = 30;
const MIN_VOL_USD   = 30_000_000;  // $30M 24H turnover minimum
const MIN_CHANGE    = 2;           // ±2% 24H move minimum
const TOP_N         = 40;          // scan top 40 movers

// ── Trend-strength filters ────────────────────────────────────────────────────
const MIN_EMA_SEP   = 0.004;  // EMA20 must be >0.4% away from EMA50 to open a position
const SWITCH_COOL   = 16;     // candles to wait after a mode switch before switching again (16×15min = 4H)
const MIN_TREND_PCT = 0.55;   // skip coin if EMA is clearly separated <55% of the time (too choppy)

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result = new Array(period).fill(seed);
  let ema = seed;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchTickers() {
  const res = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 10000 });
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
  const totalNeeded = DAYS * 24 * 4;   // 30d × 24h × 4 per hour = 2880 candles
  const perPage     = 1000;
  const pages       = Math.ceil(totalNeeded / perPage);
  let   all         = [];
  let   end         = undefined;        // no end = fetch most recent page first

  for (let p = 0; p < pages; p++) {
    const url = `https://api.bybit.com/v5/market/kline?category=linear` +
      `&symbol=${symbol}&interval=${INTERVAL}&limit=${perPage}` +
      (end ? `&end=${end}` : '');
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data.retCode !== 0) break;
    const page = res.data.result.list
      .map(c => ({ ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4] }));
    if (!page.length) break;
    all = all.concat(page);
    end = Math.min(...page.map(c => c.ts)) - 1;   // go back before oldest candle
    await sleep(120);
  }

  // Sort ascending, deduplicate
  all.sort((a, b) => a.ts - b.ts);
  const seen = new Set();
  return all.filter(c => { if (seen.has(c.ts)) return false; seen.add(c.ts); return true; });
}

// ── Grid simulation ───────────────────────────────────────────────────────────

function runGrid(candles, symbol) {
  if (candles.length < EMA_SLOW + 20) return null;

  const closes = candles.map(c => c.close);
  const ema20  = calcEMA(closes, EMA_FAST);
  const ema50  = calcEMA(closes, EMA_SLOW);

  // ── Pre-filter: skip coin if EMA separation is weak most of the time ──────
  let trendCount = 0;
  for (let i = EMA_SLOW; i < candles.length; i++) {
    if (Math.abs(ema20[i] - ema50[i]) / ema50[i] >= MIN_EMA_SEP) trendCount++;
  }
  const trendPct = trendCount / (candles.length - EMA_SLOW);
  if (trendPct < MIN_TREND_PCT) return { symbol, skipped: true, trendPct };

  let mode        = null;
  let positions   = [];   // { entry, mode }
  let trades      = [];
  let closedPnl   = 0;
  let peak        = 0;
  let runPnl      = 0;
  let maxDD       = 0;
  let switches    = 0;
  let lastSwitch  = -SWITCH_COOL;  // candle index of last mode switch

  const dailyPnl = {};

  for (let i = EMA_SLOW + 1; i < candles.length; i++) {
    const c       = candles[i];
    const newMode = ema20[i] > ema50[i] ? 'long' : 'short';
    const date    = new Date(c.ts).toISOString().slice(0, 10);
    const emaSep  = Math.abs(ema20[i] - ema50[i]) / ema50[i];

    // ── Mode switch: only if cooldown passed ──────────────────────────────
    if (mode && newMode !== mode && (i - lastSwitch) >= SWITCH_COOL) {
      for (const pos of positions) {
        const pnl = pos.mode === 'long'
          ? (c.close - pos.entry) / pos.entry * TRADE_SIZE
          : (pos.entry - c.close) / pos.entry * TRADE_SIZE;
        trades.push({ type: 'switch', pnl, date });
        closedPnl += pnl;
        runPnl    += pnl;
        if (!dailyPnl[date]) dailyPnl[date] = 0;
        dailyPnl[date] += pnl;
      }
      positions  = [];
      lastSwitch = i;
      switches++;
    }
    mode = newMode;

    // ── Check TPs ─────────────────────────────────────────────────────────
    for (let pi = positions.length - 1; pi >= 0; pi--) {
      const pos = positions[pi];
      let pnl = null, exitPrice;

      if (pos.mode === 'long') {
        exitPrice = pos.entry * (1 + TP_PCT);
        if (c.high >= exitPrice) pnl = (exitPrice - pos.entry) / pos.entry * TRADE_SIZE;
      } else {
        exitPrice = pos.entry * (1 - TP_PCT);
        if (c.low <= exitPrice)  pnl = (pos.entry - exitPrice) / pos.entry * TRADE_SIZE;
      }

      if (pnl !== null) {
        trades.push({ type: 'tp', pnl, date });
        closedPnl += pnl;
        runPnl    += pnl;
        if (!dailyPnl[date]) dailyPnl[date] = 0;
        dailyPnl[date] += pnl;
        positions.splice(pi, 1);
      }
    }

    // ── Track equity peak / drawdown ──────────────────────────────────────
    if (runPnl > peak) peak = runPnl;
    const dd = runPnl - peak;
    if (dd < maxDD) maxDD = dd;

    // ── Open new position only when trend is strong enough ────────────────
    if (positions.length < MAX_ACTIVE && emaSep >= MIN_EMA_SEP) {
      const lastEntry = positions.length > 0 ? positions[positions.length - 1].entry : null;
      const dist = lastEntry ? Math.abs(c.close - lastEntry) / lastEntry : 1;
      if (dist >= GRID_STEP) {
        positions.push({ entry: c.close, mode });
      }
    }
  }

  // ── Unrealized P&L on open positions ─────────────────────────────────────
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
    maxDD, switches, dailyPnl,
    openCount: positions.length,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nScanning Bybit for pumping coins...\n');
  const tickers = await fetchTickers();

  if (!tickers.length) { console.log('No qualifying coins found.'); return; }

  console.log(`Found ${tickers.length} coins  (>$30M vol  |  >±2% move  |  top ${TOP_N})\n`);
  console.log('  Symbol         24H%     Volume');
  console.log('  ─────────────────────────────────────');
  for (const t of tickers) {
    console.log(
      `  ${t.symbol.padEnd(14)} ${(t.change24h >= 0 ? '+' : '') + t.change24h.toFixed(1).padStart(6)}%` +
      `  $${(t.vol24h / 1e6).toFixed(0)}M`
    );
  }

  console.log('\nFetching 15min candles & running EMA grid...\n');
  console.log('  Symbol         Mode   Trades  WR%   ClosedP&L   OpenP&L    Total');
  console.log('  ──────────────────────────────────────────────────────────────────');

  const results = [];

  for (const t of tickers) {
    await sleep(150);
    try {
      const candles = await fetchKlines(t.symbol);
      if (candles.length < EMA_SLOW + 20) {
        console.log(`  ${t.symbol.padEnd(14)} — not enough data`);
        continue;
      }
      const r = runGrid(candles, t.symbol);
      if (!r) continue;

      if (r.skipped) {
        console.log(`  ${r.symbol.padEnd(14)} SKIP  (choppy — trend only ${(r.trendPct*100).toFixed(0)}% of time)`);
        continue;
      }
      results.push({ ...r, change24h: t.change24h });
      const flag = r.total > 5 ? ' ✅' : r.total < -5 ? ' ❌' : '  ';
      console.log(
        `  ${r.symbol.padEnd(14)} ${(r.mode ?? '?').padEnd(6)} ` +
        `${String(r.n).padStart(5)}tr  ` +
        `${(r.wr + '%').padStart(5)}  ` +
        `${r.closedPnl >= 0 ? '+' : ''}$${r.closedPnl.toFixed(1).padStart(7)}  ` +
        `${r.openPnl >= 0 ? '+' : ''}$${r.openPnl.toFixed(1).padStart(7)}  ` +
        `${r.total >= 0 ? '+' : ''}$${r.total.toFixed(1).padStart(7)}${flag}`
      );
    } catch (e) {
      console.log(`  ${t.symbol.padEnd(14)} ERR: ${e.message}`);
    }
  }

  if (!results.length) { console.log('\nNo results.'); return; }

  results.sort((a, b) => b.total - a.total);

  const winners   = results.filter(r => r.total > 0);
  const losers    = results.filter(r => r.total <= 0);
  const totalAll  = results.reduce((s, r) => s + r.total, 0);
  const totalWin  = winners.reduce((s, r) => s + r.total, 0);
  // DAYS is the test window — treat as the monthly result directly
  const monthlyAll = totalAll;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SUMMARY — ${results.length} coins — ${DAYS} days — 15min — EMA${EMA_FAST}/${EMA_SLOW} grid — $${TRADE_SIZE}/trade`);
  console.log(`${'═'.repeat(70)}`);

  console.log(`\n  TOP WINNERS:`);
  console.log(`  Symbol         Mode   Trades  WR%    Total    MaxDD   Bar`);
  console.log(`  ──────────────────────────────────────────────────────────`);
  for (const r of winners.slice(0, 15)) {
    const bar = '█'.repeat(Math.min(Math.round(r.total / 3), 20));
    console.log(
      `  ${r.symbol.padEnd(14)} ${(r.mode ?? '?').padEnd(6)} ` +
      `${String(r.n).padStart(4)}tr  ` +
      `${(r.wr + '%').padStart(5)}  ` +
      `+$${r.total.toFixed(1).padStart(6)}  ` +
      `-$${Math.abs(r.maxDD).toFixed(1).padStart(5)}  ${bar}`
    );
  }

  if (losers.length) {
    console.log(`\n  LOSERS (${losers.length}):`);
    for (const r of losers.slice(0, 5)) {
      console.log(
        `  ${r.symbol.padEnd(14)} ${(r.mode ?? '?').padEnd(6)} ` +
        `${String(r.n).padStart(4)}tr  WR:${r.wr}%  -$${Math.abs(r.total).toFixed(1)}`
      );
    }
  }

  // Best coin daily breakdown
  const best = results[0];
  if (best) {
    console.log(`\n  BEST COIN — ${best.symbol} — daily P&L (${DAYS} days):`);
    let cum = 0;
    for (const [d, v] of Object.entries(best.dailyPnl).sort()) {
      cum += v;
      const bar = v > 0
        ? '█'.repeat(Math.min(Math.round(v / 2), 25))
        : '▒'.repeat(Math.min(Math.round(Math.abs(v) / 2), 25));
      console.log(
        `  ${d}  ${v >= 0 ? '+' : ''}$${v.toFixed(1).padStart(7)}` +
        `  run:${cum >= 0 ? '+' : ''}$${cum.toFixed(1).padStart(8)}  ${bar}`
      );
    }
  }

  console.log(`\n  STATS:`);
  console.log(`  Profitable coins:  ${winners.length} / ${results.length}  (${(winners.length / results.length * 100).toFixed(0)}%)`);
  console.log(`  Total P&L (all ${results.length} coins, $${TRADE_SIZE}/trade, ${DAYS} days):  ${totalAll >= 0 ? '+' : ''}$${totalAll.toFixed(2)}`);
  console.log(`  Winners P&L only:  +$${totalWin.toFixed(2)}`);

  console.log(`\n  SCALE-UP — all ${results.length} coins — ${DAYS} days ≈ 1 month:`);
  console.log(`  Trade$/pos   Monthly P&L`);
  for (const size of [100, 200, 500, 1000]) {
    const sc  = size / TRADE_SIZE;
    const mo  = monthlyAll * sc;
    const flag = mo >= 1000 ? ' ✅' : mo >= 500 ? ' 🔸' : mo < 0 ? ' ❌' : '';
    console.log(`  $${String(size).padEnd(8)}   ${mo >= 0 ? '+' : ''}$${mo.toFixed(0)}${flag}`);
  }

  console.log(`\n  SCALE-UP — top 10 winners only — ${DAYS} days:`);
  const monthlyTop = winners.slice(0, 10).reduce((s, r) => s + r.total, 0);
  for (const size of [100, 200, 500, 1000]) {
    const sc  = size / TRADE_SIZE;
    const mo  = monthlyTop * sc;
    const flag = mo >= 1000 ? ' ✅' : mo >= 500 ? ' 🔸' : mo < 0 ? ' ❌' : '';
    console.log(`  $${String(size).padEnd(8)}   ${mo >= 0 ? '+' : ''}$${mo.toFixed(0)}${flag}`);
  }

  console.log(`\n${'═'.repeat(70)}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
