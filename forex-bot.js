/**
 * Forex Paper Trade Bot — Asian Session Liquidity Sweep + RSI
 * Session: 00:00–07:00 UTC (Asian session, early only)
 * Candles: 5-minute chart
 * TP: $25  SL: $10  (2.5:1 R:R)
 * RSI(14) filter: >55 confirms SHORT sweep, <45 confirms LONG sweep
 * Pairs: GBP/JPY, GBP/USD, EUR/GBP, NZD/USD
 * Backtest: 54.6% WR, +$615/month at 0.3 lot, MaxDD -$287
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const yf    = require('yahoo-finance2');
const yahooFinance = new yf.default();

// ── Config ────────────────────────────────────────────────────────────────────
const LOT           = 1.0;    // 1 standard lot (paper)
const TP_USD        = 25;     // $25 TP per trade
const SL_USD        = 10;     // $10 SL per trade
const LOOKBACK      = 48;     // 48 × 5min = 4H swing window
const MIN_SWEEP     = 0.15;   // wick must clear level by 15% of ATR
const RSI_PERIOD    = 14;
const RSI_OB        = 55;     // RSI > 55 to confirm SHORT sweep
const RSI_OS        = 45;     // RSI < 45 to confirm LONG sweep
const SESSION_START = 0;      // 00:00 UTC
const SESSION_END   = 7;      // 07:00 UTC
const SCAN_INTERVAL = 5 * 60 * 1000;    // check every 5 min
const COOLDOWN_MS   = 30 * 60 * 1000;   // 30min cooldown per pair
const STATE_FILE    = './forex-state.json';

const PAIRS = [
  { symbol: 'GBPJPY=X', name: 'GBP/JPY', decimals: 3 },
  { symbol: 'GBPUSD=X', name: 'GBP/USD', decimals: 5 },
  { symbol: 'EURGBP=X', name: 'EUR/GBP', decimals: 5 },
  { symbol: 'NZDUSD=X', name: 'NZD/USD', decimals: 5 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function inSession() {
  const h = new Date().getUTCHours();
  return h >= SESSION_START && h < SESSION_END;
}

function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Telegram ──────────────────────────────────────────────────────────────────
let tgOffset = 0;

async function tg(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'HTML' });
  } catch (_) {}
}

async function pollTelegram() {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${tgOffset}&timeout=2`);
    for (const upd of res.data.result || []) {
      tgOffset = upd.update_id + 1;
      const text   = upd.message?.text?.trim().toLowerCase();
      const fromId = String(upd.message?.chat?.id);
      if (fromId !== chatId) continue;
      if (text === 'status' || text === 'p&l') await sendStatus();
      if (text === 'help') await tg(
        'Commands:\n<b>status</b> — open trades & P&L\n<b>help</b> — this message'
      );
    }
  } catch (_) {}
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcATR(candles, period = 14) {
  const slice = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    sum += Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i-1].close),
      Math.abs(slice[i].low  - slice[i-1].close),
    );
  }
  return sum / period;
}

function calcRSI(candles, period = RSI_PERIOD) {
  if (candles.length < period + 2) return 50;
  const slice = candles.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i].close - slice[i-1].close;
    if (d > 0) gains += d; else losses -= d;
  }
  const avgG = gains / period, avgL = losses / period;
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// ── Signal detection (sweep + RSI) ────────────────────────────────────────────
function detectSweep(candles, pair) {
  if (candles.length < LOOKBACK + RSI_PERIOD + 2) return null;

  const c    = candles[candles.length - 1];
  const prev = candles.slice(-(LOOKBACK + 1), -1);
  const atr  = calcATR(candles);
  const rsi  = calcRSI(candles);

  const swingHi = Math.max(...prev.map(x => x.high));
  const swingLo = Math.min(...prev.map(x => x.low));

  function toDist(usd) {
    if (pair.name.includes('JPY'))    return usd / (LOT * 100000 / c.close);
    if (pair.name.startsWith('USD/')) return usd / (LOT * 100000 / c.close);
    return usd / (LOT * 100000);
  }

  const tpDist = toDist(TP_USD);
  const slDist = toDist(SL_USD);

  // SHORT: wick above swing high, close back below, RSI confirms
  if (c.high > swingHi + atr * MIN_SWEEP && c.close < swingHi && rsi > RSI_OB) {
    return {
      direction: 'SHORT',
      entry: c.close,
      tp: +(c.close - tpDist).toFixed(pair.decimals),
      sl: +(c.close + slDist).toFixed(pair.decimals),
      sweptLevel: +swingHi.toFixed(pair.decimals),
      wickSize: +(c.high - swingHi).toFixed(pair.decimals),
      rsi: +rsi.toFixed(1),
    };
  }

  // LONG: wick below swing low, close back above, RSI confirms
  if (c.low < swingLo - atr * MIN_SWEEP && c.close > swingLo && rsi < RSI_OS) {
    return {
      direction: 'LONG',
      entry: c.close,
      tp: +(c.close + tpDist).toFixed(pair.decimals),
      sl: +(c.close - slDist).toFixed(pair.decimals),
      sweptLevel: +swingLo.toFixed(pair.decimals),
      wickSize: +(swingLo - c.low).toFixed(pair.decimals),
      rsi: +rsi.toFixed(1),
    };
  }

  return null;
}

// ── Fetch candles ─────────────────────────────────────────────────────────────
async function getCandles(symbol) {
  const period1 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const result  = await yahooFinance.chart(symbol, { interval: '5m', period1 }, { validateResult: false });
  return result.quotes
    .filter(q => q.open && q.high && q.low && q.close)
    .map(q => ({ open: q.open, high: q.high, low: q.low, close: q.close }));
}

// ── P&L tracking ─────────────────────────────────────────────────────────────
function calcPnl(pair, direction, entry, current) {
  const diff = direction === 'SHORT' ? entry - current : current - entry;
  if (pair.name.includes('JPY'))    return diff * LOT * 100000 / current;
  if (pair.name.startsWith('USD/')) return diff * LOT * 100000 / current;
  return diff * LOT * 100000;
}

async function sendStatus() {
  const state = loadState();
  const open  = Object.entries(state).filter(([,v]) => v.active);
  if (!open.length) { await tg('No open paper trades right now.'); return; }

  let total = 0;
  const lines = ['📊 <b>Open Paper Trades</b>  (1 lot each)\n'];
  for (const [sym, t] of open) {
    const pair = PAIRS.find(p => p.symbol === sym);
    if (!pair) continue;
    try {
      const candles = await getCandles(sym);
      const cur = candles[candles.length - 1].close;
      const pnl = calcPnl(pair, t.direction, t.entry, cur);
      total += pnl;

      const status = t.direction === 'SHORT'
        ? (cur <= t.tp ? '✅ TP zone' : cur >= t.sl ? '❌ SL zone' : '🔄 open')
        : (cur >= t.tp ? '✅ TP zone' : cur <= t.sl ? '❌ SL zone' : '🔄 open');

      const emoji  = t.direction === 'LONG' ? '🟢' : '🔴';
      const pnlStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
      lines.push(
        `${emoji} ${pair.name}  ${t.direction}  @${t.entry}  now:${cur.toFixed(pair.decimals)}\n` +
        `   ${status}  <b>${pnlStr}</b>`
      );
    } catch (_) {}
    await sleep(400);
  }
  const tot = (total >= 0 ? '+$' : '-$') + Math.abs(total).toFixed(2);
  lines.push(`\n💰 <b>Total P&L: ${tot}</b>  (1 lot each)`);
  await tg(lines.join('\n'));
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  if (!inSession()) return;

  const now   = Date.now();
  const state = loadState();
  let fired   = 0;

  log(`Session scan — ${new Date().toUTCString().slice(17,22)} UTC`);

  for (const pair of PAIRS) {
    const lastTime = state[pair.symbol]?.lastTrade ?? 0;
    if (now - lastTime < COOLDOWN_MS) continue;

    try {
      const candles = await getCandles(pair.symbol);
      if (candles.length < LOOKBACK + RSI_PERIOD + 2) continue;

      const sig = detectSweep(candles, pair);
      if (!sig) { await sleep(400); continue; }

      const emoji = sig.direction === 'LONG' ? '🟢' : '🔴';
      const fp    = n => n.toFixed(pair.decimals);

      await tg(
        `${emoji} <b>SWEEP SIGNAL — ${sig.direction} ${pair.name}</b>\n` +
        `⏰ Asian session  |  5-min chart  |  RSI: ${sig.rsi}\n\n` +
        `📍 Entry:  <code>${fp(sig.entry)}</code>\n` +
        `🎯 TP:     <code>${fp(sig.tp)}</code>  (+$${TP_USD})\n` +
        `🛑 SL:     <code>${fp(sig.sl)}</code>  (-$${SL_USD})\n` +
        `💧 Swept:  <code>${fp(sig.sweptLevel)}</code>  (wick: ${fp(sig.wickSize)})\n\n` +
        `📦 Size: 1 lot paper  |  R:R = 2.5:1\n` +
        `<i>Paper trade — execute on your broker</i>`
      );

      log(`  🔥 ${sig.direction} ${pair.name}  entry:${sig.entry}  tp:${sig.tp}  sl:${sig.sl}  RSI:${sig.rsi}`);

      state[pair.symbol] = {
        active: true,
        direction: sig.direction,
        entry: sig.entry,
        tp: sig.tp,
        sl: sig.sl,
        lastTrade: now,
        time: new Date().toISOString(),
      };
      fired++;
    } catch (e) {
      log(`  ! ${pair.name}: ${e.message}`);
    }
    await sleep(600);
  }

  if (fired === 0) log('  No sweeps found this scan.');
  saveState(state);

  await checkClosedTrades(state);
}

async function checkClosedTrades(state) {
  for (const [sym, t] of Object.entries(state)) {
    if (!t.active) continue;
    const pair = PAIRS.find(p => p.symbol === sym);
    if (!pair) continue;
    try {
      const candles = await getCandles(sym);
      const cur = candles[candles.length - 1].close;
      let closed = null;

      if (t.direction === 'SHORT') {
        if (cur <= t.tp) closed = { outcome: 'TP ✅', pnl: +TP_USD };
        if (cur >= t.sl) closed = { outcome: 'SL ❌', pnl: -SL_USD };
      } else {
        if (cur >= t.tp) closed = { outcome: 'TP ✅', pnl: +TP_USD };
        if (cur <= t.sl) closed = { outcome: 'SL ❌', pnl: -SL_USD };
      }

      if (closed) {
        const emoji = closed.pnl > 0 ? '💰' : '💸';
        await tg(
          `${emoji} <b>${closed.outcome} — ${t.direction} ${pair.name}</b>\n` +
          `Entry: ${t.entry}  →  Exit: ${cur.toFixed(pair.decimals)}\n` +
          `P&L: <b>${closed.pnl >= 0 ? '+' : ''}$${closed.pnl}</b>  (1 lot)`
        );
        state[sym] = { active: false, lastTrade: state[sym].lastTrade };
        saveState(state);
        log(`  ${closed.outcome} ${pair.name}  pnl:${closed.pnl >= 0 ? '+' : ''}$${closed.pnl}`);
      }
    } catch (_) {}
    await sleep(400);
  }
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════');
  log('  Forex Sweep Bot  |  00-07 UTC Asian  |  5min + RSI');
  log('  TP:$25  SL:$10  2.5:1 R:R  |  1 lot paper');
  log('══════════════════════════════════════════');

  const nextSession = () => {
    const now = new Date();
    const h   = now.getUTCHours();
    if (h >= SESSION_START && h < SESSION_END) return 'NOW (in session)';
    const next = new Date(now);
    if (h >= SESSION_END) next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(SESSION_START, 0, 0, 0);
    const mins = Math.round((next - now) / 60000);
    return `in ${Math.floor(mins/60)}h ${mins%60}m (${SESSION_START}:00 UTC)`;
  };

  await tg(
    '📡 <b>Forex Sweep Bot started</b>\n\n' +
    '4 pairs: GBP/JPY  GBP/USD  EUR/GBP  NZD/USD\n' +
    '⏰ Active: 00:00–07:00 UTC (Asian session)\n' +
    '📈 5-min chart  |  RSI(14) sweep filter\n' +
    `📦 1 lot paper  |  🎯 $25 TP  |  🛑 $10 SL  |  2.5:1 R:R\n` +
    `📊 Backtest: 54.6% WR  ~$615/mo at 0.3 lot\n\n` +
    `Next session: ${nextSession()}\n\n` +
    `Commands: <b>status</b> → open trades & P&L`
  );

  (async () => { while (true) { await pollTelegram(); await sleep(3000); } })();

  while (true) {
    try {
      await scan();
    } catch (e) {
      log('Scan error:', e.message);
    }
    await sleep(SCAN_INTERVAL);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
