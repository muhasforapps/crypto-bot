/**
 * Altcoin Grid Paper Trader
 * - Fetches real live prices from Bybit public API (no auth needed)
 * - EMA20/50 directional grid: LONG when fast>slow, SHORT when fast<slow
 * - $200 paper per position, max 4 positions per coin, max 3 coins
 * - Telegram alerts + status command
 * - State saved to paper-state.json
 */

require('dotenv').config();
const axios   = require('axios');
const fs      = require('fs');
const http    = require('http');
const crypto  = require('crypto');

// Keep-alive HTTP server so Render doesn't spin down the service
http.createServer((req, res) => {
  const state = loadState();
  const total = Object.values(state).reduce((s, v) => s + (v.closedPnl || 0), 0);
  const coins = Object.keys(state).join(', ') || 'none';
  res.writeHead(200);
  res.end(`Altcoin Paper Bot running\nClosed P&L: +$${total.toFixed(2)}\nTracking: ${coins}`);
}).listen(process.env.PORT || 3000, () => {
  log(`Health server on port ${process.env.PORT || 3000}`);
  if (LIVE_TRADING) log('🔴 LIVE TRADING — real Bybit orders will be placed');
  else log('📝 Paper mode — set LIVE_TRADING=true in .env to go live');
});

// ── Config ────────────────────────────────────────────────────────────────────
const TRADE_SIZE     = 200;
const MAX_POSITIONS  = 4;
const MAX_COINS      = 6;
const CYCLE_GAP      = 0.02;
const TP_PCT         = CYCLE_GAP / 3;   // 0.67% default TP
const GRID_STEP      = 0.005;           // 0.5% default grid step
const BIG_MOVE_PCT   = 10;              // if |24H change| > 10% → use wider TP
const TP_BIG         = 0.05;            // 5% TP for big movers (10-30%)
const GRID_BIG       = 0.01;            // 1% grid step for big movers
const SCANNER_PCT    = 30;              // if change24h >= 30% → scanner SHORT mode
const TP_SCANNER     = 0.10;           // 10% TP for scanner shorts (big pumpers)
const GRID_SCANNER   = 0.02;           // 2% grid for scanner shorts
const EMA_FAST       = 20;
const EMA_SLOW       = 50;
const MIN_EMA_SEP    = 0.004;
const SWITCH_COOL_MS = 4 * 60 * 60 * 1000;
const SCAN_MS        = 15 * 60 * 1000;
const MIN_VOL_USD    = 20_000_000;
const MIN_CHANGE     = 1.5;
const MIN_TREND_SCORE = 0.62;

// Short preference — dump is inevitable after every pump
const SHORT_PREFERENCE   = true;   // bias toward shorts across all decisions
const PUMP_SHORT_PCT     = 5;      // coin pumped ≥5% today → force SHORT entry immediately
const LONG_MIN_EMA_SEP   = 0.008;  // only go LONG if EMA separation is very strong (0.8%)
const STALE_HOURS    = 8;
const STATE_FILE     = './paper-state.json';
const TRADES_FILE    = './trades.csv';
const BASE           = 'https://api.bybit.com';
const HEADERS        = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// Live trading — set LIVE_TRADING=true in .env to place real orders
const LIVE_TRADING = process.env.LIVE_TRADING === 'true'
  && !!process.env.BYBIT_API_KEY && !!process.env.BYBIT_API_SECRET;
const LEVERAGE     = parseInt(process.env.LEVERAGE || '1', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);

// ── Trade CSV logger ──────────────────────────────────────────────────────────
function logTrade({ symbol, type, direction, entry, exit, pnl, coinTotalPnl }) {
  const header = 'timestamp,symbol,type,direction,entry,exit,pnl,coin_total_pnl\n';
  const row    = [
    new Date().toISOString().slice(0, 19).replace('T', ' '),
    symbol,
    type,           // tp | switch
    direction,      // long | short
    entry,
    exit,
    pnl.toFixed(4),
    coinTotalPnl.toFixed(4),
  ].join(',') + '\n';

  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, header);
  fs.appendFileSync(TRADES_FILE, row);
}

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

const TG_TAG = '📝 [PAPER] ';   // prefix so messages are distinct from the Hyro live bot

// Send to one specific chat
async function tgOne(chatId, msg) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: TG_TAG + msg, parse_mode: 'HTML' }, { timeout: 8000 });
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
      if (text === 'trades' || text === 'log') await sendTradesSummary(fromId);
      if (text === 'pumpstatus' || text === 'pump') await pdSendStatus(fromId);
      if (text === 'pumptrades') await pdSendTrades(fromId);
      if (text.startsWith('metrics') || text.startsWith('check')) {
        const sym = (text.split(' ')[1] || '').toUpperCase().replace('USDT','') + 'USDT';
        if (sym.length > 4) {
          await tgOne(fromId, `Fetching metrics for ${sym}...`);
          const m = await fetchShortMetrics(sym);
          const g = shortGate(m);
          const verdict = g.safe ? '✅ SAFE TO SHORT' : `🚫 BLOCKED: ${g.vetoes[0]}`;
          await tgOne(fromId,
            `📊 <b>${sym} Short Metrics</b>\n\n` +
            `${g.line}\n\n` +
            `${verdict}` +
            (g.warnings.length ? `\n⚠️ ${g.warnings.join('\n⚠️ ')}` : '')
          );
        } else {
          await tgOne(fromId, 'Usage: <b>metrics BTCUSDT</b>');
        }
      }
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
          'Commands:\n<b>status</b> — grid positions & P&L\n' +
          '<b>trades</b> — grid all-time breakdown\n' +
          '<b>pump</b> / <b>pumpstatus</b> — pump-dump short positions\n' +
          '<b>pumptrades</b> — pump-dump trade history\n' +
          '<b>metrics BTCUSDT</b> — funding, order book, OI, L/S for any coin\n' +
          '<b>stop</b> — unsubscribe\n' +
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
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000') && !t.symbol.includes('USDC'))
    .map(t => ({
      symbol:    t.symbol,
      change24h: parseFloat(t.price24hPcnt) * 100,
      vol24h:    parseFloat(t.turnover24h),
    }))
    .filter(t => t.vol24h >= MIN_VOL_USD && Math.abs(t.change24h) >= MIN_CHANGE)
    // Short preference: pumped coins first (prime dump candidates), then big fallers
    .sort((a, b) => SHORT_PREFERENCE
      ? b.change24h - a.change24h          // highest positive movers first
      : Math.abs(b.change24h) - Math.abs(a.change24h));
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

