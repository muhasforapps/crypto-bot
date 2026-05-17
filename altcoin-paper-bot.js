/**
 * Altcoin Grid Paper Trader
 * - Fetches real live prices from Bybit public API (no auth needed)
 * - EMA20/50 directional grid: LONG when fast>slow, SHORT when fast<slow
 * - $200 paper per position, max 4 positions per coin, max 3 coins
 * - Telegram alerts + status command
 * - State saved to paper-state.json
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const http  = require('http');

// Keep-alive HTTP server so Render doesn't spin down the service
http.createServer((req, res) => {
  const state = loadState();
  const total = Object.values(state).reduce((s, v) => s + (v.closedPnl || 0), 0);
  const coins = Object.keys(state).join(', ') || 'none';
  res.writeHead(200);
  res.end(`Altcoin Paper Bot running\nClosed P&L: +$${total.toFixed(2)}\nTracking: ${coins}`);
}).listen(process.env.PORT || 3000, () => {
  log(`Health server on port ${process.env.PORT || 3000}`);
});

// ── Config ────────────────────────────────────────────────────────────────────
const TRADE_SIZE     = 200;
const MAX_POSITIONS  = 4;
const MAX_COINS      = 3;
const CYCLE_GAP      = 0.02;
const TP_PCT         = CYCLE_GAP / 3;        // 0.67% TP
const GRID_STEP      = 0.005;                // 0.5% min gap between entries
const EMA_FAST       = 20;
const EMA_SLOW       = 50;
const MIN_EMA_SEP    = 0.004;                // 0.4% EMA separation required
const SWITCH_COOL_MS = 4 * 60 * 60 * 1000;  // 4H cooldown between mode switches
const SCAN_MS        = 15 * 60 * 1000;       // scan every 15 min
const MIN_VOL_USD    = 20_000_000;  // $20M min volume (wider net)
const MIN_CHANGE     = 1.5;         // ±1.5% min 24H move (catch earlier movers)
const MIN_TREND_SCORE = 0.62;
const STALE_HOURS    = 12;          // drop coin from state if no positions for 12H
const STATE_FILE     = './paper-state.json';
const BASE           = 'https://api.bybit.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);

// ── State ─────────────────────────────────────────────────────────────────────
function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Telegram ──────────────────────────────────────────────────────────────────
let tgOffset = 0;

async function tg(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { console.log('[TG]', msg.replace(/<[^>]+>/g,'')); return; }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'HTML' }, { timeout: 8000 });
  } catch (_) {}
}

async function pollTelegram() {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${tgOffset}&timeout=2`,
      { timeout: 6000 });
    for (const upd of res.data.result || []) {
      tgOffset = upd.update_id + 1;
      const text   = upd.message?.text?.trim().toLowerCase();
      const fromId = String(upd.message?.chat?.id);
      if (fromId !== chatId) continue;
      if (text === 'status' || text === 'p&l') await sendStatus();
      if (text === 'help') await tg(
        'Commands:\n<b>status</b> — open positions & P&L\n<b>help</b> — this message'
      );
    }
  } catch (_) {}
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(values, period) {
  if (values.length < period) return values.map(() => values[0] || 0);
  const k    = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const res  = new Array(period).fill(seed);
  let ema = seed;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    res.push(ema);
  }
  return res;
}

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchTickers() {
  const res = await axios.get(`${BASE}/v5/market/tickers?category=linear`, { timeout: 10000 });
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
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
}

async function fetchCandles(symbol) {
  const res = await axios.get(
    `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=100`,
    { timeout: 10000 }
  );
  if (res.data.retCode !== 0) return [];
  return res.data.result.list
    .map(c => ({ ts: +c[0], high: +c[2], low: +c[3], close: +c[4] }))
    .sort((a, b) => a.ts - b.ts);
}

// ── Trend quality score (0–1) ─────────────────────────────────────────────────
// Combines EMA consistency (% of candles clearly trending) + current separation
// High score = strong clean trend → good for grid
// Low score  = choppy, EMA crossing frequently → skip
function calcTrendScore(candles) {
  if (candles.length < EMA_SLOW + 10) return 0;
  const closes = candles.map(c => c.close);
  const ema20  = calcEMA(closes, EMA_FAST);
  const ema50  = calcEMA(closes, EMA_SLOW);

  let consistent = 0;
  const from = EMA_SLOW;
  for (let i = from; i < candles.length; i++) {
    if (Math.abs(ema20[i] - ema50[i]) / ema50[i] >= MIN_EMA_SEP) consistent++;
  }
  const consistency = consistent / (candles.length - from);  // 0–1

  const curSep = Math.abs(ema20[ema20.length - 1] - ema50[ema50.length - 1]) / ema50[ema50.length - 1];
  const sepScore = Math.min(curSep / 0.02, 1);               // 0–1, caps at 2% sep

  return consistency * 0.6 + sepScore * 0.4;
}

// ── Status report ─────────────────────────────────────────────────────────────
async function sendStatus() {
  const state  = loadState();
  const active = Object.entries(state).filter(([, v]) => v.positions?.length > 0);
  const all    = Object.entries(state);

  if (!all.length) { await tg('📊 No coins being tracked yet.'); return; }

  let totalClosed = 0, totalOpen = 0;
  const lines = ['📊 <b>Paper Grid Status</b>  ($200/position)\n'];

  for (const [sym, s] of all) {
    const emoji = s.mode === 'long' ? '🟢' : '🔴';
    totalClosed += s.closedPnl || 0;

    if (!s.positions?.length) {
      const wr = s.trades ? ((s.wins / s.trades) * 100).toFixed(0) : '—';
      lines.push(`${emoji} <b>${sym}</b>  no open positions  Closed: +$${(s.closedPnl||0).toFixed(2)}  WR:${wr}%`);
      continue;
    }

    try {
      const candles = await fetchCandles(sym);
      const cur = candles.length ? candles[candles.length - 1].close : 0;
      let coinOpen = 0;
      lines.push(`${emoji} <b>${sym}</b>  ${s.mode.toUpperCase()}  (${s.positions.length} open)`);

      for (const pos of s.positions) {
        const pnl = pos.mode === 'long'
          ? (cur - pos.entry) / pos.entry * TRADE_SIZE
          : (pos.entry - cur) / pos.entry * TRADE_SIZE;
        coinOpen += pnl;
        const pStr = (pnl >= 0 ? '+$' : '-$') + Math.abs(pnl).toFixed(2);
        lines.push(`   @${pos.entry}  TP:${pos.tp}  now:${cur}  <b>${pStr}</b>`);
      }

      totalOpen += coinOpen;
      const wr = s.trades ? ((s.wins / s.trades) * 100).toFixed(0) : '—';
      lines.push(`   Closed: $${(s.closedPnl||0).toFixed(2)}  (${s.trades||0}tr  WR:${wr}%)\n`);
      await sleep(300);
    } catch (_) {}
  }

  lines.push(`\n💰 <b>Total closed: ${totalClosed >= 0 ? '+' : ''}$${totalClosed.toFixed(2)}</b>`);
  lines.push(`📈 Unrealized: ${totalOpen >= 0 ? '+' : ''}$${totalOpen.toFixed(2)}`);
  await tg(lines.join('\n'));
}

// ── Process one coin ──────────────────────────────────────────────────────────
async function processCoin(sym, candles, state, numActive) {
  if (candles.length < EMA_SLOW + 5) return;

  const closes   = candles.map(c => c.close);
  const ema20arr = calcEMA(closes, EMA_FAST);
  const ema50arr = calcEMA(closes, EMA_SLOW);
  const last     = candles[candles.length - 1];
  const e20      = ema20arr[ema20arr.length - 1];
  const e50      = ema50arr[ema50arr.length - 1];
  const newMode  = e20 > e50 ? 'long' : 'short';
  const emaSep   = Math.abs(e20 - e50) / e50;
  const now      = Date.now();

  // ── Init new coin — only if trend quality score passes ───────────────────
  if (!state[sym]) {
    if (numActive >= MAX_COINS) return;
    const score = calcTrendScore(candles);
    if (score < MIN_TREND_SCORE) {
      log(`  ~ SKIP ${sym}  trend score: ${score.toFixed(2)} < ${MIN_TREND_SCORE}`);
      return;
    }
    state[sym] = {
      mode: newMode, positions: [], closedPnl: 0,
      trades: 0, wins: 0, lastSwitch: 0, startedAt: new Date().toISOString(),
      trendScore: +score.toFixed(2),
    };
    log(`  + New coin: ${sym}  ${newMode}  score:${score.toFixed(2)}  EMA sep: ${(emaSep*100).toFixed(2)}%`);
    await tg(
      `📡 <b>New coin tracked: ${sym}</b>\n` +
      `Direction: <b>${newMode.toUpperCase()}</b>\n` +
      `Trend score: ${(score*100).toFixed(0)}/100  |  EMA sep: ${(emaSep*100).toFixed(2)}%\n` +
      `$${TRADE_SIZE}/position  max ${MAX_POSITIONS} positions\n<i>Paper trade</i>`
    );
  }

  const s = state[sym];

  // ── Check TPs ─────────────────────────────────────────────────────────────
  for (let pi = s.positions.length - 1; pi >= 0; pi--) {
    const pos  = s.positions[pi];
    const hit  = pos.mode === 'long'  ? last.high >= pos.tp
               : pos.mode === 'short' ? last.low  <= pos.tp : false;
    if (!hit) continue;

    const pnl = pos.mode === 'long'
      ? (pos.tp - pos.entry) / pos.entry * TRADE_SIZE
      : (pos.entry - pos.tp) / pos.entry * TRADE_SIZE;

    s.closedPnl += pnl;
    s.trades++;
    s.wins++;
    s.positions.splice(pi, 1);

    log(`  ✅ TP  ${sym}  ${pos.mode}  entry:${pos.entry}  tp:${pos.tp}  +$${pnl.toFixed(2)}`);
    await tg(
      `✅ <b>TP HIT — ${pos.mode.toUpperCase()} ${sym}</b>\n` +
      `Entry: ${pos.entry}  →  TP: ${pos.tp}\n` +
      `P&L: <b>+$${pnl.toFixed(2)}</b>\n` +
      `Total closed: <b>+$${s.closedPnl.toFixed(2)}</b>  (${s.trades} trades  WR:${(s.wins/s.trades*100).toFixed(0)}%)`
    );
  }

  // ── Mode switch ───────────────────────────────────────────────────────────
  if (s.mode !== newMode && (now - (s.lastSwitch || 0)) >= SWITCH_COOL_MS) {
    let switchPnl = 0;
    const closed = [];
    for (const pos of s.positions) {
      const pnl = pos.mode === 'long'
        ? (last.close - pos.entry) / pos.entry * TRADE_SIZE
        : (pos.entry - last.close) / pos.entry * TRADE_SIZE;
      switchPnl   += pnl;
      s.closedPnl += pnl;
      s.trades++;
      if (pnl > 0) s.wins++;
      closed.push(`${pos.mode} @${pos.entry} → ${last.close}  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    }
    s.positions  = [];
    s.mode       = newMode;
    s.lastSwitch = now;

    log(`  🔄 SWITCH ${sym} → ${newMode}  pnl:${switchPnl >= 0 ? '+' : ''}$${switchPnl.toFixed(2)}`);
    await tg(
      `🔄 <b>MODE SWITCH — ${sym}</b>\n` +
      `→ Now <b>${newMode.toUpperCase()}</b>  (EMA20/50 crossed)\n` +
      `Switch P&L: ${switchPnl >= 0 ? '+' : ''}$${switchPnl.toFixed(2)}\n` +
      (closed.length ? closed.join('\n') : 'No open positions to close')
    );
  }

  // ── Open new grid position ────────────────────────────────────────────────
  if (emaSep >= MIN_EMA_SEP && s.positions.length < MAX_POSITIONS) {
    const lastEntry = s.positions.length > 0 ? s.positions[s.positions.length - 1].entry : null;
    const dist = lastEntry ? Math.abs(last.close - lastEntry) / lastEntry : 1;
    if (dist >= GRID_STEP) {
      const dec = last.close < 0.01 ? 6 : last.close < 1 ? 5 : last.close < 100 ? 4 : 2;
      const tp  = s.mode === 'long'
        ? +(last.close * (1 + TP_PCT)).toFixed(dec)
        : +(last.close * (1 - TP_PCT)).toFixed(dec);

      s.positions.push({ entry: last.close, tp, mode: s.mode, openedAt: new Date().toISOString() });

      const emoji = s.mode === 'long' ? '🟢' : '🔴';
      log(`  ${emoji} OPEN ${sym}  ${s.mode}  entry:${last.close}  tp:${tp}`);
      await tg(
        `${emoji} <b>${s.mode.toUpperCase()} — ${sym}</b>\n` +
        `📍 Entry: <code>${last.close}</code>\n` +
        `🎯 TP:    <code>${tp}</code>  (est. +$${(TRADE_SIZE * TP_PCT).toFixed(2)})\n` +
        `📦 $${TRADE_SIZE} paper  |  Pos: ${s.positions.length}/${MAX_POSITIONS}\n` +
        `📊 EMA sep: ${(emaSep*100).toFixed(2)}%  |  Closed so far: +$${s.closedPnl.toFixed(2)}`
      );
    }
  }
}

// ── Main scan loop ────────────────────────────────────────────────────────────
async function scan() {
  const state = loadState();
  const now   = Date.now();

  // ── Rotate out stale coins (no positions + idle > STALE_HOURS) ────────────
  for (const [sym, s] of Object.entries(state)) {
    if (s.positions?.length > 0) continue;
    const idleMs = now - new Date(s.startedAt || 0).getTime();
    if (idleMs > STALE_HOURS * 3600 * 1000) {
      log(`  ~ DROP ${sym}  idle ${Math.round(idleMs/3600000)}h  closed P&L: +$${(s.closedPnl||0).toFixed(2)}`);
      await tg(`🔄 <b>Rotated out: ${sym}</b>  (idle ${Math.round(idleMs/3600000)}h)\nClosed P&L: +$${(s.closedPnl||0).toFixed(2)}  |  Looking for better coin...`);
      delete state[sym];
    }
  }

  const numActive = Object.values(state).filter(s => s.positions?.length > 0).length;
  log(`── Scan  tracked:${Object.keys(state).length}  active:${numActive}/${MAX_COINS} ──`);

  // Process coins already in state
  for (const sym of Object.keys(state)) {
    try {
      const candles = await fetchCandles(sym);
      await processCoin(sym, candles, state, numActive);
    } catch (e) { log(`  ! ${sym}: ${e.message}`); }
    await sleep(400);
  }

  // Look for new trending coins if we have room — score all candidates first
  if (numActive < MAX_COINS) {
    try {
      const tickers = await fetchTickers();
      const candidates = [];

      for (const t of tickers.slice(0, 50)) {
        if (state[t.symbol]) continue;
        await sleep(150);
        try {
          const candles = await fetchCandles(t.symbol);
          if (candles.length < EMA_SLOW + 10) continue;
          const score = calcTrendScore(candles);
          candidates.push({ t, candles, score });
        } catch (_) {}
      }

      // Sort by trend score descending — best trending coins get the slots first
      candidates.sort((a, b) => b.score - a.score);
      log(`  Candidates ranked: ${candidates.map(c => `${c.t.symbol}(${c.score.toFixed(2)})`).join(' ')}`);

      for (const { t, candles } of candidates) {
        if (Object.values(state).filter(s => s.positions?.length > 0).length >= MAX_COINS) break;
        await processCoin(t.symbol, candles, state, numActive);
      }
    } catch (e) { log(`  ! ticker scan: ${e.message}`); }
  }

  saveState(state);

  const total = Object.values(state).reduce((s, v) => s + (v.closedPnl || 0), 0);
  log(`  Closed P&L: ${total >= 0 ? '+' : ''}$${total.toFixed(2)}`);
}

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════════════');
  log(`  Altcoin Grid Paper Trader`);
  log(`  $${TRADE_SIZE}/position  |  max ${MAX_POSITIONS} pos/coin  |  max ${MAX_COINS} coins`);
  log(`  EMA${EMA_FAST}/${EMA_SLOW}  |  15min  |  TP:${(TP_PCT*100).toFixed(2)}%  |  min sep:${(MIN_EMA_SEP*100).toFixed(1)}%`);
  log('══════════════════════════════════════════════════');

  await tg(
    '🤖 <b>Altcoin Grid Paper Trader — STARTED</b>\n\n' +
    `📦 $${TRADE_SIZE} per position (paper money)\n` +
    `📊 EMA${EMA_FAST}/${EMA_SLOW} directional grid  |  15min candles\n` +
    `🎯 TP: +${(TP_PCT*100).toFixed(2)}% per position\n` +
    `🔍 Scans every 15min  |  Max ${MAX_COINS} coins  |  Max ${MAX_POSITIONS} pos/coin\n` +
    `✅ Trend filter: EMA sep > ${(MIN_EMA_SEP*100).toFixed(1)}%  (no choppy coins)\n\n` +
    `Commands: <b>status</b> → open trades & P&L\n<b>help</b> → all commands`
  );

  // Telegram polling background loop
  (async () => {
    while (true) { await pollTelegram(); await sleep(3000); }
  })();

  // First scan immediately
  try { await scan(); } catch (e) { log('Scan error:', e.message); }

  // Then every 15 min
  while (true) {
    log(`  Next scan in 15min...`);
    await sleep(SCAN_MS);
    try { await scan(); } catch (e) { log('Scan error:', e.message); }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
