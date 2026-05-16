/**
 * Combined Backtest — 7 days, 5-min candles
 *
 * PATH 1: Bidirectional Crypto Grid (EMA crossover)
 *   — LONG grid when EMA20 > EMA50 (uptrend)
 *   — SHORT grid when EMA20 < EMA50 (downtrend)
 *   — Mode switch: close all positions, reset anchor, flip direction
 *   Data: Bybit public API (BTCUSDT, ETHUSDT, SOLUSDT)
 *
 * PATH 2: Forex Asian RSI Sweep
 *   — Liquidity sweep on 5min + RSI(14) filter
 *   — Session: 00:00–07:00 UTC, 4 pairs
 *   Data: Yahoo Finance
 */

const axios = require('axios');
const yf    = require('yahoo-finance2');
const yfc   = new yf.default();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Shared helpers ────────────────────────────────────────────────────────────
function calcEMAseries(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function calcRSIseries(closes, period = 14) {
  const out = new Array(closes.length).fill(50);
  if (closes.length < period + 2) return out;
  for (let i = period; i < closes.length; i++) {
    const slice = closes.slice(i - period, i + 1);
    let g = 0, l = 0;
    for (let j = 1; j < slice.length; j++) {
      const d = slice[j] - slice[j-1];
      if (d > 0) g += d; else l -= d;
    }
    const ag = g / period, al = l / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function calcATRseries(candles, period = 14) {
  const out = new Array(candles.length).fill(0);
  for (let i = period; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += Math.max(
        candles[j].high - candles[j].low,
        Math.abs(candles[j].high - candles[j-1].close),
        Math.abs(candles[j].low  - candles[j-1].close),
      );
    }
    out[i] = sum / period;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// PATH 1 — BIDIRECTIONAL CRYPTO GRID
// ══════════════════════════════════════════════════════════════════════════════

const BYBIT = axios.create({ baseURL: 'https://api.bybit.com', timeout: 20_000 });

async function fetchBybit(symbol, days = 7) {
  const candles = [], startMs = Date.now() - days * 24 * 3600 * 1000;
  let curEnd = Date.now();
  while (true) {
    const res  = await BYBIT.get('/v5/market/kline', {
      params: { category: 'linear', symbol, interval: '5', end: curEnd, limit: 200 },
    });
    const list = res.data.result?.list;
    if (!list?.length) break;
    let hitStart = false;
    for (const k of list) {
      const ts = parseInt(k[0]);
      if (ts < startMs) { hitStart = true; continue; }
      candles.push({ ts, date: new Date(ts).toISOString().slice(0,10),
        open: parseFloat(k[1]), high: parseFloat(k[2]),
        low:  parseFloat(k[3]), close: parseFloat(k[4]) });
    }
    const oldest = parseInt(list[list.length - 1][0]);
    if (hitStart || oldest <= startMs) break;
    curEnd = oldest - 1;
    await sleep(150);
  }
  return candles.sort((a, b) => a.ts - b.ts);
}

function gridBacktest(candles, cycleGap = 0.02, emaFast = 20, emaSlow = 50, maxActive = 4) {
  const mainGap = cycleGap;
  const gridGap = mainGap / 3;
  const TRADE   = 100;

  const closes   = candles.map(c => c.close);
  const ema20s   = calcEMAseries(closes, emaFast);
  const ema50s   = calcEMAseries(closes, emaSlow);
  const warmup   = emaSlow;

  let mode = null, anchor = null, highAnchor = null;
  const pos = { ANCHOR: null, GRID_1: null, GRID_2: null };

  const trades = [], dailyPnl = {};
  let equity = 0, peak = 0, maxDD = 0;

  for (let i = warmup; i < candles.length; i++) {
    const c    = candles[i];
    const fast = ema20s[i], slow = ema50s[i];
    if (fast == null || slow == null) continue;
    const newMode = fast > slow ? 'long' : 'short';

    // ── Mode switch ─────────────────────────────────────────────────────────
    if (newMode !== mode) {
      if (mode !== null) {
        for (const [id, p] of Object.entries(pos)) {
          if (!p) continue;
          const pnl = mode === 'long'
            ? (c.close - p.entry) * p.qty
            : (p.entry - c.close) * p.qty;
          trades.push({ id, entry: p.entry, close: c.close, pnl, date: c.date, outcome: 'SWITCH' });
          if (!dailyPnl[c.date]) dailyPnl[c.date] = 0;
          dailyPnl[c.date] += pnl;
          equity += pnl;
          pos[id] = null;
        }
      }
      mode = newMode; anchor = c.close; highAnchor = c.close;
    }

    // ── TP checks ───────────────────────────────────────────────────────────
    for (const [id, p] of Object.entries(pos)) {
      if (!p) continue;
      const hit = mode === 'long' ? c.high >= p.tp : c.low <= p.tp;
      if (hit) {
        const pnl = mode === 'long'
          ? (p.tp - p.entry) * p.qty
          : (p.entry - p.tp) * p.qty;
        trades.push({ id, entry: p.entry, close: p.tp, pnl, date: c.date, outcome: 'TP' });
        if (!dailyPnl[c.date]) dailyPnl[c.date] = 0;
        dailyPnl[c.date] += pnl;
        equity += pnl;
        pos[id] = null;
      }
    }

    // ── Cycle advance ───────────────────────────────────────────────────────
    if (mode === 'long'  && c.close >= anchor * (1 + mainGap)) { highAnchor = anchor; anchor = anchor * (1 + mainGap); }
    if (mode === 'short' && c.close <= anchor * (1 - mainGap)) { highAnchor = anchor; anchor = anchor * (1 - mainGap); }

    // ── Drawdown ────────────────────────────────────────────────────────────
    if (equity > peak) peak = equity;
    if (equity - peak < maxDD) maxDD = equity - peak;

    // ── Entries ─────────────────────────────────────────────────────────────
    const count = Object.values(pos).filter(Boolean).length;
    if (count >= maxActive) continue;
    const price = c.close, qty = usd => usd / price;

    if (mode === 'long') {
      const g0 = anchor, g1 = anchor * (1 + gridGap), g2 = anchor * (1 + gridGap * 2), end = anchor * (1 + mainGap);
      if      (!pos.ANCHOR && price <= g0)                  pos.ANCHOR = { qty: qty(TRADE), entry: price, tp: g1 };
      else if (!pos.GRID_1 && price >= g1 && price < g2)    pos.GRID_1 = { qty: qty(TRADE), entry: price, tp: g2 };
      else if (!pos.GRID_2 && price >= g2 && price < end)   pos.GRID_2 = { qty: qty(TRADE), entry: price, tp: end };
    } else {
      const g0 = anchor, g1 = anchor * (1 - gridGap), g2 = anchor * (1 - gridGap * 2), end = anchor * (1 - mainGap);
      if      (!pos.ANCHOR && price >= g0)                  pos.ANCHOR = { qty: qty(TRADE), entry: price, tp: g1 };
      else if (!pos.GRID_1 && price <= g1 && price > g2)    pos.GRID_1 = { qty: qty(TRADE), entry: price, tp: g2 };
      else if (!pos.GRID_2 && price <= g2 && price > end)   pos.GRID_2 = { qty: qty(TRADE), entry: price, tp: end };
    }
  }

  // ── Open positions at end ────────────────────────────────────────────────
  const last = candles[candles.length - 1].close;
  const openPos = [];
  for (const [id, p] of Object.entries(pos)) {
    if (!p) continue;
    const unr = mode === 'long' ? (last - p.entry) * p.qty : (p.entry - last) * p.qty;
    openPos.push({ id, entry: p.entry, tp: p.tp, unr, mode });
  }

  const tpTrades     = trades.filter(t => t.outcome === 'TP');
  const switchTrades = trades.filter(t => t.outcome === 'SWITCH');
  const closedPnl    = trades.reduce((s, t) => s + t.pnl, 0);
  const openPnl      = openPos.reduce((s, p) => s + p.unr, 0);
  const switches     = switchTrades.length;

  return { trades, tpTrades, switchTrades, openPos, dailyPnl,
           closedPnl, openPnl, total: closedPnl + openPnl,
           maxDD, switches, mode };
}

// ══════════════════════════════════════════════════════════════════════════════
// PATH 2 — FOREX ASIAN RSI SWEEP
// ══════════════════════════════════════════════════════════════════════════════

const FOREX_PAIRS = [
  { symbol: 'GBPJPY=X', name: 'GBP/JPY', jpy: true },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', jpy: false },
  { symbol: 'EURGBP=X', name: 'EUR/GBP', jpy: false },
  { symbol: 'NZDUSD=X', name: 'NZD/USD', jpy: false },
];
const FX_LOT      = 0.1;
const FX_LOOKBACK = 48;
const FX_SWEEP    = 0.15;
const FX_RSI_OB   = 55;
const FX_RSI_OS   = 45;
const FX_TP       = 25;
const FX_SL       = 10;
const FX_COOLDOWN = 6;
const FX_MAX_DAY  = 30;

async function fetchYahoo(symbol, days = 7) {
  const period1 = new Date(Date.now() - days * 24 * 3600 * 1000);
  const result  = await yfc.chart(symbol, { interval: '5m', period1 }, { validateResult: false });
  return result.quotes
    .filter(q => q.open && q.high && q.low && q.close)
    .map(q => ({ ts: q.date ? new Date(q.date).getTime() : 0,
                 date: q.date ? new Date(q.date).toISOString().slice(0,10) : '',
                 open: q.open, high: q.high, low: q.low, close: q.close }));
}

function fxToDist(usd, price, jpy) {
  if (jpy) return usd / (FX_LOT * 100000 / price);
  return usd / (FX_LOT * 100000);
}

function forexBacktest(pairData) {
  const maxLen    = Math.max(...pairData.map(p => p.candles.length));
  const cooldown  = {};
  const trades    = [], dailyPnl = {};
  let   dayTrades = 0, currentDate = null;
  let   equity = 0, peak = 0, maxDD = 0;
  const startIdx  = FX_LOOKBACK + 16;

  for (let i = startIdx; i < maxLen - 24 - 1; i++) {
    const refTs   = pairData[0].candles[i]?.ts;
    const dateStr = refTs ? new Date(refTs).toISOString().slice(0,10) : String(i);
    if (dateStr !== currentDate) { currentDate = dateStr; dayTrades = 0; }
    if (dayTrades >= FX_MAX_DAY) continue;

    for (const { pair, candles, closes, rsis, atrs } of pairData) {
      if (i >= candles.length - 24 - 1) continue;
      const ts = candles[i]?.ts ?? 0;
      if (!ts) continue;
      const h = new Date(ts).getUTCHours();
      if (h < 0 || h >= 7) continue;

      const last = cooldown[pair.name] ?? -FX_COOLDOWN;
      if (i - last < FX_COOLDOWN) continue;

      const c       = candles[i];
      const rsi     = rsis[i];
      const atr     = atrs[i];
      const swSlice = candles.slice(Math.max(0, i - FX_LOOKBACK), i);
      const swingHi = Math.max(...swSlice.map(x => x.high));
      const swingLo = Math.min(...swSlice.map(x => x.low));

      let sig = null;
      if (c.high > swingHi + atr * FX_SWEEP && c.close < swingHi && rsi > FX_RSI_OB) {
        sig = { dir: 'SHORT', tp: c.close - fxToDist(FX_TP, c.close, pair.jpy),
                               sl: c.close + fxToDist(FX_SL, c.close, pair.jpy) };
      } else if (c.low < swingLo - atr * FX_SWEEP && c.close > swingLo && rsi < FX_RSI_OS) {
        sig = { dir: 'LONG',  tp: c.close + fxToDist(FX_TP, c.close, pair.jpy),
                               sl: c.close - fxToDist(FX_SL, c.close, pair.jpy) };
      }
      if (!sig) continue;

      let pnl = 0, outcome = 'TO';
      for (let j = i+1; j <= i+24 && j < candles.length; j++) {
        const cx = candles[j];
        if (sig.dir === 'SHORT') {
          if (cx.high >= sig.sl) { outcome = 'SL'; pnl = -FX_SL; break; }
          if (cx.low  <= sig.tp) { outcome = 'TP'; pnl = +FX_TP; break; }
        } else {
          if (cx.low  <= sig.sl) { outcome = 'SL'; pnl = -FX_SL; break; }
          if (cx.high >= sig.tp) { outcome = 'TP'; pnl = +FX_TP; break; }
        }
      }
      if (outcome === 'TO') {
        const ex   = candles[Math.min(i + 24, candles.length - 1)];
        const diff = sig.dir === 'SHORT' ? c.close - ex.close : ex.close - c.close;
        pnl = pair.jpy ? diff * FX_LOT * 100000 / ex.close : diff * FX_LOT * 100000;
        pnl = Math.max(-FX_SL, Math.min(FX_TP, pnl));
      }

      trades.push({ pair: pair.name, dir: sig.dir, outcome, pnl, date: dateStr });
      if (!dailyPnl[dateStr]) dailyPnl[dateStr] = 0;
      dailyPnl[dateStr] += pnl;
      equity += pnl;
      if (equity > peak) peak = equity;
      if (equity - peak < maxDD) maxDD = equity - peak;
      cooldown[pair.name] = i;
      dayTrades++;
      if (dayTrades >= FX_MAX_DAY) break;
    }
  }

  const wins     = trades.filter(t => t.pnl > 0).length;
  const total    = trades.reduce((s, t) => s + t.pnl, 0);
  return { trades, dailyPnl, total, wins, n: trades.length,
           wr: trades.length ? (wins/trades.length*100).toFixed(1) : '0',
           maxDD };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n  Fetching data...\n');

  // ── Crypto data ──────────────────────────────────────────────────────────
  const CRYPTO_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const cryptoData = {};
  for (const sym of CRYPTO_SYMBOLS) {
    process.stdout.write(`  Bybit ${sym}... `);
    cryptoData[sym] = await fetchBybit(sym, 7);
    const c = cryptoData[sym];
    const mv = ((c[c.length-1].close / c[0].close - 1)*100).toFixed(1);
    console.log(`${c.length} candles  move: ${Number(mv)>=0?'+':''}${mv}%  last: $${c[c.length-1].close.toLocaleString()}`);
    await sleep(300);
  }

  // ── Forex data ───────────────────────────────────────────────────────────
  console.log();
  const pairData = [];
  for (const pair of FOREX_PAIRS) {
    process.stdout.write(`  Yahoo  ${pair.name}... `);
    try {
      const candles = await fetchYahoo(pair.symbol, 7);
      const closes  = candles.map(c => c.close);
      const rsis    = calcRSIseries(closes);
      const atrs    = calcATRseries(candles);
      pairData.push({ pair, candles, closes, rsis, atrs });
      console.log(`${candles.length} candles`);
    } catch (e) { console.log(`ERROR: ${e.message}`); }
    await sleep(800);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PATH 1: Bidirectional Crypto Grid
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(78));
  console.log('  PATH 1 — BIDIRECTIONAL CRYPTO GRID (EMA20/50 crossover, 2% cycle)');
  console.log('  Long when EMA20>EMA50 | Short when EMA20<EMA50 | Switch = close all + reset');
  console.log('═'.repeat(78));
  console.log('  Symbol   Mode@end  Switches  TP trades  ClosedPnL   OpenPnL   Total     MaxDD');
  console.log('  ' + '─'.repeat(73));

  let bestGrid = null;
  const gridResults = {};
  for (const sym of CRYPTO_SYMBOLS) {
    const r = gridBacktest(cryptoData[sym], 0.02, 20, 50, 4);
    gridResults[sym] = r;
    const flag = r.total > 0 ? ' ✅' : '';
    if (r.total > 0 && (!bestGrid || r.total > bestGrid.total)) bestGrid = { ...r, sym };
    console.log(
      `  ${sym.padEnd(9)}${r.mode?.padEnd(7) || '?'.padEnd(7)}` +
      `  ${String(r.switches).padStart(8)}` +
      `  ${String(r.tpTrades.length).padStart(9)}` +
      `  ${r.closedPnl>=0?'+':''}$${r.closedPnl.toFixed(2).padStart(8)}` +
      `  ${r.openPnl  >=0?'+':''}$${r.openPnl.toFixed(2).padStart(7)}` +
      `  ${r.total    >=0?'+':''}$${r.total.toFixed(2).padStart(7)}` +
      `  -$${Math.abs(r.maxDD).toFixed(2).padStart(6)}${flag}`
    );
  }

  // Best grid detail
  const bg = bestGrid || gridResults[CRYPTO_SYMBOLS[0]];
  if (bg) {
    console.log(`\n  Detail — ${bg.sym || CRYPTO_SYMBOLS[0]}:`);
    const days1 = Object.keys(bg.dailyPnl).sort();
    if (days1.length) {
      let run = 0;
      console.log('  Day          PnL        Run      Trades  Bar');
      for (const d of days1) {
        run += bg.dailyPnl[d];
        const v   = bg.dailyPnl[d];
        const cnt = bg.trades.filter(t => t.date === d).length;
        const bar = v >= 0
          ? '█'.repeat(Math.min(Math.round(Math.abs(v)), 25))
          : '▒'.repeat(Math.min(Math.round(Math.abs(v)), 25));
        console.log(`  ${d}  ${(v>=0?'+':'') + '$'+v.toFixed(2).padStart(7)}  ${run>=0?'+':''}$${run.toFixed(2).padStart(7)}  ${String(cnt).padStart(5)}tr  ${bar}`);
      }
    }
    if (bg.openPos.length) {
      console.log(`\n  Open @ $${cryptoData[bg.sym || CRYPTO_SYMBOLS[0]][cryptoData[bg.sym || CRYPTO_SYMBOLS[0]].length-1].close.toLocaleString()}:`);
      for (const p of bg.openPos) {
        const pnlStr = (p.unr>=0?'+$':'-$') + Math.abs(p.unr).toFixed(2);
        console.log(`  ${p.mode.toUpperCase()} ${p.id.padEnd(8)} entry:${p.entry.toFixed(2).padStart(10)}  tp:${p.tp.toFixed(2).padStart(10)}  unrealized:${pnlStr}`);
      }
    }

    console.log('\n  Scale-up (grid, closed P&L):');
    for (const size of [100, 500, 1000]) {
      const scale = size / 100;
      console.log(`  $${String(size).padEnd(5)}/trade  weekly:${bg.closedPnl*scale>=0?'+':''}$${(bg.closedPnl*scale).toFixed(2)}  monthly est:${(bg.closedPnl*scale*4)>=0?'+':''}$${(bg.closedPnl*scale*4).toFixed(2)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PATH 2: Forex RSI Sweep
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(78));
  console.log('  PATH 2 — FOREX ASIAN RSI SWEEP (5min, 00-07 UTC, $25 TP / $10 SL)');
  console.log('  Pairs: GBP/JPY  GBP/USD  EUR/GBP  NZD/USD  |  RSI>55 SHORT  RSI<45 LONG');
  console.log('═'.repeat(78));

  const fx = forexBacktest(pairData);

  console.log(`  Trades: ${fx.n}  WR: ${fx.wr}%  Total: ${fx.total>=0?'+':''}$${fx.total.toFixed(2)}  MaxDD: -$${Math.abs(fx.maxDD).toFixed(2)}\n`);

  // Per pair
  const byPair = {};
  for (const t of fx.trades) {
    if (!byPair[t.pair]) byPair[t.pair] = { n:0, wins:0, pnl:0 };
    byPair[t.pair].n++; byPair[t.pair].pnl += t.pnl;
    if (t.pnl > 0) byPair[t.pair].wins++;
  }
  console.log('  By pair:');
  for (const [p, v] of Object.entries(byPair).sort((a,b)=>b[1].pnl-a[1].pnl)) {
    console.log(`  ${p.padEnd(10)} ${String(v.n).padStart(3)}tr  WR:${(v.wins/v.n*100).toFixed(0).padStart(3)}%  P&L:${v.pnl>=0?'+':''}$${v.pnl.toFixed(2)}`);
  }

  // Daily
  const fxDays = Object.keys(fx.dailyPnl).sort();
  if (fxDays.length) {
    console.log('\n  Daily P&L:');
    let run = 0;
    for (const d of fxDays) {
      run += fx.dailyPnl[d];
      const v   = fx.dailyPnl[d];
      const cnt = fx.trades.filter(t => t.date === d).length;
      const bar = v >= 0
        ? '█'.repeat(Math.min(Math.round(v), 25))
        : '▒'.repeat(Math.min(Math.round(Math.abs(v)), 25));
      console.log(`  ${d}  ${(v>=0?'+':'') + '$'+v.toFixed(2).padStart(7)}  run:${run>=0?'+':''}$${run.toFixed(2).padStart(7)}  ${String(cnt).padStart(3)}tr  ${bar}`);
    }
  }

  console.log('\n  Scale-up (forex, closed P&L only):');
  for (const [lot, label] of [[0.1,'(backtest lot)'],[0.3,''],[0.5,''],[1.0,'']]) {
    const scale  = lot / FX_LOT;
    const weekly = fx.total * scale;
    const monthly = weekly * 4;
    const flag = monthly >= 500 ? ' ✅' : monthly >= 200 ? ' 🔸' : '';
    console.log(`  ${lot.toFixed(1)} lot ${label.padEnd(15)} weekly:${weekly>=0?'+':''}$${weekly.toFixed(2).padStart(8)}  monthly:${monthly>=0?'+':''}$${monthly.toFixed(2).padStart(9)}${flag}`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPARISON
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(78));
  console.log('  COMPARISON — same 7 days');
  console.log('═'.repeat(78));

  const gridBest = bestGrid || gridResults[CRYPTO_SYMBOLS[0]];
  const gridTotal = gridBest ? gridBest.total : 0;
  const gridClosed = gridBest ? gridBest.closedPnl : 0;

  console.log(`\n  PATH 1 — Crypto Grid (${(gridBest?.sym)||'BTC'}, $100/trade × 3 positions):`);
  console.log(`    Total P&L (closed + open): ${gridTotal>=0?'+':''}$${gridTotal.toFixed(2)}`);
  console.log(`    Closed P&L only:           ${gridClosed>=0?'+':''}$${gridClosed.toFixed(2)}`);
  console.log(`    Max Drawdown:              -$${Math.abs(gridBest?.maxDD||0).toFixed(2)}`);
  console.log(`    Mode switches (EMA cross): ${gridBest?.switches||0}`);

  console.log(`\n  PATH 2 — Forex Sweep (0.1 lot, 4 pairs, Asian session):`);
  console.log(`    Total P&L (all closed):    ${fx.total>=0?'+':''}$${fx.total.toFixed(2)}`);
  console.log(`    Win rate:                  ${fx.wr}%`);
  console.log(`    Trades:                    ${fx.n}`);
  console.log(`    Max Drawdown:              -$${Math.abs(fx.maxDD).toFixed(2)}`);

  console.log('\n  VERDICT:');
  if (fx.total > gridClosed && fx.total > 0) {
    console.log(`  ✅ FOREX SWEEP wins this week (+$${fx.total.toFixed(2)} vs grid +$${gridClosed.toFixed(2)} closed)`);
    console.log(`     → Run forex-bot.js on Oracle server (Asian session 00-07 UTC)`);
    console.log(`     → Scale to 0.3 lot for ~$${(fx.total*4*3).toFixed(0)}/month target`);
    console.log(`     → Grid bot: wait for market to stabilize / BTC to trend up`);
  } else if (gridClosed > fx.total && gridClosed > 0) {
    console.log(`  ✅ CRYPTO GRID wins this week (+$${gridClosed.toFixed(2)} vs forex +$${fx.total.toFixed(2)})`);
    console.log(`     → Run grid-bot.js with EMA20/50 directional filter`);
    console.log(`     → GRID_SYMBOL=${gridBest?.sym}  GRID_CYCLE_GAP=2`);
  } else {
    console.log(`  ⚡ BOTH profitable this week — run BOTH in parallel:`);
    console.log(`     → forex-bot.js  (00-07 UTC Asian session)`);
    console.log(`     → grid-bot.js   (24/7 with EMA directional filter)`);
    console.log(`     → Combined weekly est: +$${(fx.total + gridClosed).toFixed(2)}`);
  }
  console.log('\n' + '═'.repeat(78) + '\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
