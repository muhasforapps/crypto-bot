/**
 * HyroTrader Challenge Grid Bot  (LIVE — Bybit subaccount)
 * ────────────────────────────────────────────────────────────────────────────
 * Trades a Bybit subaccount provided by HyroTrader (real api.bybit.com, different key).
 * Reuses the EMA20/50 bidirectional grid logic from altcoin-paper-bot.js, but adds
 * a strict CHALLENGE RISK LAYER so it never breaches the prop-firm rules.
 *
 * CHALLENGE RULES (2-step, $10,000):
 *   - Phase 1: +10% profit  →  Phase 2: +5% more
 *   - Daily drawdown limit:  5%  (peak-of-day equity − lowest equity after peak, incl. unrealized)
 *   - Max loss limit:        10% (from initial balance)
 *   - Stop loss REQUIRED on every position
 *
 * RISK GUARDS (with safety buffers — we never let it touch the real limit):
 *   - New entries HALT when daily drawdown reaches 4%  (buffer before 5% breach)
 *   - FLATTEN ALL + halt for the day when daily drawdown reaches 4.5%
 *   - FLATTEN ALL + STOP BOT when account down 9%       (buffer before 10% breach)
 *   - HALT + notify when +10% profit target reached     (don't give it back)
 *   - 3% hard stop loss on every position (set on the Bybit position)
 *
 * Risk profile: MODERATE — 4 coins, ~$500 notional/position, 3x leverage.
 *
 * ENV VARS (.env):
 *   HYRO_API_KEY=           # Bybit subaccount key from HyroTrader
 *   HYRO_API_SECRET=
 *   HYRO_INITIAL_BALANCE=10000
 *   TELEGRAM_TOKEN=         # reuse existing
 *   TELEGRAM_CHAT_ID=
 *
 * Run:  node hyro-bot.js
 */

require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const fs     = require('fs');
const http   = require('http');

// ── Config ──────────────────────────────────────────────────────────────────
const INITIAL_BALANCE = parseFloat(process.env.HYRO_INITIAL_BALANCE) || 10000;

// Position sizing (MODERATE)
const TRADE_NOTIONAL  = 500;     // USDT notional per grid position
const LEVERAGE        = 3;
const MAX_POSITIONS   = 4;       // grid levels per coin
const MAX_COINS       = 4;

// Grid / TP
const TP_PCT          = 0.0067;  // 0.67% TP for normal coins
const TP_BIG          = 0.05;    // 5% TP for big movers (>10% 24h)
const GRID_STEP       = 0.005;   // 0.5% min gap between grid entries
const GRID_BIG        = 0.01;    // 1% gap for big movers
const BIG_MOVE_PCT    = 10;
const STOP_LOSS_PCT   = 0.03;    // 3% hard SL on every position (REQUIRED)

// EMA / trend
const EMA_FAST        = 20;
const EMA_SLOW        = 50;
const MIN_EMA_SEP     = 0.004;
const SWITCH_COOL_MS  = 4 * 60 * 60 * 1000;
const MIN_TREND_SCORE = 0.62;

// Challenge risk thresholds (fractions of INITIAL_BALANCE)
const DAILY_DD_LIMIT  = 0.05;    // hard breach
const DAILY_DD_HALT   = 0.04;    // stop opening new positions
const DAILY_DD_FLAT   = 0.045;   // flatten everything + halt for the day
const MAX_LOSS_LIMIT  = 0.10;    // hard breach
const MAX_LOSS_FLAT   = 0.09;    // flatten + stop bot entirely
const PROFIT_TARGET   = 0.10;    // phase-1 target → halt + notify
// Profit lock — stop the bot the moment realized+unrealized profit reaches this
// dollar amount. Protects gains from being given back. Configurable via env.
const PROFIT_LOCK_USD = parseFloat(process.env.HYRO_PROFIT_LOCK_USD) || 150;

// Scan timing
const SCAN_MS         = 15 * 60 * 1000;   // full grid scan
const RISK_MS         = 60 * 1000;        // lightweight equity/risk check
const MIN_VOL_USD     = 20_000_000;
const MIN_CHANGE      = 1.5;
const STALE_HOURS     = 8;