// ── Short entry metrics: funding rate + order book + OI + L/S ratio ──────────
async function fetchShortMetrics(symbol) {
  const m = { fundingRate: null, obRatio: null, oiChange4h: null, lsRatio: null };
  try {
    // Funding rate (piggybacks on ticker call — free)
    const tk = await axios.get(
      `${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`,
      { timeout: 8000, headers: HEADERS });
    const t = tk.data.result?.list?.[0];
    if (t) m.fundingRate = parseFloat(t.fundingRate || 0);
    await sleep(200);

    // Order book ask/bid ratio
    const ob = await axios.get(
      `${BASE}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=50`,
      { timeout: 8000, headers: HEADERS });
    if (ob.data.retCode === 0) {
      const bids = (ob.data.result.b || []).map(([p, q]) => [+p, +q]);
      const asks = (ob.data.result.a || []).map(([p, q]) => [+p, +q]);
      const ref  = bids[0]?.[0] || 0;
      const lo   = ref * 0.97, hi = ref * 1.03;
      let bv = bids.filter(([p]) => p >= lo && p <= hi).reduce((s, [, q]) => s + q, 0);
      let av = asks.filter(([p]) => p >= lo && p <= hi).reduce((s, [, q]) => s + q, 0);
      if (bv + av === 0) {                         // nothing in range — use full book
        bv = bids.reduce((s, [, q]) => s + q, 0);
        av = asks.reduce((s, [, q]) => s + q, 0);
      }
      m.obRatio = bv > 0 ? +(av / bv).toFixed(2) : 9.9;
    }
    await sleep(200);

    // OI trend over 4 hours
    const oi = await axios.get(
      `${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=5`,
      { timeout: 8000, headers: HEADERS });
    const oiList = oi.data.result?.list || [];
    if (oiList.length >= 4) {
      const now4 = parseFloat(oiList[0].openInterest);
      const ago4 = parseFloat(oiList[3].openInterest);
      m.oiChange4h = +((now4 - ago4) / ago4 * 100).toFixed(2);
    }
    await sleep(200);

    // Long/short account ratio
    const ls = await axios.get(
      `${BASE}/v5/market/account-ratio?category=linear&symbol=${symbol}&period=1h&limit=1`,
      { timeout: 8000, headers: HEADERS });
    const lsList = ls.data.result?.list || [];
    if (lsList.length) m.lsRatio = +parseFloat(lsList[0].buyRatio).toFixed(3);

  } catch (e) { log(`  [metrics] ${symbol}: ${e.message}`); }
  return m;
}

// ── Live trading helpers ──────────────────────────────────────────────────────
async function bybitAuth(method, endpoint, params = {}) {
  const key    = process.env.BYBIT_API_KEY;
  const secret = process.env.BYBIT_API_SECRET;
  const ts     = Date.now().toString();
  const recv   = '5000';

  let toSign, cfg;
  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    toSign   = ts + key + recv + qs;
    cfg      = { method: 'GET', url: BASE + endpoint, params, timeout: 10000 };
  } else {
    const body = JSON.stringify(params);
    toSign     = ts + key + recv + body;
    cfg        = { method: 'POST', url: BASE + endpoint, data: params, timeout: 10000 };
  }

  const sig = crypto.createHmac('sha256', secret).update(toSign).digest('hex');
  cfg.headers = {
    ...HEADERS,
    'X-BAPI-API-KEY':       key,
    'X-BAPI-TIMESTAMP':     ts,
    'X-BAPI-SIGN':          sig,
    'X-BAPI-RECV-WINDOW':   recv,
  };

  const res = await axios(cfg);
  if (res.data.retCode !== 0) throw new Error(`Bybit ${res.data.retCode}: ${res.data.retMsg}`);
  return res.data.result;
}

const instrumentCache = {};
async function getInstrument(symbol) {
  if (instrumentCache[symbol]) return instrumentCache[symbol];
  const res = await axios.get(
    `${BASE}/v5/market/instruments-info?category=linear&symbol=${symbol}`,
    { timeout: 8000, headers: HEADERS });
  const info = res.data.result.list[0];
  instrumentCache[symbol] = {
    qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
    minQty:  parseFloat(info.lotSizeFilter.minOrderQty),
  };
  return instrumentCache[symbol];
}

function roundQty(rawQty, inst) {
  const steps = Math.floor(rawQty / inst.qtyStep);
  return +(Math.max(steps * inst.qtyStep, inst.minQty)).toFixed(8);
}

async function liveOpen(symbol, mode, tpPrice) {
  const inst  = await getInstrument(symbol);
  const price = (await fetchCandles(symbol)).at(-1).close;
  const qty   = roundQty(TRADE_SIZE / price, inst);
  const side  = mode === 'long' ? 'Buy' : 'Sell';

  // Set leverage (ignore if already set)
  try {
    await bybitAuth('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol,
      buyLeverage: String(LEVERAGE), sellLeverage: String(LEVERAGE),
    });
  } catch (_) {}

  // Place market order
  await bybitAuth('POST', '/v5/order/create', {
    category: 'linear', symbol, side,
    orderType: 'Market', qty: String(qty), positionIdx: 0,
  });

  // Set TP on position
  await sleep(600);
  try {
    await bybitAuth('POST', '/v5/position/trading-stop', {
      category: 'linear', symbol,
      takeProfit: String(tpPrice), positionIdx: 0,
    });
  } catch (e) { log(`  ! TP set ${symbol}: ${e.message}`); }

  return qty;
}

async function liveGetSize(symbol) {
  try {
    const res = await bybitAuth('GET', '/v5/position/list', { category: 'linear', symbol });
    const pos = (res.list || []).find(p => p.symbol === symbol);
    return pos ? parseFloat(pos.size) : 0;
  } catch { return -1; }
}

