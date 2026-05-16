/**
 * RFRM Grid Strategy — Refined Backtest
 * Key improvements vs original:
 *   1. Anchor reset: if price drops X% below anchor, take loss + restart lower
 *   2. MAX_ACTIVE=4 so recovery trades can actually fire
 *   3. Grid search across cycle_gap × reset_threshold × symbol
 *
 * Usage:
 *   node grid-backtest.js          → BTC + ETH + SOL
 *   node grid-backtest.js BTCUSDT  → BTC only
 */

const axios = require('axios');
const http  = axios.create({ baseURL: 'https://api.bybit.com', timeout: 20_000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SYMBOLS = process.argv[2]
  ? [process.argv[2]]
  : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// Fixed params
const TRADE_SIZE   = 100;
const GRID_COUNT   = 3;
const MAX_RECOVERY = 2;
const MAX_ACTIVE   = 4;     // was 2 — raised so recovery can fire alongside grid
const FRACTAL_ON   = true;
const FRACTAL_SIZE = 25;
const FRACTAL_PCT  = 0.01;

// Grid search dimensions
const CYCLE_GAPS  = [0.015, 0.02, 0.025, 0.03];           // 1.5% 2% 2.5% 3%
const RESETS      = [null, 0.02, 0.03, 0.04, 0.05];       // null = no reset

// ── Bybit public kline (no auth) ──────────────────────────────────────────────
async function fetchKlines(symbol, days = 7) {
  const candles = [];
  const startMs = Date.now() - days * 24 * 3600 * 1000;
  let   curEnd  = Date.now();

  while (true) {
    const res  = await http.get('/v5/market/kline', {
      params: { category: 'linear', symbol, interval: '5', end: curEnd, limit: 200 },
    });
    const list = res.data.result?.list;
    if (!list?.length) break;

    let hitStart = false;
    for (const k of list) {
      const ts = parseInt(k[0]);
      if (ts < startMs) { hitStart = true; continue; }
      candles.push({
        ts, date: new Date(ts).toISOString().slice(0, 10),
        open:  parseFloat(k[1]), high: parseFloat(k[2]),
        low:   parseFloat(k[3]), close: parseFloat(k[4]),
      });
    }
    const oldestTs = parseInt(list[list.length - 1][0]);
    if (hitStart || oldestTs <= startMs) break;
    curEnd = oldestTs - 1;
    await sleep(150);
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

// ── EMA helper ────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

// ── Levels ────────────────────────────────────────────────────────────────────
function levels(anchor, mainGap, gridGap) {
  return {
    grid_0:    anchor,
    grid_1:    anchor * (1 + gridGap),
    grid_2:    anchor * (1 + gridGap * 2),
    cycle_end: anchor * (1 + mainGap),
    fractal:   anchor * (1 + FRACTAL_PCT),
  };
}

// ── Backtest core ─────────────────────────────────────────────────────────────
function backtest(candles, cycleGap, resetThreshold) {
  const mainGap = cycleGap;
  const gridGap = mainGap / GRID_COUNT;

  let active_anchor  = candles[0].close;
  let highest_anchor = active_anchor;
  let cycle_id = 0, reset_id = 0;

  // position: null or { qty, entry, tp, id }
  const pos = {};
  const initPos = () => {
    pos.ANCHOR = null; pos.GRID_1 = null; pos.GRID_2 = null; pos.FRACTAL = null;
    for (let r = 1; r <= MAX_RECOVERY; r++) pos[`RECOVERY_${r}`] = null;
  };
  initPos();

  const trades   = [];
  const dailyPnl = {};
  const closes   = candles.map(c => c.close);
  let   peak = 0, maxDD = 0, equity = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // ── 1. Check TP hits (candle.high crosses TP) ───────────────────────────
    for (const [id, p] of Object.entries(pos)) {
      if (!p) continue;
      if (c.high >= p.tp) {
        const pnl = (p.tp - p.entry) * p.qty;
        trades.push({ id, entry: p.entry, close: p.tp, pnl, date: c.date, outcome: 'TP' });
        if (!dailyPnl[c.date]) dailyPnl[c.date] = 0;
        dailyPnl[c.date] += pnl;
        equity += pnl;
        pos[id] = null;
      }
    }

    // ── 2. Anchor reset: if low drops X% below anchor → cut + restart ───────
    if (resetThreshold !== null) {
      const resetLevel = active_anchor * (1 - resetThreshold);
      if (c.low <= resetLevel) {
        const exitPrice = resetLevel;    // fill at reset trigger
        for (const [id, p] of Object.entries(pos)) {
          if (!p) continue;
          const pnl = (exitPrice - p.entry) * p.qty;
          trades.push({ id, entry: p.entry, close: exitPrice, pnl, date: c.date, outcome: 'RESET' });
          if (!dailyPnl[c.date]) dailyPnl[c.date] = 0;
          dailyPnl[c.date] += pnl;
          equity += pnl;
          pos[id] = null;
        }
        highest_anchor = active_anchor;
        active_anchor  = exitPrice;
        reset_id++;
      }
    }

    // ── 3. Cycle advance ────────────────────────────────────────────────────
    const target = active_anchor * (1 + mainGap);
    if (c.close >= target) {
      highest_anchor = active_anchor;
      active_anchor  = target;
      cycle_id++;
    }

    // ── 4. Drawdown tracking ────────────────────────────────────────────────
    if (equity > peak) peak = equity;
    if (equity - peak < maxDD) maxDD = equity - peak;

    // ── 5. Entry conditions ─────────────────────────────────────────────────
    const lvl   = levels(active_anchor, mainGap, gridGap);
    const count = Object.values(pos).filter(Boolean).length;
    if (count >= MAX_ACTIVE) continue;

    const price = c.close;
    const qty   = usd => usd / price;

    if (!pos.ANCHOR && price <= lvl.grid_0) {
      pos.ANCHOR = { qty: qty(TRADE_SIZE), entry: price, tp: lvl.grid_1 };

    } else if (!pos.GRID_1 && price >= lvl.grid_1 && price < lvl.grid_2) {
      pos.GRID_1 = { qty: qty(TRADE_SIZE), entry: price, tp: lvl.grid_2 };

    } else if (!pos.GRID_2 && price >= lvl.grid_2 && price < lvl.cycle_end) {
      pos.GRID_2 = { qty: qty(TRADE_SIZE), entry: price, tp: lvl.cycle_end };

    } else if (FRACTAL_ON && !pos.FRACTAL && price >= lvl.fractal && price < lvl.cycle_end) {
      pos.FRACTAL = { qty: qty(FRACTAL_SIZE), entry: price, tp: lvl.fractal * 1.01 };

    } else {
      for (let r = 1; r <= MAX_RECOVERY; r++) {
        const rId  = `RECOVERY_${r}`;
        const rLvl = highest_anchor * (1 - mainGap * r);
        if (!pos[rId] && price <= rLvl) {
          pos[rId] = { qty: qty(TRADE_SIZE), entry: price, tp: active_anchor };
          break;
        }
      }
    }
  }

  // ── Final: mark still-open positions ────────────────────────────────────────
  const lastPrice = candles[candles.length - 1].close;
  const openPos   = [];
  for (const [id, p] of Object.entries(pos)) {
    if (!p) continue;
    openPos.push({ id, entry: p.entry, tp: p.tp, qty: p.qty,
                   unrealized: (lastPrice - p.entry) * p.qty });
  }

  const tpTrades     = trades.filter(t => t.outcome === 'TP');
  const resetTrades  = trades.filter(t => t.outcome === 'RESET');
  const closedPnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const openPnl      = openPos.reduce((s, p) => s + p.unrealized, 0);

  return { trades, tpTrades, resetTrades, openPos, dailyPnl,
           closedPnl, openPnl, totalPnl: closedPnl + openPnl,
           cycle_id, reset_id, maxDD, lastPrice };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Fetch all symbols
  const allData = {};
  for (const sym of SYMBOLS) {
    process.stdout.write(`Fetching ${sym} 5-min (7 days)... `);
    const c = await fetchKlines(sym, 7);
    allData[sym] = c;
    const lo = Math.min(...c.map(x => x.low)).toFixed(0);
    const hi = Math.max(...c.map(x => x.high)).toFixed(0);
    console.log(`${c.length} candles  range: $${Number(lo).toLocaleString()}–$${Number(hi).toLocaleString()}  last: $${c[c.length-1].close.toLocaleString()}`);
    await sleep(300);
  }
  console.log();

  // Grid search
  let globalBest = null;

  for (const sym of SYMBOLS) {
    const candles = allData[sym];
    const move    = ((candles[candles.length-1].close / candles[0].close - 1) * 100).toFixed(1);
    console.log(`${'═'.repeat(78)}`);
    console.log(`  ${sym}  |  7-day move: ${Number(move) >= 0 ? '+' : ''}${move}%  |  ${candles.length} candles`);
    console.log(`${'═'.repeat(78)}`);
    console.log(`  CycleGap  Reset   Closed  Resets  TP_PnL     Open_PnL   Total     MaxDD`);
    console.log(`  ${'─'.repeat(73)}`);

    let symBest = null;
    for (const cg of CYCLE_GAPS) {
      for (const rt of RESETS) {
        const r    = backtest(candles, cg, rt);
        const flag = r.totalPnl > 0 ? ' ✅' : '';
        const rtLabel = rt === null ? '  OFF' : `${(rt*100).toFixed(0)}%  `;
        if (r.totalPnl > 0 && (!symBest || r.totalPnl > symBest.totalPnl))
          symBest = { ...r, sym, cg, rt };
        if (r.totalPnl > 0 && (!globalBest || r.totalPnl > globalBest.totalPnl))
          globalBest = { ...r, sym, cg, rt };

        console.log(
          `  ${(cg*100).toFixed(1)}%      ${rtLabel}` +
          `  ${String(r.tpTrades.length).padStart(6)}` +
          `  ${String(r.reset_id).padStart(6)}` +
          `  ${r.closedPnl >= 0 ? '+' : ''}$${r.closedPnl.toFixed(2).padStart(8)}` +
          `  ${r.openPnl   >= 0 ? '+' : ''}$${r.openPnl.toFixed(2).padStart(8)}` +
          `  ${r.totalPnl  >= 0 ? '+' : ''}$${r.totalPnl.toFixed(2).padStart(7)}` +
          `  -$${Math.abs(r.maxDD).toFixed(2).padStart(6)}${flag}`
        );
      }
    }

    // Symbol best detail
    if (symBest) {
      const b = symBest;
      console.log(`\n  ── ${sym} BEST: ${(b.cg*100).toFixed(1)}% cycle  reset@${b.rt ? (b.rt*100)+'%' : 'OFF'} ──`);
      console.log(`  TP trades: ${b.tpTrades.length}  Resets: ${b.reset_id}  Cycles: ${b.cycle_id}`);
      console.log(`  Closed P&L: +$${b.closedPnl.toFixed(2)}  Open P&L: ${b.openPnl>=0?'+':''}$${b.openPnl.toFixed(2)}  MaxDD: -$${Math.abs(b.maxDD).toFixed(2)}`);

      if (b.tpTrades.length || b.resetTrades.length) {
        console.log(`\n  Trade log:`);
        for (const t of b.trades) {
          const icon = t.outcome === 'TP' ? '✅' : '🔄';
          const pct  = ((t.close / t.entry - 1) * 100).toFixed(2);
          const pnlStr = (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2);
          console.log(`  ${t.date}  ${icon} ${t.outcome.padEnd(5)}  ${t.id.padEnd(12)}  @${t.entry.toFixed(2)} → ${t.close.toFixed(2)} (${pct}%)  ${pnlStr}`);
        }
      }

      const days = Object.keys(b.dailyPnl).sort();
      if (days.length) {
        console.log(`\n  Daily P&L:`);
        let run = 0;
        for (const d of days) {
          run += b.dailyPnl[d];
          const v   = b.dailyPnl[d];
          const bar = v >= 0
            ? '█'.repeat(Math.min(Math.round(v), 30))
            : '▒'.repeat(Math.min(Math.round(Math.abs(v)), 30));
          console.log(`  ${d}  ${(v>=0?'+':'') + '$' + v.toFixed(2).padStart(7)}  run:${run>=0?'+':''}$${run.toFixed(2).padStart(7)}  ${bar}`);
        }
      }

      if (b.openPos.length) {
        console.log(`\n  Open positions at $${b.lastPrice.toLocaleString()}:`);
        for (const p of b.openPos) {
          const needs = ((p.tp / b.lastPrice - 1) * 100).toFixed(2);
          const unr   = (p.unrealized >= 0 ? '+$' : '-$') + Math.abs(p.unrealized).toFixed(2);
          console.log(`  ${p.id.padEnd(12)} entry:$${p.entry.toFixed(2).padStart(9)}  tp:$${p.tp.toFixed(2).padStart(9)}  (needs +${needs}%)  unrealized:${unr}`);
        }
      }

      console.log(`\n  Scale-up (closed P&L × lot size):`);
      for (const size of [100, 500, 1000, 5000]) {
        const scale = size / TRADE_SIZE;
        const mp = b.closedPnl * scale * (52/1);   // ×52 weeks/year
        console.log(`  $${String(size).padEnd(5)}/trade  weekly:+$${(b.closedPnl*scale).toFixed(2).padStart(8)}  annual:+$${mp.toFixed(0).padStart(8)}`);
      }
    } else {
      console.log(`\n  No profitable config found for ${sym} this week.`);
    }
    console.log();
  }

  // Overall winner
  if (globalBest) {
    const b = globalBest;
    console.log('═'.repeat(78));
    console.log(`  OVERALL BEST: ${b.sym}  ${(b.cg*100).toFixed(1)}% cycle  reset@${b.rt ? (b.rt*100)+'%' : 'OFF'}`);
    console.log(`  Closed: +$${b.closedPnl.toFixed(2)}  Open: ${b.openPnl>=0?'+':''}$${b.openPnl.toFixed(2)}  Total: +$${b.totalPnl.toFixed(2)}  MaxDD: -$${Math.abs(b.maxDD).toFixed(2)}`);
    console.log(`\n  → Update grid-bot.js with:`);
    console.log(`    GRID_SYMBOL=${b.sym}`);
    console.log(`    GRID_CYCLE_GAP=${(b.cg*100).toFixed(1)}`);
    console.log(`    GRID_MAX_ACTIVE=4`);
    if (b.rt) console.log(`    GRID_RESET=${(b.rt*100).toFixed(0)}    (add this env var to bot)`);
    console.log('═'.repeat(78));
  } else {
    console.log('No profitable config found across any symbol/config this week.');
    console.log('Market was strongly trending down — grid strategies struggle in sustained trends.');
  }
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