const STATE_FILE      = './hyro-state.json';
const TRADES_FILE     = './hyro-trades.csv';
// HyroTrader runs on Bybit DEMO trading — demo keys are rejected by mainnet api.bybit.com.
// Override with HYRO_BASE_URL in .env if they ever move you to mainnet.
const BASE            = process.env.HYRO_BASE_URL || 'https://api-demo.bybit.com';
const RW              = '5000';
const HEADERS         = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);

// ── Bybit signed API (HyroTrader subaccount) ──────────────────────────────────
const api = axios.create({ baseURL: BASE, timeout: 15000, headers: HEADERS });

function sign(payload) {
  const ts  = String(Date.now());
  const key = process.env.HYRO_API_KEY;
  const raw = ts + key + RW + payload;
  const sig = crypto.createHmac('sha256', process.env.HYRO_API_SECRET).update(raw).digest('hex');
  return { 'X-BAPI-API-KEY': key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': RW };
}

async function privGet(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const res = await api.get(path + (qs ? '?' + qs : ''), { headers: sign(qs) });
  if (res.data.retCode !== 0) throw new Error(`GET ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

async function privPost(path, body = {}) {
  const str = JSON.stringify(body);
  const res = await api.post(path, body, { headers: { ...sign(str), 'Content-Type': 'application/json' } });
  if (res.data.retCode !== 0) throw new Error(`POST ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

// ── Account / market ──────────────────────────────────────────────────────────
// Total equity INCLUDING unrealized PnL — this is what the challenge measures.
async function getEquity() {
  const r = await privGet('/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  const acct = r.list?.[0];
  return parseFloat(acct?.totalEquity || acct?.totalWalletBalance || 0);
}

async function getInstrument(symbol) {
  const res = await api.get('/v5/market/instruments-info', { params: { category: 'linear', symbol } });
  return res.data.result.list[0];
}

async function getPosition(symbol) {
  const r = await privGet('/v5/position/list', { category: 'linear', symbol });
  return (r.list || []).filter(p => parseFloat(p.size) > 0);
}

async function setLeverage(symbol, lev) {
  try {
    await privPost('/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: String(lev), sellLeverage: String(lev),
    });
  } catch (e) { if (!/leverage not modified/i.test(e.message)) log(`  ! setLeverage ${symbol}: ${e.message}`); }
}

// Market entry (one-way mode, positionIdx 0). side: 'Buy' (long) | 'Sell' (short)
async function marketEntry(symbol, side, qty, slPrice) {
  return privPost('/v5/order/create', {
    category: 'linear', symbol, side, orderType: 'Market',
    qty: String(qty), timeInForce: 'IOC', positionIdx: 0,
    stopLoss: String(slPrice), slTriggerBy: 'MarkPrice',
  });
}

// Reduce-only limit TP (opposite side of the position)
async function placeTP(symbol, posSide, qty, tpPrice) {
  const side = posSide === 'long' ? 'Sell' : 'Buy';
  return privPost('/v5/order/create', {
    category: 'linear', symbol, side, orderType: 'Limit',
    qty: String(qty), price: String(tpPrice),
    reduceOnly: true, timeInForce: 'GTC', positionIdx: 0,
  });
}

// Update the position-level stop loss (covers full position from avg entry)
async function setStop(symbol, slPrice) {
  return privPost('/v5/position/trading-stop', {
    category: 'linear', symbol, positionIdx: 0,
    stopLoss: String(slPrice), slTriggerBy: 'MarkPrice',
  });
}

async function closePosition(symbol, posSide, qty) {
  const side = posSide === 'long' ? 'Sell' : 'Buy';
  return privPost('/v5/order/create', {
    category: 'linear', symbol, side, orderType: 'Market',
    qty: String(qty), reduceOnly: true, timeInForce: 'IOC', positionIdx: 0,
  });
}

async function cancelAll(symbol) {
  try { await privPost('/v5/order/cancel-all', { category: 'linear', symbol }); } catch (_) {}
}

// ── Public market data ──────────────────────────────────────────────────────
async function fetchTickers() {
  const res = await api.get('/v5/market/tickers', { params: { category: 'linear' } });
  return res.data.result.list
    .filter(t => t.symbol.endsWith('USDT') && !t.symbol.includes('1000') && !t.symbol.includes('USDC'))
    .map(t => ({ symbol: t.symbol, change24h: parseFloat(t.price24hPcnt) * 100, vol24h: parseFloat(t.turnover24h) }))
    .filter(t => t.vol24h >= MIN_VOL_USD && Math.abs(t.change24h) >= MIN_CHANGE)
    .sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
}

async function fetchCandles(symbol) {
  const res = await api.get('/v5/market/kline', { params: { category: 'linear', symbol, interval: '15', limit: 100 } });
  if (res.data.retCode !== 0) return [];
  return res.data.result.list.map(c => ({ ts: +c[0], high: +c[2], low: +c[3], close: +c[4] })).sort((a, b) => a.ts - b.ts);
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(values, period) {
  if (values.length < period) return values.map(() => values[0] || 0);
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const res = new Array(period).fill(seed);
  let ema = seed;
  for (let i = period; i < values.length; i++) { ema = values[i] * k + ema * (1 - k); res.push(ema); }
  return res;
}

function calcTrendScore(candles) {
  if (candles.length < EMA_SLOW + 10) return 0;
  const closes = candles.map(c => c.close);
  const e20 = calcEMA(closes, EMA_FAST), e50 = calcEMA(closes, EMA_SLOW);
  let consistent = 0;
  for (let i = EMA_SLOW; i < candles.length; i++) {
    if (Math.abs(e20[i] - e50[i]) / e50[i] >= MIN_EMA_SEP) consistent++;
  }
  const consistency = consistent / (candles.length - EMA_SLOW);
  const curSep = Math.abs(e20[e20.length - 1] - e50[e50.length - 1]) / e50[e50.length - 1];
  return consistency * 0.6 + Math.min(curSep / 0.02, 1) * 0.4;
}

// ── Precision helpers ─────────────────────────────────────────────────────────
function decimals(step) { const s = String(step); return s.includes('.') ? s.split('.')[1].length : 0; }
function roundStep(v, step) { return +(Math.floor(v / step) * step).toFixed(decimals(step)); }
function roundTick(p, tick) { return +(Math.round(p / tick) * tick).toFixed(decimals(tick)); }

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { coins: {}, risk: {} }; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function logTrade({ symbol, type, direction, entry, exit, pnl }) {
  const header = 'timestamp,symbol,type,direction,entry,exit,pnl\n';
  const row = [new Date().toISOString().slice(0,19).replace('T',' '), symbol, type, direction, entry, exit, pnl.toFixed(4)].join(',') + '\n';
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, header);
  fs.appendFileSync(TRADES_FILE, row);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
const TG_TAG = '💰 [HYRO] ';   // prefix so messages are distinct from the paper bot
async function tg(msg) {
  const token = process.env.TELEGRAM_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  const tagged = TG_TAG + msg;
  if (!token || !chat) { console.log('[TG]', tagged.replace(/<[^>]+>/g, '')); return; }
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chat, text: tagged, parse_mode: 'HTML' }, { timeout: 8000 });
  } catch (_) {}
}

// ── Risk layer ──────────────────────────────────────────────────────────────
// Returns { equity, dailyDD, dailyDDPct, totalPnl, totalPnlPct, action }
//   action: 'ok' | 'halt' | 'flatten-day' | 'flatten-stop' | 'target'
async function checkRisk(state) {
  const equity = await getEquity();
  const today  = new Date().toISOString().slice(0, 10);
  const r = state.risk;

  // New trading day → reset peak/start
  if (r.day !== today) {
    r.day = today;
    r.dayStartEquity = equity;
    r.dayPeakEquity  = equity;
    log(`  📅 New day ${today}  start equity: $${equity.toFixed(2)}`);
  }
  if (equity > r.dayPeakEquity) r.dayPeakEquity = equity;

  const dailyDD     = r.dayPeakEquity - equity;                 // absolute
  const dailyDDPct  = dailyDD / INITIAL_BALANCE;                // vs initial
  const totalPnl    = equity - INITIAL_BALANCE;
  const totalPnlPct = totalPnl / INITIAL_BALANCE;

  let action = 'ok';
  if (totalPnlPct <= -MAX_LOSS_FLAT)        action = 'flatten-stop';
  else if (dailyDDPct >= DAILY_DD_FLAT)     action = 'flatten-day';
  else if (dailyDDPct >= DAILY_DD_HALT)     action = 'halt';
  else if (totalPnl >= PROFIT_LOCK_USD)     action = 'profit-lock';   // lock gains BEFORE risking them
  else if (totalPnlPct >= PROFIT_TARGET)    action = 'target';

  return { equity, dailyDD, dailyDDPct, totalPnl, totalPnlPct, action };
}

// Flatten everything: cancel all orders + market-close every open position
async function flattenAll(state, reason) {
  log(`  🛑 FLATTEN ALL — ${reason}`);
  for (const sym of Object.keys(state.coins)) {
    try {
      await cancelAll(sym);
      const positions = await getPosition(sym);
      for (const p of positions) {
        const posSide = p.side === 'Buy' ? 'long' : 'short';
        await closePosition(sym, posSide, p.size);
        log(`    closed ${sym} ${posSide} size:${p.size}`);
      }
    } catch (e) { log(`  ! flatten ${sym}: ${e.message}`); }
    await sleep(300);
  }
  state.coins = {};
  await tg(`🛑 <b>FLATTEN ALL</b>\nReason: ${reason}\nAll positions closed, all orders cancelled.`);
}

// ── Process one coin (live grid) ───────────────────────────────────────────────
async function processCoin(sym, candles, state, change24h, allowNewEntries) {
  if (candles.length < EMA_SLOW + 5) return;

  const closes = candles.map(c => c.close);
  const e20arr = calcEMA(closes, EMA_FAST), e50arr = calcEMA(closes, EMA_SLOW);
  const last = candles[candles.length - 1];
  const e20 = e20arr[e20arr.length - 1], e50 = e50arr[e50arr.length - 1];
  const newMode = e20 > e50 ? 'long' : 'short';
  const emaSep = Math.abs(e20 - e50) / e50;
  const now = Date.now();

  const isBig = Math.abs(change24h) >= BIG_MOVE_PCT;
  const tpPct = isBig ? TP_BIG : TP_PCT;
  const gridStep = isBig ? GRID_BIG : GRID_STEP;

  // Init new coin (only if trend quality passes AND we may open)
  if (!state.coins[sym]) {
    if (!allowNewEntries) return;
    if (Object.keys(state.coins).length >= MAX_COINS) return;
    const score = calcTrendScore(candles);
    if (score < MIN_TREND_SCORE) { log(`  ~ SKIP ${sym} score:${score.toFixed(2)}`); return; }

    const info = await getInstrument(sym);
    if (!info) return;
    await setLeverage(sym, LEVERAGE);
    state.coins[sym] = {
      mode: newMode, positions: [], lastSwitch: 0,
      startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
      trendScore: +score.toFixed(2), change24h: +change24h.toFixed(2),
      qtyStep: info.lotSizeFilter.qtyStep, minQty: info.lotSizeFilter.minOrderQty,
      tickSize: info.priceFilter.tickSize,
    };
    log(`  + New coin ${sym} ${newMode.toUpperCase()} score:${score.toFixed(2)} 24H:${change24h.toFixed(1)}%`);
    await tg(`📡 <b>New coin: ${sym}</b>  ${newMode.toUpperCase()}${isBig ? ' 🔥' : ''}\nScore:${(score*100).toFixed(0)} | 24H:${change24h>=0?'+':''}${change24h.toFixed(1)}% | TP:${(tpPct*100).toFixed(2)}%`);
  }

  const s = state.coins[sym];

  // Sync with live exchange positions — drop bot-tracked entries that no longer exist
  let livePositions;
  try { livePositions = await getPosition(sym); } catch { livePositions = null; }
  const liveSize = livePositions ? livePositions.reduce((a, p) => a + parseFloat(p.size), 0) : null;
  if (liveSize === 0 && s.positions.length > 0) {
    // Exchange flat (TP or SL filled everything) — reset our tracking
    log(`  ⟲ ${sym} exchange flat — clearing ${s.positions.length} tracked entries`);
    s.positions = [];
    await cancelAll(sym);
  }

  // ── Mode switch — close live position, flip ─────────────────────────────────
  if (s.mode !== newMode && (now - (s.lastSwitch || 0)) >= SWITCH_COOL_MS) {
    if (s.positions.length > 0 && livePositions && livePositions.length) {
      await cancelAll(sym);
      for (const p of livePositions) {
        const posSide = p.side === 'Buy' ? 'long' : 'short';
        const pnl = parseFloat(p.unrealisedPnl || 0);
        try { await closePosition(sym, posSide, p.size); } catch (e) { log(`  ! switch close ${sym}: ${e.message}`); }
        logTrade({ symbol: sym, type: 'switch', direction: posSide, entry: p.avgPrice, exit: last.close, pnl });
      }
      await tg(`🔄 <b>SWITCH ${sym}</b> → ${newMode.toUpperCase()} (EMA crossed)\nClosed ${livePositions.length} position(s).`);
    }
    s.positions = [];
    s.mode = newMode;
    s.lastSwitch = now;
  }

  // ── Open new grid level ─────────────────────────────────────────────────────
  if (allowNewEntries && emaSep >= MIN_EMA_SEP && s.positions.length < MAX_POSITIONS) {
    const lastEntry = s.positions.length ? s.positions[s.positions.length - 1].entry : null;
    const dist = lastEntry ? Math.abs(last.close - lastEntry) / lastEntry : 1;
    if (dist >= gridStep) {
      const price = last.close;
      const qty = Math.max(roundStep(TRADE_NOTIONAL / price, +s.qtyStep), +s.minQty);
      const tp  = s.mode === 'long' ? roundTick(price * (1 + tpPct), +s.tickSize) : roundTick(price * (1 - tpPct), +s.tickSize);
      const sl  = s.mode === 'long' ? roundTick(price * (1 - STOP_LOSS_PCT), +s.tickSize) : roundTick(price * (1 + STOP_LOSS_PCT), +s.tickSize);
      const side = s.mode === 'long' ? 'Buy' : 'Sell';

      try {
        await marketEntry(sym, side, qty, sl);     // open + attach SL (REQUIRED)
        await placeTP(sym, s.mode, qty, tp);        // reduce-only TP order
        s.positions.push({ entry: price, tp, sl, qty, mode: s.mode, openedAt: new Date().toISOString() });
        s.lastActivityAt = new Date().toISOString();
        log(`  ${s.mode === 'long' ? '🟢' : '🔴'} OPEN ${sym} ${s.mode} qty:${qty} @${price} tp:${tp} sl:${sl}`);
        await tg(
          `${s.mode === 'long' ? '🟢' : '🔴'} <b>${s.mode.toUpperCase()} ${sym}</b>${isBig ? ' 🔥' : ''}\n` +
          `Entry: <code>${price}</code>  Qty: ${qty}\n` +
          `🎯 TP: ${tp}  🛑 SL: ${sl} (3%)\n` +
          `Pos: ${s.positions.length}/${MAX_POSITIONS}  |  EMA sep: ${(emaSep*100).toFixed(2)}%`
        );
      } catch (e) { log(`  ! entry ${sym}: ${e.message}`); }
    }
  }
}

// ── Lightweight risk monitor (runs every RISK_MS) ───────────────────────────────
let halted = false;       // halted for the day (daily DD)
let stopped = false;      // bot fully stopped (max loss or target)

let lastHeartbeatAt = 0;
const HEARTBEAT_LOG_MS = 5 * 60 * 1000;   // throttle the routine 💓 log to once per 5 min

async function riskTick() {
  if (stopped) return;
  const state = loadState();
  let risk;
  try { risk = await checkRisk(state); } catch (e) { log(`  ! risk check: ${e.message}`); return; }

  const { equity, dailyDDPct, totalPnlPct, action } = risk;
  // Always log on action != 'ok' (state-change events). Otherwise throttle to 5 min.
  const now = Date.now();
  if (action !== 'ok' || (now - lastHeartbeatAt) >= HEARTBEAT_LOG_MS) {
    log(`  💓 equity:$${equity.toFixed(2)}  dayDD:${(dailyDDPct*100).toFixed(2)}%  total:${(totalPnlPct*100).toFixed(2)}%  [${action}]`);
    lastHeartbeatAt = now;
  }

  // Each branch only fires ONCE per state transition — flag prevents the
  // 60s-loop from re-flattening + spamming Telegram while dailyDD stays high.
  if (action === 'flatten-stop' && !stopped) {
    await flattenAll(state, `MAX LOSS guard — account ${(totalPnlPct*100).toFixed(2)}% (limit -10%)`);
    stopped = true;
    await tg(`⛔ <b>BOT STOPPED</b> — max-loss buffer hit at ${(totalPnlPct*100).toFixed(2)}%. No more trades. Manual restart required.`);
  } else if (action === 'flatten-day' && !halted) {
    await flattenAll(state, `DAILY DRAWDOWN guard — ${(dailyDDPct*100).toFixed(2)}% (limit 5%)`);
    halted = true;
    await tg(`🟠 <b>HALTED FOR TODAY</b> — daily drawdown ${(dailyDDPct*100).toFixed(2)}%. Trading resumes next day.`);
  } else if (action === 'halt' && !halted) {
    halted = true;
    await tg(`⚠️ <b>NEW ENTRIES PAUSED</b> — daily drawdown ${(dailyDDPct*100).toFixed(2)}% (4% buffer). Existing positions keep their stops.`);
  } else if (action === 'profit-lock' && !stopped) {
    const locked = risk.totalPnl;
    await flattenAll(state, `PROFIT LOCK reached — +$${locked.toFixed(2)} (lock at $${PROFIT_LOCK_USD})`);
    stopped = true;
    await tg(`💰 <b>PROFIT LOCKED</b> +$${locked.toFixed(2)}!\nBot stopped to protect the gain. Restart manually (or raise <code>HYRO_PROFIT_LOCK_USD</code>) when you want to keep trading.`);
  } else if (action === 'target' && !stopped) {
    await flattenAll(state, `PROFIT TARGET +${(totalPnlPct*100).toFixed(2)}% reached`);
    stopped = true;
    await tg(`🎯 <b>PROFIT TARGET HIT</b> +${(totalPnlPct*100).toFixed(2)}%! Flattened & stopped — move to the next phase, then restart the bot.`);
  } else if (action === 'ok' && halted) {
    // dailyDD recovered (usually because UTC day rolled over → fresh peak) → resume
    halted = false;
    await tg(`✅ <b>RESUMED</b> — daily drawdown back to ${(dailyDDPct*100).toFixed(2)}%. New entries enabled.`);
  }

  saveState(state);
}

// ── Full grid scan (runs every SCAN_MS) ─────────────────────────────────────────
async function scan() {
  if (stopped) return;
  const state = loadState();
  const now = Date.now();

  let risk;
  try { risk = await checkRisk(state); } catch (e) { log(`  ! scan risk: ${e.message}`); saveState(state); return; }
  const allowNewEntries = !halted && !stopped && risk.action === 'ok';

  // Rotate out stale coins (no positions + idle)
  for (const [sym, s] of Object.entries(state.coins)) {
    if (s.positions?.length > 0) continue;
    const idleMs = now - new Date(s.lastActivityAt || s.startedAt || 0).getTime();
    if (idleMs > STALE_HOURS * 3600 * 1000) {
      log(`  ~ DROP ${sym} idle ${Math.round(idleMs/3600000)}h`);
      await cancelAll(sym);
      delete state.coins[sym];
    }
  }

  log(`── Scan  coins:${Object.keys(state.coins).length}/${MAX_COINS}  entries:${allowNewEntries ? 'ON' : 'OFF'}  dayDD:${(risk.dailyDDPct*100).toFixed(2)}% ──`);

  // Process tracked coins
  for (const sym of Object.keys(state.coins)) {
    try { await processCoin(sym, await fetchCandles(sym), state, state.coins[sym].change24h || 0, allowNewEntries); }
    catch (e) { log(`  ! ${sym}: ${e.message}`); }
    await sleep(400);
  }

  // Scan for new movers to fill slots
  if (allowNewEntries && Object.keys(state.coins).length < MAX_COINS) {
    try {
      const tickers = await fetchTickers();
      const candidates = [];
      for (const t of tickers.slice(0, 40)) {
        if (state.coins[t.symbol]) continue;
        await sleep(150);
        try {
          const candles = await fetchCandles(t.symbol);
          if (candles.length < EMA_SLOW + 10) continue;
          candidates.push({ t, candles, score: calcTrendScore(candles) });
        } catch (_) {}
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const { t, candles } of candidates) {
        if (Object.keys(state.coins).length >= MAX_COINS) break;
        await processCoin(t.symbol, candles, state, t.change24h, true);
      }
    } catch (e) { log(`  ! ticker scan: ${e.message}`); }
  }

  saveState(state);
  log(`  equity:$${risk.equity.toFixed(2)}  total:${(risk.totalPnlPct*100).toFixed(2)}%`);
}

// ── Keep-alive HTTP (Render) ────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`HyroTrader bot running\nStopped:${stopped} Halted:${halted}`);
}).listen(process.env.PORT || 3001, () => log(`Health server on ${process.env.PORT || 3001}`));