// Gate: returns {safe, vetoes[], warnings[], line} — call before any new SHORT entry
function shortGate(m) {
  const vetoes = [], warnings = [];

  if (m.fundingRate !== null) {
    if (m.fundingRate < 0)
      vetoes.push(`funding ${(m.fundingRate*100).toFixed(4)}% negative — shorts crowded`);
    else if (m.fundingRate > 0.001)
      warnings.push(`funding ${(m.fundingRate*100).toFixed(4)}% high — squeeze risk`);
  }

  if (m.oiChange4h !== null && m.oiChange4h > 5.0)
    vetoes.push(`OI +${m.oiChange4h.toFixed(1)}% in 4h — new longs entering`);

  if (m.obRatio !== null && m.obRatio < 0.8)
    warnings.push(`OB ${m.obRatio} — buyers dominating (bids > asks)`);

  if (m.lsRatio !== null && m.lsRatio > 0.65)
    warnings.push(`L/S ${(m.lsRatio*100).toFixed(0)}%/${((1-m.lsRatio)*100).toFixed(0)}% — crowded longs`);

  const frStr  = m.fundingRate  !== null ? `${(m.fundingRate*100).toFixed(4)}%` : 'N/A';
  const obStr  = m.obRatio      !== null ? m.obRatio.toFixed(2)                 : 'N/A';
  const oiStr  = m.oiChange4h   !== null ? `${m.oiChange4h >= 0 ? '+' : ''}${m.oiChange4h.toFixed(1)}%` : 'N/A';
  const lsStr  = m.lsRatio      !== null ? `${(m.lsRatio*100).toFixed(0)}%L / ${((1-m.lsRatio)*100).toFixed(0)}%S` : 'N/A';
  const line   = `Funding: <b>${frStr}</b>  |  OB ask/bid: <b>${obStr}</b>  |  OI 4h: <b>${oiStr}</b>  |  L/S: <b>${lsStr}</b>`;

  return { safe: vetoes.length === 0, vetoes, warnings, line };
}

