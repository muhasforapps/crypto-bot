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
const MAX_COINS      = 6;
const CYCLE_GAP      = 0.02;
const TP_PCT         = CYCLE_GAP / 3;   // 0.67% default TP
const GRID_STEP      = 0.005;           // 0.5% default grid step
const BIG_MOVE_PCT   = 10;              // if |24H change| > 10% → use wider TP
const TP_BIG         = 0.05;            // 5% TP for big movers
const GRID_BIG       = 0.01;            // 1% grid step for big movers
const EMA_FAST       = 20;
const EMA_SLOW       = 50;
const MIN_EMA_SEP    = 0.004;
const SWITCH_COOL_MS = 4 * 60 * 60 * 1000;
const SCAN_MS        = 15 * 60 * 1000;
const MIN_VOL_USD    = 20_000_000;
const MIN_CHANGE     = 1.5;
const MIN_TREND_SCORE = 0.62;
const STALE_HOURS    = 8;
const STATE_FILE     = './paper-state.json';
const BASE           = 'https://api.bybit.com';
const HEADERS        = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);

// ── State ─────────────────────────────────────────────────────────────────────
function loadState()  { try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

// ── Users — stored in a pinned message in a private Telegram group ────────────
// Setup (one time):
//   1. Create a private Telegram group — add your bot as admin (so it can pin)
//   2. Get the group's chat ID: forward any message from the group to @userinfobot
//   3. Add TELEGRAM_STORAGE_CHAT=<that chat id> to Render env vars
// On every /start the bot edits the pinned message — survives all redeploys.
const USERS_FILE    = './users.json';
const STORAGE_CHAT  = process.env.TELEGRAM_STORAGE_CHAT;
let   storageMsgId  = null;   // cached message_id of the pinned storage message

async function loadUsers() {
  const owner = process.env.TELEGRAM_CHAT_ID;
  const base  = owner ? [owner] : [];

  if (STORAGE_CHAT && process.env.TELEGRAM_TOKEN) {
    try {
      const token = process.env.TELEGRAM_TOKEN;
      const res   = await axios.get(
        `https://api.telegram.org/bot${token}/getChat?chat_id=${STORAGE_CHAT}`,
        { timeout: 5000 });
      const pinned = res.data.result?.pinned_message;
      if (pinned?.text) {
        storageMsgId = pinned.message_id;
        const ids = JSON.parse(pinned.text);
        return [...new Set([...base, ...ids])];
      }
    } catch (e) { log(`  ! TG storage read: ${e.message}`); }
    return base;
  }

  // Fallback: local file (local dev / no storage chat configured)
  try {
    const ids = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return [...new Set([...base, ...ids])];
  } catch { return base; }
}

async function saveUsers(users) {
  const token = process.env.TELEGRAM_TOKEN;

  if (STORAGE_CHAT && token) {
    try {
      const payload = JSON.stringify(users);

      if (storageMsgId) {
        // Edit existing pinned message
        await axios.post(`https://api.telegram.org/bot${token}/editMessageText`,
          { chat_id: STORAGE_CHAT, message_id: storageMsgId, text: payload },
          { timeout: 5000 });
      } else {
        // First time: send message then pin it
        const msg = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
          { chat_id: STORAGE_CHAT, text: payload }, { timeout: 5000 });
        storageMsgId = msg.data.result.message_id;
        await axios.post(`https://api.telegram.org/bot${token}/pinChatMessage`,
          { chat_id: STORAGE_CHAT, message_id: storageMsgId, disable_notification: true },
          { timeout: 5000 });
      }
      return;
    } catch (e) { log(`  ! TG storage write: ${e.message}`); }
  }

  // Fallback: local file
  try { fs.writeFileSync(USERS_FILE, JSON.stringify(users)); } catch {}
}

// ── Telegram ──────────────────────────────────────────────────────────────────
let tgOffset = 0;

// Send to one specific chat
async function tgOne(chatId, msg) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: msg, parse_mode: 'HTML' }, { timeout: 8000 });
  } catch (_) {}
}