// ── Entry ─────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════════════');
  log('  HyroTrader Challenge Grid Bot — LIVE');
  log(`  Initial: $${INITIAL_BALANCE}  |  $${TRADE_NOTIONAL}/pos  |  ${LEVERAGE}x  |  ${MAX_COINS} coins`);
  log(`  SL:${(STOP_LOSS_PCT*100)}%  |  DailyDD halt:${DAILY_DD_HALT*100}% flat:${DAILY_DD_FLAT*100}%  |  MaxLoss flat:${MAX_LOSS_FLAT*100}%  |  Target:+${PROFIT_TARGET*100}%`);
  log(`  💰 Profit lock: +$${PROFIT_LOCK_USD}  (override via HYRO_PROFIT_LOCK_USD env)`);
  log('══════════════════════════════════════════════════');

  if (!process.env.HYRO_API_KEY || !process.env.HYRO_API_SECRET) {
    log('  ✖ Missing HYRO_API_KEY / HYRO_API_SECRET in .env — aborting.');
    process.exit(1);
  }

  // Verify connection + initial equity
  try {
    const eq = await getEquity();
    log(`  ✓ Connected. Equity: $${eq.toFixed(2)}`);
    await tg(
      `🤖 <b>HyroTrader Bot STARTED</b>\n\n` +
      `💵 Equity: $${eq.toFixed(2)}  (initial $${INITIAL_BALANCE})\n` +
      `📦 $${TRADE_NOTIONAL}/pos | ${LEVERAGE}x | ${MAX_COINS} coins | 3% SL\n` +
      `🛡 Daily DD halt 4% / flatten 4.5% | Max-loss flatten 9% | Target +10%\n` +
      `💰 <b>Profit lock: +$${PROFIT_LOCK_USD}</b> (auto-stop when reached)`
    );
  } catch (e) {
    log(`  ✖ Connection failed: ${e.message}`);
    await tg(`✖ <b>HyroTrader Bot — connection failed</b>\n${e.message}`);
    process.exit(1);
  }

  // Risk monitor loop (fast)
  (async () => { while (true) { if (!stopped) { try { await riskTick(); } catch (e) { log('risk err', e.message); } } await sleep(RISK_MS); } })();

  // Grid scan loop (slow)
  try { await scan(); } catch (e) { log('scan err', e.message); }
  while (true) {
    await sleep(SCAN_MS);
    if (stopped) { log('  bot stopped — idle'); continue; }
    try { await scan(); } catch (e) { log('scan err', e.message); }
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