// ── Trade log summary (from trades.csv) ───────────────────────────────────────
async function sendTradesSummary(replyTo) {
  if (!fs.existsSync(TRADES_FILE)) {
    await tgOne(replyTo, '📋 No trades logged yet — trades.csv is empty.');
    return;
  }

  const lines = fs.readFileSync(TRADES_FILE, 'utf8').trim().split('\n').slice(1); // skip header
  if (!lines.length) { await tgOne(replyTo, '📋 No trades logged yet.'); return; }

  const rows = lines.map(l => {
    const [ts, symbol, type, direction, entry, exit, pnl, coinTotal] = l.split(',');
    return { ts, symbol, type, direction, entry: +entry, exit: +exit, pnl: +pnl };
  });

  const total    = rows.reduce((s, r) => s + r.pnl, 0);
  const wins     = rows.filter(r => r.pnl > 0).length;
  const tpRows   = rows.filter(r => r.type === 'tp');
  const swRows   = rows.filter(r => r.type === 'switch');
  const tpPnl    = tpRows.reduce((s, r) => s + r.pnl, 0);
  const swPnl    = swRows.reduce((s, r) => s + r.pnl, 0);

  // Per-coin breakdown
  const bySymbol = {};
  for (const r of rows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { pnl: 0, n: 0, wins: 0 };
    bySymbol[r.symbol].pnl  += r.pnl;
    bySymbol[r.symbol].n++;
    if (r.pnl > 0) bySymbol[r.symbol].wins++;
  }

  const coinLines = Object.entries(bySymbol)
    .sort((a, b) => b[1].pnl - a[1].pnl)
    .map(([sym, d]) => {
      const wr  = ((d.wins / d.n) * 100).toFixed(0);
      const tag = d.pnl >= 0 ? '🟢' : '🔴';
      return `${tag} ${sym.padEnd(16)} ${d.pnl >= 0 ? '+' : ''}$${d.pnl.toFixed(2).padStart(8)}  ${d.n}tr  WR:${wr}%`;
    });

  const msg =
    `📋 <b>All-Time Trade Log</b>  (${rows.length} trades)\n\n` +
    `💰 <b>Total P&L: ${total >= 0 ? '+' : ''}$${total.toFixed(2)}</b>\n` +
    `✅ TP profits:    +$${tpPnl.toFixed(2)}  (${tpRows.length} trades)\n` +
    `🔄 Switch losses:  $${swPnl.toFixed(2)}  (${swRows.length} trades)\n` +
    `📊 Win rate: ${wins}/${rows.length}  (${(wins/rows.length*100).toFixed(0)}%)\n\n` +
    `<b>Per coin:</b>\n<code>${coinLines.join('\n')}</code>`;

  await tgOne(replyTo, msg);
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
      if (!cur) {
        lines.push(`${emoji} <b>${sym}</b>  ${s.mode.toUpperCase()}  (${s.positions.length} open)  <i>price unavailable</i>`);
        continue;
      }
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
  const emaSep   = Math.abs(e20 - e50) / e50;
  const emaLong  = e20 > e50 && emaSep >= LONG_MIN_EMA_SEP;
  const newMode  = SHORT_PREFERENCE
    ? (emaLong ? 'long' : 'short')
    : (e20 > e50 ? 'long' : 'short');
  const now      = Date.now();

  // Dynamic TP: scanner shorts (>30% pump) get 10% TP, big movers (>10%) get 5%, else 0.67%
  const isScannerShort = change24h >= SCANNER_PCT;
  const isBigMover     = Math.abs(change24h) >= BIG_MOVE_PCT;
  const tpPct          = isScannerShort ? TP_SCANNER : isBigMover ? TP_BIG   : TP_PCT;
  const gridStep       = isScannerShort ? GRID_SCANNER : isBigMover ? GRID_BIG : GRID_STEP;

  // ── Init new coin — only if trend quality score passes ───────────────────
  if (!state[sym]) {
    if (numActive >= MAX_COINS) return;
    const score = calcTrendScore(candles);
    if (score < MIN_TREND_SCORE) {
      log(`  ~ SKIP ${sym}  trend score: ${score.toFixed(2)} < ${MIN_TREND_SCORE}`);
      return;
    }
    const pumpedToday = SHORT_PREFERENCE && change24h >= PUMP_SHORT_PCT;
    const initialMode = pumpedToday ? 'short' : newMode;

    // Before adding as SHORT: run full safety gate
    let gate = { safe: true, vetoes: [], warnings: [], line: '' };
    if (initialMode === 'short') {
      const metrics = await fetchShortMetrics(sym);
      gate = shortGate(metrics);
      if (!gate.safe) {
        log(`  ~ SKIP SHORT ${sym}: ${gate.vetoes.join(' | ')}`);
        return;   // don't add this coin — conditions wrong for short
      }
    }

    state[sym] = {
      mode: initialMode, positions: [], closedPnl: 0,
      trades: 0, wins: 0, lastSwitch: pumpedToday ? Date.now() : 0,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      trendScore: +score.toFixed(2),
      change24h: +change24h.toFixed(2),
    };
    const modeTag = pumpedToday
      ? `SHORT (pumped +${change24h.toFixed(1)}% — dump incoming)`
      : isBigMover ? `${initialMode.toUpperCase()} 🔥 BIG MOVER` : initialMode.toUpperCase();
    log(`  + New coin: ${sym}  ${modeTag}  score:${score.toFixed(2)}  24H:${change24h.toFixed(1)}%  TP:${(tpPct*100).toFixed(2)}%`);
    const warnLine = gate.warnings.length ? `\n⚠️ ${gate.warnings.join(' | ')}` : '';
    await tg(
      `📡 <b>New coin tracked: ${sym}</b>\n` +
      `Direction: <b>${initialMode.toUpperCase()}</b>${isBigMover ? '  🔥 Big mover!' : ''}${pumpedToday ? '  📉 pumped today' : ''}\n` +
      `24H change: ${change24h>=0?'+':''}${change24h.toFixed(1)}%  |  Trend score: ${(score*100).toFixed(0)}/100\n` +
      (gate.line ? `${gate.line}\n` : '') +
      `🎯 TP: ${(tpPct*100).toFixed(2)}%  |  Grid: ${(gridStep*100).toFixed(1)}%\n` +
      `$${TRADE_SIZE}/position  max ${MAX_POSITIONS} positions${warnLine}\n<i>${LIVE_TRADING ? '💸 LIVE trade' : 'Paper trade'}</i>`
    );
  }

  const s = state[sym];

  // ── Check TPs ─────────────────────────────────────────────────────────────
  // In live mode: also detect if Bybit already closed the position (exchange-side TP)
  let liveSize = -1;
  if (LIVE_TRADING && s.positions.length > 0) {
    liveSize = await liveGetSize(sym);
  }

  for (let pi = s.positions.length - 1; pi >= 0; pi--) {
    const pos = s.positions[pi];
    const priceHit  = pos.mode === 'long' ? last.high >= pos.tp : last.low <= pos.tp;
    const exchangeHit = LIVE_TRADING && liveSize === 0;
    if (!priceHit && !exchangeHit) continue;

    const exitPrice = exchangeHit && !priceHit ? pos.tp : pos.tp;
    const pnl = pos.mode === 'long'
      ? (exitPrice - pos.entry) / pos.entry * TRADE_SIZE
      : (pos.entry - exitPrice) / pos.entry * TRADE_SIZE;

    s.closedPnl += pnl;
    s.trades++;
    s.wins++;
    s.positions.splice(pi, 1);
    s.lastActivityAt = new Date().toISOString();

    const liveTag = LIVE_TRADING ? ' 💸' : '';
    logTrade({ symbol: sym, type: 'tp', direction: pos.mode, entry: pos.entry, exit: exitPrice, pnl, coinTotalPnl: s.closedPnl });
    log(`  ✅ TP  ${sym}  ${pos.mode}  entry:${pos.entry}  tp:${exitPrice}  +$${pnl.toFixed(2)}`);
    await tg(
      `✅ <b>TP HIT${liveTag} — ${pos.mode.toUpperCase()} ${sym}</b>\n` +
      `Entry: ${pos.entry}  →  TP: ${exitPrice}\n` +
      `P&L: <b>+$${pnl.toFixed(2)}</b>\n` +
      `Total closed: <b>+$${s.closedPnl.toFixed(2)}</b>  (${s.trades} trades  WR:${(s.wins/s.trades*100).toFixed(0)}%)`
    );
  }

  // ── Mode switch ───────────────────────────────────────────────────────────
  // Short preference: switching TO short has no extra barrier.
  // Switching TO long requires strong EMA separation (already baked into newMode above).
  const switchCool = (newMode === 'short' && SHORT_PREFERENCE)
    ? SWITCH_COOL_MS / 2   // flip to short twice as fast
    : SWITCH_COOL_MS;
  if (s.mode !== newMode && (now - (s.lastSwitch || 0)) >= switchCool) {
    s.mode       = newMode;
    s.lastSwitch = now;
    const openCount = s.positions.length;
    log(`  🔄 SWITCH ${sym} → ${newMode}  (${openCount} positions riding to TP)`);
    await tg(
      `🔄 <b>MODE SWITCH — ${sym}</b>\n` +
      `→ Now <b>${newMode.toUpperCase()}</b>  (EMA20/50 crossed)\n` +
      `${openCount} open position${openCount !== 1 ? 's' : ''} riding to TP — no force-close 🎯`
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

      let liveQty = null;
      if (LIVE_TRADING) {
        try {
          liveQty = await liveOpen(sym, s.mode, tp);
          log(`  💸 LIVE ORDER ${sym} ${s.mode} qty:${liveQty} TP:${tp}`);
        } catch (e) {
          log(`  ! LIVE ORDER failed ${sym}: ${e.message}`);
          await tg(`⚠️ <b>Live order FAILED — ${sym}</b>\n${e.message}\n<i>Skipping position</i>`);
          return;
        }
      }

      s.positions.push({ entry: last.close, tp, mode: s.mode, openedAt: new Date().toISOString(), qty: liveQty });
      s.lastActivityAt = new Date().toISOString();

      const emoji = s.mode === 'long' ? '🟢' : '🔴';
      const bigTag = isBigMover ? ' 🔥' : '';
      const liveTag = LIVE_TRADING ? ' 💸 LIVE' : ' 📝 paper';
      log(`  ${emoji} OPEN ${sym}  ${s.mode}  entry:${last.close}  tp:${tp}  (${(tpPct*100).toFixed(2)}%${isBigMover?' BIG':''})`);
      await tg(
        `${emoji} <b>${s.mode.toUpperCase()} — ${sym}</b>${bigTag}${liveTag}\n` +
        `📍 Entry: <code>${last.close}</code>\n` +
        `🎯 TP:    <code>${tp}</code>  (+${(tpPct*100).toFixed(2)}%  est. +$${(TRADE_SIZE * tpPct).toFixed(2)})\n` +
        `📦 $${TRADE_SIZE}${LIVE_TRADING ? ' REAL' : ' paper'}  |  Pos: ${s.positions.length}/${MAX_POSITIONS}\n` +
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

  // Run pump-dump strategy (separate logic, separate state)
  try { await pdScan(); } catch (e) { log(`  ! pdScan: ${e.message}`); }
}

// ══════════════════════════════════════════════════════════════════════════════
//  PUMP-DUMP SHORT STRATEGY  —  second-pump rejection (separate from EMA grid)
//
//  Pattern: pump → dump → bounce → rejection from lower high → short entry
//  Uses 1h candles. ATR-based stop above second high. Staged exit:
//    Half 1 ($100) closes at TP1 (first low)  — after TP1: stop moves to entry
//    Half 2 ($100) closes at TP2 (85% of TP1) — full retrace target
//
//  Full symbol scan: every PD_SCAN_INTERVAL_H hours (to stay under rate limits)
//  Position monitor: every 15 min (same loop as grid bot)
//  Max 1 open pump-dump short at a time.
// ══════════════════════════════════════════════════════════════════════════════

const PUMP_STATE_FILE     = './pump-state.json';
const PUMP_TRADES_FILE    = './pump-trades.csv';
const PD_HALF_SIZE        = 100;       // $ per half — total risk $200
const PD_MAX_OPEN         = 1;         // max simultaneous pump-dump shorts
const PD_SCAN_INTERVAL_H  = 4;         // hours between full symbol scans
const PD_MIN_SCORE        = 65;        // minimum score to open trade
const PD_TOP_N            = 150;       // symbols to scan each pass
const PD_MIN_VOL          = 1_000_000; // minimum 24h turnover (USDT)
// Detection thresholds (mirror scanner_v2.py)
const PD_MIN_PUMP         = 40;
const PD_MIN_DUMP         = 8;
const PD_MAX_DUMP         = 22;   // tightened from 30 — rejects still-dumping coins
const PD_MIN_BOUNCE       = 25;
const PD_MAX_BOUNCE       = 92;
const PD_MAX_STALE_H      = 72;
const PD_MIN_STOP_PCT     = 2.0;
const PD_MAX_STOP_PCT     = 8.0;  // tightened from 20 — wide stops bleed the account
const PD_MIN_TARGET_PCT   = 5.0;
const PD_MIN_RR           = 1.2;

let pdLastFullScan = 0;

// ── Pump-dump state I/O ───────────────────────────────────────────────────────
function loadPumpState()  { try { return JSON.parse(fs.readFileSync(PUMP_STATE_FILE,'utf8')); } catch { return {}; } }
function savePumpState(s) { fs.writeFileSync(PUMP_STATE_FILE, JSON.stringify(s, null, 2)); }

function logPumpTrade({ symbol, half, type, entry, exit, pnl }) {
  const header = 'timestamp,symbol,half,type,entry,exit,pnl\n';
  const row = [
    new Date().toISOString().slice(0,19).replace('T',' '),
    symbol, half, type,
    entry, exit, pnl.toFixed(4),
  ].join(',') + '\n';
  if (!fs.existsSync(PUMP_TRADES_FILE)) fs.writeFileSync(PUMP_TRADES_FILE, header);
  fs.appendFileSync(PUMP_TRADES_FILE, row);
}

// ── 1h candle fetch ───────────────────────────────────────────────────────────
async function fetchHourlyCandles(symbol, days = 30) {
  const limit = Math.min(days * 24, 720);
  const res = await axios.get(
    `${BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=${limit}`,
    { timeout: 15000, headers: HEADERS }
  );
  if (res.data.retCode !== 0) return [];
  return res.data.result.list
    .map(c => ({ ts: +c[0], open: +c[1], high: +c[2], low: +c[3], close: +c[4], volume: +c[5] }))
    .sort((a, b) => a.ts - b.ts);
}

// ── Indicators (ported from scanner_v2.py) ────────────────────────────────────
function pdATR(bars, period = 14, endIdx = null) {
  if (endIdx === null) endIdx = bars.length - 1;
  const start = Math.max(1, endIdx - period * 2);
  const trs = [];
  for (let i = start; i <= endIdx; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i-1].close),
      Math.abs(bars[i].low  - bars[i-1].close)
    ));
  }
  if (!trs.length) return 0;
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(trs.length, period);
}