// Broadcast to all registered users
async function tg(msg) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) { console.log('[TG]', msg.replace(/<[^>]+>/g,'')); return; }
  const users = await loadUsers();
  for (const id of users) { await tgOne(id, msg); await sleep(100); }
}

async function pollTelegram() {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return;
  try {
    const res = await axios.get(
      `https://api.telegram.org/bot${token}/getUpdates?offset=${tgOffset}&timeout=2`,
      { timeout: 6000 });

    for (const upd of res.data.result || []) {
      tgOffset = upd.update_id + 1;
      const text   = upd.message?.text?.trim().toLowerCase();
      const fromId = String(upd.message?.chat?.id);
      const name   = upd.message?.from?.first_name || 'there';
      if (!text) continue;

      // /chatid works in any chat — used to get group ID for TELEGRAM_STORAGE_CHAT setup
      if (text === '/chatid') {
        const gid   = String(upd.message?.chat?.id);
        const gtype = upd.message?.chat?.type;
        await tgOne(gid, `Chat ID: <code>${gid}</code>\nType: ${gtype}\n\nPaste this as <b>TELEGRAM_STORAGE_CHAT</b> in Render env vars.`);
        continue;
      }

      const users = await loadUsers();

      if (text === '/start' || text === 'start') {
        if (!users.includes(fromId)) {
          users.push(fromId);
          await saveUsers(users);
          log(`  + New user: ${fromId} (${name})  total: ${users.length}`);
          await tgOne(fromId,
            `👋 Welcome <b>${name}</b>!\n\n` +
            `You're now registered for live paper trading signals.\n\n` +
            `📦 $200/position  |  EMA grid  |  15min scans\n` +
            `🎯 Normal coins: TP +0.67%  |  Big movers (>10%): TP +5%\n\n` +
            `Commands:\n<b>status</b> — open positions & P&L\n<b>help</b> — all commands`
          );
          const owner = process.env.TELEGRAM_CHAT_ID;
          if (owner && owner !== fromId)
            await tgOne(owner, `👤 New user joined: <b>${name}</b> (${fromId})  Total: ${users.length}`);
        } else {
          await tgOne(fromId, `✅ Already registered, ${name}! Send <b>status</b> to see open trades.`);
        }
        continue;
      }

      // Only registered users can use commands
      if (!users.includes(fromId)) {
        await tgOne(fromId, 'Send /start to register for signals.');
        continue;
      }

      if (text === 'status' || text === 'p&l') await sendStatus(fromId);
      if (text === '/stop' || text === 'stop') {
        const idx = users.indexOf(fromId);
        if (idx > -1 && fromId !== process.env.TELEGRAM_CHAT_ID) {
          users.splice(idx, 1);
          await saveUsers(users);
          await tgOne(fromId, '👋 Unsubscribed. Send /start to rejoin anytime.');
        }
      }
      if (text === 'help' || text === '/help') {
        await tgOne(fromId,
          'Commands:\n<b>status</b> — open positions & P&L\n' +
          '<b>stop</b> — unsubscribe from signals\n' +
          '<b>help</b> — this message'
        );
      }
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
  const res = await axios.get(`${BASE}/v5/market/tickers?category=linear`, { timeout: 10000, headers: HEADERS });
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
    { timeout: 10000, headers: HEADERS }
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
async function sendStatus(replyTo) {
  const state  = loadState();
  const active = Object.entries(state).filter(([, v]) => v.positions?.length > 0);
  const all    = Object.entries(state);

  const send = replyTo ? (m => tgOne(replyTo, m)) : tg;
  if (!all.length) { await send('📊 No coins being tracked yet.'); return; }

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
  await send(lines.join('\n'));
}

// ── Process one coin ──────────────────────────────────────────────────────────
async function processCoin(sym, candles, state, numActive, change24h = 0) {
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

  // Dynamic TP: big movers (>10% 24H) get 5% TP + 1% grid, others keep 0.67% + 0.5%
  const isBigMover = Math.abs(change24h) >= 10;
  const tpPct      = isBigMover ? 0.05  : TP_PCT;
  const gridStep   = isBigMover ? 0.01  : GRID_STEP;

  // ── Init new coin — only if trend quality score passes ───────────────────
  if (!state[sym]) {
    if (numActive >= MAX_COINS) return;
    // SHORTS_ONLY: only add coin if it is already in a downtrend
    if (SHORTS_ONLY && newMode !== 'short') {
      log(`  ~ SKIP ${sym}  waiting for SHORT (currently ${newMode})`);
      return;
    }
    const score = calcTrendScore(candles);
    if (score < MIN_TREND_SCORE) {
      log(`  ~ SKIP ${sym}  trend score: ${score.toFixed(2)} < ${MIN_TREND_SCORE}`);
      return;
    }
    state[sym] = {
      mode: newMode, positions: [], closedPnl: 0,
      trades: 0, wins: 0, lastSwitch: 0,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      trendScore: +score.toFixed(2),
      change24h: +change24h.toFixed(2),
    };
    const modeTag = isBigMover ? `${newMode.toUpperCase()} 🔥 BIG MOVER` : newMode.toUpperCase();
    log(`  + New coin: ${sym}  ${modeTag}  score:${score.toFixed(2)}  24H:${change24h.toFixed(1)}%  TP:${(tpPct*100).toFixed(2)}%`);
    await tg(
      `📡 <b>New coin tracked: ${sym}</b>\n` +
      `Direction: <b>${newMode.toUpperCase()}</b>${isBigMover ? '  🔥 Big mover!' : ''}\n` +
      `24H change: ${change24h>=0?'+':''}${change24h.toFixed(1)}%  |  Trend score: ${(score*100).toFixed(0)}/100\n` +
      `🎯 TP: ${(tpPct*100).toFixed(2)}%  |  Grid: ${(gridStep*100).toFixed(1)}%\n` +
      `$${TRADE_SIZE}/position  max ${MAX_POSITIONS} positions\n<i>Paper trade</i>`
    );
  }

  const s = state[sym];

  // ── Check TPs ─────────────────────────────────────────────────────────────
  for (let pi = s.positions.length - 1; pi >= 0; pi--) {
    const pos = s.positions[pi];
    const hit = pos.mode === 'long' ? last.high >= pos.tp : last.low <= pos.tp;
    if (!hit) continue;

    const pnl = pos.mode === 'long'
      ? (pos.tp - pos.entry) / pos.entry * TRADE_SIZE
      : (pos.entry - pos.tp) / pos.entry * TRADE_SIZE;

    s.closedPnl += pnl;
    s.trades++;
    s.wins++;
    s.positions.splice(pi, 1);
    s.lastActivityAt = new Date().toISOString();

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
    if (dist >= gridStep) {
      const dec = last.close < 0.01 ? 6 : last.close < 1 ? 5 : last.close < 100 ? 4 : 2;
      const tp  = s.mode === 'long'
        ? +(last.close * (1 + tpPct)).toFixed(dec)
        : +(last.close * (1 - tpPct)).toFixed(dec);

      s.positions.push({ entry: last.close, tp, mode: s.mode, openedAt: new Date().toISOString() });
      s.lastActivityAt = new Date().toISOString();

      const emoji = s.mode === 'long' ? '🟢' : '🔴';
      const bigTag = isBigMover ? ' 🔥' : '';
      log(`  ${emoji} OPEN ${sym}  ${s.mode}  entry:${last.close}  tp:${tp}  (${(tpPct*100).toFixed(2)}%${isBigMover?' BIG':''})`);
      await tg(
        `${emoji} <b>${s.mode.toUpperCase()} — ${sym}</b>${bigTag}\n` +
        `📍 Entry: <code>${last.close}</code>\n` +
        `🎯 TP:    <code>${tp}</code>  (+${(tpPct*100).toFixed(2)}%  est. +$${(TRADE_SIZE * tpPct).toFixed(2)})\n` +
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

  // ── Rotate out stale coins (no positions + no activity for STALE_HOURS) ───
  for (const [sym, s] of Object.entries(state)) {
    if (s.positions?.length > 0) continue;
    const ref    = s.lastActivityAt || s.startedAt || 0;
    const idleMs = now - new Date(ref).getTime();
    if (idleMs > STALE_HOURS * 3600 * 1000) {
      log(`  ~ DROP ${sym}  idle ${Math.round(idleMs/3600000)}h  closed P&L: +$${(s.closedPnl||0).toFixed(2)}`);
      await tg(`🔄 <b>Rotated out: ${sym}</b>  (idle ${Math.round(idleMs/3600000)}h)\nClosed P&L: +$${(s.closedPnl||0).toFixed(2)}  |  Slot freed for new mover...`);
      delete state[sym];
    }
  }

  const numActive = Object.values(state).filter(s => s.positions?.length > 0).length;
  const numTracked = Object.keys(state).length;
  log(`── Scan  tracked:${numTracked}  active-pos:${numActive}  slots:${MAX_COINS} ──`);

  // Process coins already in state (change24h not available for existing coins — use 0)
  for (const sym of Object.keys(state)) {
    try {
      const candles = await fetchCandles(sym);
      const savedChange = state[sym]?.change24h || 0;
      await processCoin(sym, candles, state, numActive, savedChange);
    } catch (e) { log(`  ! ${sym}: ${e.message}`); }
    await sleep(400);
  }

  // Always scan for new movers — fill open slots or rotate weakest idle coin
  try {
    const tickers    = await fetchTickers();
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

    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length)
      log(`  Candidates: ${candidates.slice(0,8).map(c => `${c.t.symbol}(${c.score.toFixed(2)})`).join(' ')}`);

    for (const { t, candles, score } of candidates) {
      const liveTracked = Object.keys(state).length;

      if (liveTracked < MAX_COINS) {
        await processCoin(t.symbol, candles, state, Object.values(state).filter(s => s.positions?.length > 0).length, t.change24h);
        continue;
      }

      // All slots full — rotate out weakest idle coin if new one is meaningfully better
      const idleCoins = Object.entries(state)
        .filter(([, s]) => !s.positions?.length)
        .sort((a, b) => (a[1].trendScore || 0) - (b[1].trendScore || 0));

      if (!idleCoins.length) break;  // every slot has open positions — can't rotate

      const [weakSym, weakS] = idleCoins[0];
      if (score > (weakS.trendScore || 0) + 0.08) {
        log(`  ↕ Rotate: drop ${weakSym}(score:${(weakS.trendScore||0).toFixed(2)}) → add ${t.symbol}(score:${score.toFixed(2)})`);
        await tg(`↕ <b>Rotation</b>: dropped ${weakSym} → scanning <b>${t.symbol}</b>\n(better trend score: ${(score*100).toFixed(0)} vs ${((weakS.trendScore||0)*100).toFixed(0)})\nClosed P&L ${weakSym}: +$${(weakS.closedPnl||0).toFixed(2)}`);
        delete state[weakSym];
        await processCoin(t.symbol, candles, state, Object.values(state).filter(s => s.positions?.length > 0).length, t.change24h);
      }
    }
  } catch (e) { log(`  ! ticker scan: ${e.message}`); }

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

  const users = await loadUsers();
  log(`  Registered users: ${users.length}  [${users.join(', ')}]`);
  await tg(
    '🤖 <b>Altcoin Grid Bot — STARTED</b>\n\n' +
    `📦 $${TRADE_SIZE}/position  |  EMA${EMA_FAST}/${EMA_SLOW} grid  |  15min scans\n` +
    `🎯 Normal coins: TP +0.67%  |  Big movers (>10% 24H): TP +5%\n` +
    `🔍 Max ${MAX_COINS} coins  |  Max ${MAX_POSITIONS} pos/coin\n\n` +
    `Commands: <b>status</b> → open trades & P&L\n<b>help</b> → all commands\n\n` +
    `<i>If you stopped receiving signals, send /start to re-register.</i>`
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