function pdSMA(closes, period, idx) {
  if (idx + 1 < period) return null;
  return closes.slice(idx + 1 - period, idx + 1).reduce((a, b) => a + b, 0) / period;
}

function pdRSI(closes, period = 14, idx = null) {
  if (idx === null) idx = closes.length - 1;
  if (idx < period) return null;
  let gains = 0, losses = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

// ── Pattern detection (ported from scanner_v2.py detect()) ───────────────────
function pdDetect(symbol, bars, turnover = 0, endIdx = null) {
  if (endIdx === null) endIdx = bars.length - 1;
  if (endIdx < 150) return null;

  const current = bars[endIdx].close;
  const closes  = bars.slice(0, endIdx + 1).map(b => b.close);
  const volumes = bars.slice(0, endIdx + 1).map(b => b.volume);

  // Find pump peak (last 504 bars = 21 days)
  const lookback = Math.min(504, endIdx);
  let peakIdx = endIdx - lookback;
  for (let i = peakIdx; i <= endIdx; i++) {
    if (bars[i].high > bars[peakIdx].high) peakIdx = i;
  }
  const peakPrice = bars[peakIdx].high;
  if (endIdx - peakIdx < 8) return null;

  // Find base before peak
  const baseLookback = Math.min(504, peakIdx);
  if (baseLookback < 20) return null;
  let baseIdx = peakIdx - baseLookback;
  for (let i = baseIdx; i <= peakIdx; i++) {
    if (bars[i].low < bars[baseIdx].low) baseIdx = i;
  }
  const basePrice = bars[baseIdx].low;
  const pumpPct   = (peakPrice - basePrice) / basePrice * 100;
  if (pumpPct < PD_MIN_PUMP) return null;

  // Find first low after peak (dump with 3% bounce confirmation)
  let runMin = peakPrice, runMinIdx = peakIdx;
  let firstLowIdx = null, firstLowPrice = null;
  for (let i = peakIdx + 1; i <= endIdx; i++) {
    if (bars[i].low < runMin) { runMin = bars[i].low; runMinIdx = i; }
    if (bars[i].close >= runMin * 1.03 && (i - runMinIdx) >= 2) {
      firstLowIdx = runMinIdx; firstLowPrice = runMin; break;
    }
  }
  if (firstLowIdx === null) return null;

  const firstDumpPct = (peakPrice - firstLowPrice) / peakPrice * 100;
  if (firstDumpPct < PD_MIN_DUMP || firstDumpPct > PD_MAX_DUMP) return null;

  if (endIdx - firstLowIdx < 3) return null;

  // Find second high (bounce peak)
  let secHighIdx = firstLowIdx + 1, secHighPrice = bars[firstLowIdx + 1].high;
  for (let i = firstLowIdx + 1; i <= endIdx; i++) {
    if (bars[i].high > secHighPrice) { secHighPrice = bars[i].high; secHighIdx = i; }
  }
  if (secHighPrice >= peakPrice * 0.98) return null;

  const bouncePct = (secHighPrice - firstLowPrice) / (peakPrice - firstLowPrice) * 100;
  if (bouncePct < PD_MIN_BOUNCE || bouncePct > PD_MAX_BOUNCE) return null;

  // Rejection confirmation
  const barsSince = endIdx - secHighIdx;
  if (barsSince > PD_MAX_STALE_H || barsSince < 1) return null;
  if (current >= secHighPrice * 0.99) return null;

  const rejPct = (secHighPrice - current) / secHighPrice * 100;
  if (rejPct < 1.0) return null;

  // ATR-based stop (second high + 1.5 × ATR)
  const atrVal  = pdATR(bars, 14, endIdx);
  const stop    = secHighPrice + 1.5 * atrVal;
  const stopPct = (stop - current) / current * 100;
  if (stopPct < PD_MIN_STOP_PCT || stopPct > PD_MAX_STOP_PCT) return null;

  // Targets
  let tp1;
  if (firstLowPrice <= current * (1 - PD_MIN_TARGET_PCT / 100)) {
    tp1 = firstLowPrice;
  } else {
    tp1 = current - 3 * atrVal;
    if ((current - tp1) / current * 100 < PD_MIN_TARGET_PCT) return null;
  }
  const tp2    = tp1 * 0.85;
  const tp1Pct = (current - tp1) / current * 100;
  const tp2Pct = (current - tp2) / current * 100;

  const rrTp1 = tp1Pct / stopPct;
  const rrTp2 = tp2Pct / stopPct;
  if (rrTp1 < PD_MIN_RR) return null;

  // Quality indicators
  const ma7  = pdSMA(closes, 7,  endIdx);
  const ma14 = pdSMA(closes, 14, endIdx);
  const ma28 = pdSMA(closes, 28, endIdx);
  const bearishMA   = ma7 && ma14 && ma28 && current < ma7 && ma7 < ma14 && ma14 < ma28;
  const rsiVal      = pdRSI(closes, 14, endIdx);
  const peakVol     = volumes.slice(Math.max(0,peakIdx-8), peakIdx+8).reduce((a,b)=>a+b,0) / 16;
  const bounceVol   = volumes.slice(Math.max(0,secHighIdx-8), secHighIdx+8).reduce((a,b)=>a+b,0) / 16;
  const weakBounce  = bounceVol < peakVol * 0.65;

  // Score (mirrors scanner_v2.py)
  let score = 0;
  score += pumpPct >= 150 ? 20 : pumpPct >= 100 ? 16 : pumpPct >= 60 ? 12 : 8;
  score += (firstDumpPct >= 12 && firstDumpPct <= 22) ? 15 : (firstDumpPct >= 8 && firstDumpPct <= 27) ? 10 : 5;
  score += (bouncePct >= 38 && bouncePct <= 62) ? 15 : (bouncePct >= 30 && bouncePct <= 78) ? 10 : 5;
  score += barsSince <= 6 ? 15 : barsSince <= 12 ? 12 : barsSince <= 24 ? 8 : 4;
  score += rrTp1 >= 2.0 ? 15 : rrTp1 >= 1.5 ? 12 : 8;
  if (bearishMA)  score += 8;
  if (weakBounce) score += 7;
  if (rsiVal !== null && rsiVal < 45) score += 5;
  if (turnover >= 10_000_000) score += 5; else if (turnover >= 3_000_000) score += 3;

  return {
    symbol, score,
    pumpPct, firstDumpPct, bouncePct, barsSince, rejPct,
    bearishMA, rsi: rsiVal, weakBounce,
    entry: current, stop, stopPct, tp1, tp2, tp1Pct, tp2Pct, rrTp1, rrTp2,
    secHighPrice,
  };
}

// ── Safety gate before opening (funding rate + OI + time) ────────────────────
async function pdSafetyCheck(symbol) {
  const reasons = [];

  // Time gate: no trades 00:00-06:00 UTC
  const hour = new Date().getUTCHours();
  if (hour >= 0 && hour < 6) reasons.push('no trading 00:00-06:00 UTC');

  try {
    // Funding rate
    const tkRes = await axios.get(
      `${BASE}/v5/market/tickers?category=linear&symbol=${symbol}`,
      { timeout: 8000, headers: HEADERS });
    const t = tkRes.data.result?.list?.[0];
    if (t) {
      const fr = parseFloat(t.fundingRate || 0);
      if (fr < 0) reasons.push(`funding ${(fr*100).toFixed(4)}% negative — longs being paid`);
    }
    await sleep(200);

    // OI trend
    const oiRes = await axios.get(
      `${BASE}/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1h&limit=5`,
      { timeout: 8000, headers: HEADERS });
    const oiList = oiRes.data.result?.list || [];
    if (oiList.length >= 4) {
      const oiNow = parseFloat(oiList[0].openInterest);
      const oi4h  = parseFloat(oiList[3].openInterest);
      const chg   = (oiNow - oi4h) / oi4h * 100;
      if (chg > 5.0) reasons.push(`OI +${chg.toFixed(1)}% in 4h — squeeze risk`);
    }
  } catch (e) {
    log(`  [PD] safety check error ${symbol}: ${e.message}`);
  }

  return { safe: reasons.length === 0, reasons };
}

// ── Monitor open pump-dump positions every cycle ──────────────────────────────
async function pdMonitorPositions(state) {
  const open = Object.entries(state)
    .filter(([, s]) => s.status === 'open' || s.status === 'tp1_hit');
  if (!open.length) return;

  for (const [symbol, s] of open) {
    try {
      const bars = await fetchHourlyCandles(symbol, 1);  // just last 24h is enough
      if (!bars.length) continue;
      const last = bars[bars.length - 1];

      // After TP1, stop moves to entry (breakeven)
      const activeStop = s.status === 'tp1_hit' ? s.signal.entry : s.signal.stop;

      // Check stop
      if (last.high >= activeStop) {
        const half1Pnl = s.half1.open ? (s.signal.entry - activeStop) / s.signal.entry * PD_HALF_SIZE : 0;
        const half2Pnl = s.half2.open ? (s.signal.entry - activeStop) / s.signal.entry * PD_HALF_SIZE : 0;
        const totalPnl = half1Pnl + half2Pnl;
        s.closedPnl += totalPnl;
        if (s.half1.open) logPumpTrade({ symbol, half: 1, type: 'stop', entry: s.signal.entry, exit: activeStop, pnl: half1Pnl });
        if (s.half2.open) logPumpTrade({ symbol, half: 2, type: 'stop', entry: s.signal.entry, exit: activeStop, pnl: half2Pnl });
        s.half1.open = s.half2.open = false;
        s.status = 'closed';
        s.closeReason = 'stop';
        savePumpState(state);
        log(`  [PD] STOP ${symbol} pnl:${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
        await tg(
          `🛑 <b>[PUMP-DUMP] STOP HIT — ${symbol}</b>\n` +
          `Entry: ${s.signal.entry}  Stop: ${activeStop.toFixed(6)}\n` +
          `P&amp;L: <b>${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}</b>  (closed ${s.status === 'tp1_hit' ? 'at breakeven' : 'at loss'})\n` +
          `<i>Paper trade</i>`
        );
        continue;
      }

      // Check TP1 (half 1)
      if (s.half1.open && last.low <= s.signal.tp1) {
        const pnl = (s.signal.entry - s.signal.tp1) / s.signal.entry * PD_HALF_SIZE;
        s.half1.open = false;
        s.closedPnl += pnl;
        s.status = 'tp1_hit';
        logPumpTrade({ symbol, half: 1, type: 'tp1', entry: s.signal.entry, exit: s.signal.tp1, pnl });
        savePumpState(state);
        log(`  [PD] TP1 ${symbol} +$${pnl.toFixed(2)} — stop -> breakeven`);
        await tg(
          `✅ <b>[PUMP-DUMP] TP1 HIT — ${symbol}</b>\n` +
          `Entry: ${s.signal.entry}  TP1: ${s.signal.tp1.toFixed(6)}\n` +
          `Half 1 P&amp;L: <b>+$${pnl.toFixed(2)}</b>\n` +
          `Stop moved to breakeven (${s.signal.entry}).\n` +
          `Targeting TP2: <code>${s.signal.tp2.toFixed(6)}</code>  (-${s.signal.tp2Pct.toFixed(1)}%)\n` +
          `<i>Paper trade</i>`
        );
      }

      // Check TP2 (half 2) — only after TP1 is closed
      if (!s.half1.open && s.half2.open && last.low <= s.signal.tp2) {
        const pnl = (s.signal.entry - s.signal.tp2) / s.signal.entry * PD_HALF_SIZE;
        s.half2.open = false;
        s.closedPnl += pnl;
        s.status = 'closed';
        s.closeReason = 'tp2';
        logPumpTrade({ symbol, half: 2, type: 'tp2', entry: s.signal.entry, exit: s.signal.tp2, pnl });
        savePumpState(state);
        log(`  [PD] TP2 ${symbol} +$${pnl.toFixed(2)} — trade complete`);
        await tg(
          `🎯 <b>[PUMP-DUMP] TP2 HIT — ${symbol}</b>\n` +
          `Half 2 P&amp;L: <b>+$${pnl.toFixed(2)}</b>\n` +
          `Total trade P&amp;L: <b>+$${s.closedPnl.toFixed(2)}</b>\n` +
          `<i>Paper trade</i>`
        );
      }

    } catch (e) { log(`  [PD] monitor error ${symbol}: ${e.message}`); }
    await sleep(400);
  }
}

// ── Status and trade history commands ────────────────────────────────────────
async function pdSendStatus(replyTo) {
  const state = loadPumpState();
  const all   = Object.entries(state);
  if (!all.length) { await tgOne(replyTo, '[PUMP-DUMP] No trades on record yet.'); return; }

  const lines = ['📊 <b>Pump-Dump Short Status</b>\n'];
  let totalClosed = 0;

  for (const [sym, s] of all) {
    totalClosed += s.closedPnl || 0;
    const sig = s.signal;
    if (s.status === 'open' || s.status === 'tp1_hit') {
      const stopLabel = s.status === 'tp1_hit' ? `${sig.entry} (BE)` : sig.stop.toFixed(6);
      lines.push(
        `🔴 <b>${sym}</b>  OPEN SHORT\n` +
        `   Entry: ${sig.entry}  |  Stop: ${stopLabel}\n` +
        `   TP1: ${sig.tp1.toFixed(6)} ${s.half1.open ? '(open)' : '✅ hit'}\n` +
        `   TP2: ${sig.tp2.toFixed(6)} ${s.half2.open ? '(open)' : '✅ hit'}\n` +
        `   Score: ${sig.score}/105  |  R:R 1:${sig.rrTp1.toFixed(2)}\n`
      );
    } else {
      const tag = s.closeReason === 'tp2' ? '✅' : s.closeReason === 'stop' ? '🛑' : '⏹';
      lines.push(`${tag} <b>${sym}</b>  ${s.closeReason?.toUpperCase() || 'CLOSED'}  P&amp;L: ${s.closedPnl >= 0 ? '+' : ''}$${s.closedPnl.toFixed(2)}`);
    }
  }

  lines.push(`\n💰 <b>Total P&amp;L: ${totalClosed >= 0 ? '+' : ''}$${totalClosed.toFixed(2)}</b>`);
  await tgOne(replyTo, lines.join('\n'));
}

async function pdSendTrades(replyTo) {
  if (!fs.existsSync(PUMP_TRADES_FILE)) { await tgOne(replyTo, '[PUMP-DUMP] No trades logged yet.'); return; }
  const lines = fs.readFileSync(PUMP_TRADES_FILE,'utf8').trim().split('\n').slice(1);
  if (!lines.length) { await tgOne(replyTo, '[PUMP-DUMP] No trades logged yet.'); return; }

  const rows  = lines.map(l => { const [ts,sym,half,type,,, pnl] = l.split(','); return { ts, sym, half, type, pnl: +pnl }; });
  const total = rows.reduce((s,r) => s + r.pnl, 0);
  const wins  = rows.filter(r => r.pnl > 0).length;

  const bySymbol = {};
  for (const r of rows) {
    if (!bySymbol[r.sym]) bySymbol[r.sym] = { pnl: 0, n: 0 };
    bySymbol[r.sym].pnl += r.pnl;
    bySymbol[r.sym].n++;
  }

  const coinLines = Object.entries(bySymbol)
    .sort((a,b) => b[1].pnl - a[1].pnl)
    .map(([sym,d]) => `${d.pnl>=0?'🟢':'🔴'} ${sym.padEnd(14)} ${d.pnl>=0?'+':''}$${d.pnl.toFixed(2).padStart(8)}  (${d.n} half-fills)`);

  await tgOne(replyTo,
    `📋 <b>Pump-Dump Trade History</b>  (${rows.length} fills)\n\n` +
    `💰 <b>Total: ${total>=0?'+':''}$${total.toFixed(2)}</b>   Win rate: ${wins}/${rows.length}  (${(wins/rows.length*100).toFixed(0)}%)\n\n` +
    `<b>Per coin:</b>\n<code>${coinLines.join('\n')}</code>`
  );
}

// ── Main pump-dump scan (called from scan() every 15 min) ────────────────────
async function pdScan() {
  const state = loadPumpState();
  const now   = Date.now();

  // Always monitor open positions first
  await pdMonitorPositions(state);

  // Skip full scan if already at max positions
  const openCount = Object.values(state).filter(s => s.status === 'open' || s.status === 'tp1_hit').length;
  if (openCount >= PD_MAX_OPEN) {
    log(`  [PD] ${openCount}/${PD_MAX_OPEN} positions open — monitoring only`);
    return;
  }

  // Full symbol scan only every PD_SCAN_INTERVAL_H hours
  const msSinceLastScan = now - pdLastFullScan;
  if (msSinceLastScan < PD_SCAN_INTERVAL_H * 3600 * 1000) {
    const minsLeft = Math.ceil((PD_SCAN_INTERVAL_H * 3600 * 1000 - msSinceLastScan) / 60000);
    log(`  [PD] next full scan in ${minsLeft}min`);
    return;
  }

  pdLastFullScan = now;
  log(`  [PD] starting full scan (top ${PD_TOP_N} symbols)...`);

  // Fetch symbol list
  let symbols = [];
  try {
    const res = await axios.get(`${BASE}/v5/market/tickers?category=linear`, { timeout: 10000, headers: HEADERS });
    symbols = (res.data.result?.list || [])
      .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000') && !t.symbol.includes('USDC'))
      .map(t => ({ symbol: t.symbol, vol: parseFloat(t.turnover24h) }))
      .filter(t => t.vol >= PD_MIN_VOL)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, PD_TOP_N);
  } catch (e) { log(`  [PD] ticker fetch error: ${e.message}`); return; }

  const candidates = [];

  for (const { symbol, vol } of symbols) {
    // Skip symbols that already have an active position
    const existing = state[symbol];
    if (existing && (existing.status === 'open' || existing.status === 'tp1_hit')) continue;

    await sleep(300);  // 300ms between calls — stays under rate limit

    try {
      const bars = await fetchHourlyCandles(symbol, 30);
      if (bars.length < 150) continue;
      const sig = pdDetect(symbol, bars, vol);
      if (sig && sig.score >= PD_MIN_SCORE) {
        candidates.push({ symbol, vol, sig });
        log(`  [PD] match: ${symbol}  score:${sig.score}  R:R:${sig.rrTp1.toFixed(2)}  entry:${sig.entry}`);
      }
    } catch (e) { log(`  [PD] ${symbol}: ${e.message}`); }
  }

  log(`  [PD] scan complete. ${candidates.length} candidate(s) found.`);
  if (!candidates.length) return;

  // Pick highest-scoring signal
  candidates.sort((a, b) => b.sig.score - a.sig.score);
  const { symbol, sig } = candidates[0];

  // Safety check
  const safety = await pdSafetyCheck(symbol);
  if (!safety.safe) {
    log(`  [PD] blocked ${symbol}: ${safety.reasons.join(', ')}`);
    await tg(
      `⚠️ <b>[PUMP-DUMP] Signal blocked — ${symbol}</b>\n` +
      `Score: ${sig.score}  R:R: 1:${sig.rrTp1.toFixed(2)}\n` +
      `Blocked: ${safety.reasons.join(' | ')}\n<i>Paper trade</i>`
    );
    // Keep scanning next candidates if any
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      const s2 = await pdSafetyCheck(c.symbol);
      if (s2.safe) { Object.assign(sig, c.sig); Object.assign({ symbol }, { symbol: c.symbol }); break; }
    }
    return;
  }

  // Open the trade
  state[symbol] = {
    status:    'open',
    openedAt:  new Date().toISOString(),
    signal:    sig,
    half1:     { open: true },
    half2:     { open: true },
    closedPnl: 0,
  };
  savePumpState(state);

  const dec = sig.entry < 0.01 ? 6 : sig.entry < 1 ? 5 : sig.entry < 100 ? 4 : 2;
  log(`  [PD] OPEN SHORT ${symbol}  entry:${sig.entry}  stop:${sig.stop.toFixed(dec)}  tp1:${sig.tp1.toFixed(dec)}  tp2:${sig.tp2.toFixed(dec)}`);
  await tg(
    `🎯 <b>[PUMP-DUMP] SHORT SIGNAL — ${symbol}</b>\n\n` +
    `Score: <b>${sig.score}/105</b>  |  R:R: <b>1:${sig.rrTp1.toFixed(2)}</b>\n\n` +
    `📍 Entry:  <code>${sig.entry}</code>\n` +
    `🛑 Stop:   <code>${sig.stop.toFixed(dec)}</code>  (+${sig.stopPct.toFixed(1)}%)\n` +
    `🎯 TP1:    <code>${sig.tp1.toFixed(dec)}</code>  (-${sig.tp1Pct.toFixed(1)}%)  [close 50%]\n` +
    `🎯 TP2:    <code>${sig.tp2.toFixed(dec)}</code>  (-${sig.tp2Pct.toFixed(1)}%)  [close 50%]\n\n` +
    `Pattern:\n` +
    `  Pump +${sig.pumpPct.toFixed(1)}%  |  Dump -${sig.firstDumpPct.toFixed(1)}%  |  Bounce ${sig.bouncePct.toFixed(0)}%  |  2nd high ${sig.barsSince}h ago\n` +
    `  Bearish MA: ${sig.bearishMA ? 'yes' : 'no'}  |  Weak bounce vol: ${sig.weakBounce ? 'yes' : 'no'}\n\n` +
    `$${PD_HALF_SIZE * 2} paper  ($${PD_HALF_SIZE} × 2 halves)\n<i>Paper trade</i>`
  );
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
