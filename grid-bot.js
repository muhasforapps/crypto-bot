/**
 * RFRM Grid Bot — Bybit Linear Futures
 * Implements "RFRM REAL TRADE FINAL MASTER" Pine Script strategy
 * NEW FILE — completely separate from crypto short scanner
 *
 * Strategy:
 *   - ANCHOR buy at price, exit +1% (grid_1)
 *   - GRID_1/GRID_2 buy as price rises, exit at next level
 *   - FRACTAL small trade at fractal zone, exit +1%
 *   - RECOVERY buy dips below previous anchor, exit at anchor
 *   - CYCLE resets anchor when target (+3%) is hit
 *
 * Uses hedge-mode LONG (positionIdx:1) — safe to run alongside short scanner
 *
 * Env (all optional, have defaults):
 *   GRID_SYMBOL       BTCUSDT
 *   GRID_LEVERAGE     1
 *   GRID_TRADE_SIZE   100      $ per trade
 *   GRID_CYCLE_GAP    3.0      % full cycle range
 *   GRID_COUNT        3        grid levels inside cycle
 *   GRID_MAX_RECOVERY 2        recovery trade levels
 *   GRID_MAX_ACTIVE   2        max simultaneous trades
 *   GRID_FRACTAL      true
 *   GRID_FRACTAL_SIZE 25       $ fractal trade
 *   GRID_FRACTAL_PCT  1.0      % fractal zone above anchor
 */

require('dotenv').config();
const crypto = require('crypto');
const axios  = require('axios');
const fs     = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const SYMBOL        = process.env.GRID_SYMBOL        || 'BTCUSDT';
const LEVERAGE      = parseInt(process.env.GRID_LEVERAGE      || '1');
const TRADE_SIZE    = parseFloat(process.env.GRID_TRADE_SIZE  || '100');
const CYCLE_GAP_PCT = parseFloat(process.env.GRID_CYCLE_GAP   || '3.0');
const GRID_COUNT    = parseInt(process.env.GRID_COUNT         || '3');
const MAX_RECOVERY  = parseInt(process.env.GRID_MAX_RECOVERY  || '2');
const MAX_ACTIVE    = parseInt(process.env.GRID_MAX_ACTIVE    || '2');
const FRACTAL_ON    = process.env.GRID_FRACTAL !== 'false';
const FRACTAL_SIZE  = parseFloat(process.env.GRID_FRACTAL_SIZE || '25');
const FRACTAL_PCT   = parseFloat(process.env.GRID_FRACTAL_PCT  || '1.0');

const SCAN_MS    = 30_000;
const STATE_FILE = './grid-state.json';
const CATEGORY   = 'linear';
const POS_IDX    = 1;   // hedge mode LONG (short scanner uses 2 for SHORT)

// Derived (mirrors Pine Script)
const MAIN_GAP    = CYCLE_GAP_PCT / 100;
const GRID_GAP    = MAIN_GAP / GRID_COUNT;    // e.g. 3%/3 = 1% per grid
const FRACTAL_GAP = FRACTAL_PCT / 100;

// ── Helpers ───────────────────────────────────────────────────────────────────
const log   = (...a) => console.log(new Date().toISOString().slice(0,19).replace('T',' '), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Bybit API ─────────────────────────────────────────────────────────────────
const BASE = 'https://api.bybit.com';
const RW   = '5000';
const http = axios.create({ baseURL: BASE, timeout: 15_000 });

function sign(body) {
  const ts  = String(Date.now());
  const key = process.env.BYBIT_API_KEY;
  const raw = ts + key + RW + body;
  const sig = crypto.createHmac('sha256', process.env.BYBIT_API_SECRET).update(raw).digest('hex');
  return { 'X-BAPI-API-KEY': key, 'X-BAPI-TIMESTAMP': ts, 'X-BAPI-SIGN': sig, 'X-BAPI-RECV-WINDOW': RW };
}

async function apiGet(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const res = await http.get(`${path}?${qs}`, { headers: sign(qs) });
  if (res.data.retCode !== 0) throw new Error(`GET ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

async function apiPost(path, body = {}) {
  const str = JSON.stringify(body);
  const res = await http.post(path, body, { headers: { ...sign(str), 'Content-Type': 'application/json' } });
  if (res.data.retCode !== 0) throw new Error(`POST ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

async function getPrice() {
  const res = await http.get('/v5/market/tickers', { params: { category: CATEGORY, symbol: SYMBOL } });
  return parseFloat(res.data.result.list[0].lastPrice);
}

async function getInstrumentInfo() {
  const res = await http.get('/v5/market/instruments-info', { params: { category: CATEGORY, symbol: SYMBOL } });
  return res.data.result.list[0];
}

// ── Precision helpers ─────────────────────────────────────────────────────────
function decs(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}
function floorStep(v, step) {
  const d = decs(step);
  return +(Math.floor(v / step) * step).toFixed(d);
}
function roundTick(v, tick) {
  const d = decs(tick);
  return +(Math.round(v / tick) * tick).toFixed(d);
}
function calcQty(usd, price, info) {
  const step   = parseFloat(info.lotSizeFilter.qtyStep);
  const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
  return Math.max(floorStep(usd / price, step), minQty);
}

// ── State ─────────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return null; }
}
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }

function freshState(anchor) {
  const positions = { ANCHOR: null, GRID_1: null, GRID_2: null, FRACTAL: null };
  for (let i = 1; i <= MAX_RECOVERY; i++) positions[`RECOVERY_${i}`] = null;
  return { initialized: true, active_anchor: anchor, highest_anchor: anchor, cycle_id: 0, positions };
}

function countActive(state) {
  return Object.values(state.positions).filter(Boolean).length;
}

// ── Telegram (send-only — no polling to avoid conflict with forex bot) ─────────
async function tg(msg) {
  const { TELEGRAM_TOKEN: tok, TELEGRAM_CHAT_ID: cid } = process.env;
  if (!tok || !cid) return;
  try {
    await axios.post(`https://api.telegram.org/bot${tok}/sendMessage`,
      { chat_id: cid, text: msg, parse_mode: 'HTML' });
  } catch (_) {}
}

// ── Order execution ───────────────────────────────────────────────────────────
async function setLeverage() {
  try {
    await apiPost('/v5/position/set-leverage', {
      category: CATEGORY, symbol: SYMBOL,
      buyLeverage: String(LEVERAGE), sellLeverage: String(LEVERAGE),
    });
  } catch (_) {}
}

async function placeMarketBuy(qty, info) {
  const step = parseFloat(info.lotSizeFilter.qtyStep);
  const qtyStr = floorStep(qty, step).toFixed(decs(String(step)));
  return apiPost('/v5/order/create', {
    category: CATEGORY, symbol: SYMBOL,
    side: 'Buy', orderType: 'Market',
    qty: qtyStr,
    timeInForce: 'IOC',
    positionIdx: POS_IDX,
  });
}

async function placeLimitSell(qty, price, info) {
  const step = parseFloat(info.lotSizeFilter.qtyStep);
  const tick = parseFloat(info.priceFilter.tickSize);
  return apiPost('/v5/order/create', {
    category: CATEGORY, symbol: SYMBOL,
    side: 'Sell', orderType: 'Limit',
    qty:   floorStep(qty, step).toFixed(decs(String(step))),
    price: roundTick(price, tick).toFixed(decs(String(tick))),
    timeInForce: 'GTC',
    reduceOnly: true,
    positionIdx: POS_IDX,
  });
}

async function isOrderOpen(orderId) {
  try {
    const r = await apiGet('/v5/order/realtime', { category: CATEGORY, symbol: SYMBOL, orderId, limit: 1 });
    return (r.list?.length ?? 0) > 0;
  } catch { return false; }
}

// ── Levels (mirrors Pine Script) ──────────────────────────────────────────────
function calcLevels(anchor) {
  return {
    grid_0:    anchor,
    grid_1:    anchor * (1 + GRID_GAP),
    grid_2:    anchor * (1 + GRID_GAP * 2),
    cycle_end: anchor * (1 + MAIN_GAP),
    fractal:   anchor * (1 + FRACTAL_GAP),
  };
}

// ── Open a grid position: market buy + limit TP ───────────────────────────────
async function openPosition(id, sizeUsd, price, tp, state, info) {
  const qty = calcQty(sizeUsd, price, info);
  if (qty <= 0) { log(`  SKIP ${id} — qty too small`); return; }

  log(`  OPEN ${id}  qty:${qty}  entry:~${price.toFixed(2)}  tp:${tp.toFixed(2)}`);

  try {
    await placeMarketBuy(qty, info);
    await sleep(600);                          // allow fill before placing TP
    const tpOrder = await placeLimitSell(qty, tp, info);

    state.positions[id] = {
      qty,
      entryPrice: price,
      tp,
      tpOrderId: tpOrder.orderId,
      time: new Date().toISOString(),
    };

    const pct = ((tp / price - 1) * 100).toFixed(2);
    await tg(
      `🟢 <b>GRID LONG — ${id}</b>  ${SYMBOL}\n` +
      `📍 Entry: <code>${price.toFixed(2)}</code>\n` +
      `🎯 TP:    <code>${tp.toFixed(2)}</code>  (+${pct}%)\n` +
      `📦 Qty: ${qty}  |  ~$${sizeUsd}\n` +
      `🔄 Cycle #${state.cycle_id}  Active: ${countActive(state)+1}/${MAX_ACTIVE}`
    );
  } catch (e) {
    log(`  ERROR ${id}: ${e.message}`);
    await tg(`⚠️ Grid open failed — ${id}: ${e.message}`);
  }
}

// ── Check whether any TP orders have been filled ──────────────────────────────
async function checkClosedPositions(state) {
  let changed = false;
  for (const [id, pos] of Object.entries(state.positions)) {
    if (!pos) continue;
    await sleep(300);
    const stillOpen = await isOrderOpen(pos.tpOrderId);
    if (!stillOpen) {
      log(`  ✅ TP HIT — ${id}  tp:${pos.tp.toFixed(2)}`);
      await tg(
        `💰 <b>TP HIT — ${id}</b>  ${SYMBOL}\n` +
        `Entry: ${pos.entryPrice.toFixed(2)}  →  TP: ${pos.tp.toFixed(2)}\n` +
        `Profit: +$${((pos.tp - pos.entryPrice) * pos.qty).toFixed(2)}  Cycle #${state.cycle_id}`
      );
      state.positions[id] = null;
      changed = true;
    }
  }
  return changed;
}

// ── Apply entry conditions (mirrors Pine Script order engine) ─────────────────
async function runStrategy(state, price, info) {
  const lvl   = calcLevels(state.active_anchor);
  const count = countActive(state);

  log(`  Anchor:${state.active_anchor.toFixed(2)} | G0:${lvl.grid_0.toFixed(2)} G1:${lvl.grid_1.toFixed(2)} G2:${lvl.grid_2.toFixed(2)} END:${lvl.cycle_end.toFixed(2)} | Active:${count}/${MAX_ACTIVE}`);

  if (count >= MAX_ACTIVE) return;

  // ANCHOR: enter when price is at or below the anchor
  if (!state.positions.ANCHOR && price <= lvl.grid_0) {
    await openPosition('ANCHOR', TRADE_SIZE, price, lvl.grid_1, state, info);
    return;
  }

  // GRID_1: enter in the grid_1–grid_2 zone
  if (!state.positions.GRID_1 && price >= lvl.grid_1 && price < lvl.grid_2) {
    await openPosition('GRID_1', TRADE_SIZE, price, lvl.grid_2, state, info);
    return;
  }

  // GRID_2: enter in the grid_2–cycle_end zone
  if (!state.positions.GRID_2 && price >= lvl.grid_2 && price < lvl.cycle_end) {
    await openPosition('GRID_2', TRADE_SIZE, price, lvl.cycle_end, state, info);
    return;
  }

  // FRACTAL: small fast trade in fractal zone
  if (FRACTAL_ON && !state.positions.FRACTAL && price >= lvl.fractal && price < lvl.cycle_end) {
    await openPosition('FRACTAL', FRACTAL_SIZE, price, lvl.fractal * 1.01, state, info);
    return;
  }

  // RECOVERY: buy dips below previous high anchor
  for (let r = 1; r <= MAX_RECOVERY; r++) {
    const recId  = `RECOVERY_${r}`;
    const recLvl = state.highest_anchor * (1 - MAIN_GAP * r);
    if (!state.positions[recId] && price <= recLvl) {
      await openPosition(recId, TRADE_SIZE, price, state.active_anchor, state, info);
      return;
    }
  }
}

// ── Cycle engine: advance anchor when target is hit ───────────────────────────
async function checkCycle(state, price) {
  const target = state.active_anchor * (1 + MAIN_GAP);
  if (price < target) return;

  const prev = state.active_anchor;
  state.highest_anchor = prev;
  state.active_anchor  = target;
  state.cycle_id++;

  log(`  🔄 CYCLE ${state.cycle_id} — ${prev.toFixed(2)} → ${state.active_anchor.toFixed(2)}`);
  await tg(
    `🔄 <b>CYCLE COMPLETE #${state.cycle_id}</b>  ${SYMBOL}\n` +
    `Anchor: ${prev.toFixed(2)}  →  <code>${state.active_anchor.toFixed(2)}</code>\n` +
    `Next target: <code>${(state.active_anchor * (1 + MAIN_GAP)).toFixed(2)}</code>  (+${CYCLE_GAP_PCT}%)\n` +
    `Open positions carry forward until their TPs hit.`
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════════════════════════');
  log(`  RFRM Grid Bot  |  ${SYMBOL}  |  ${CYCLE_GAP_PCT}% cycle  |  ${GRID_COUNT} grids  |  ${LEVERAGE}x`);
  log(`  $${TRADE_SIZE}/trade  |  MaxActive:${MAX_ACTIVE}  |  Recovery:${MAX_RECOVERY}`);
  log('══════════════════════════════════════════════════════════════');

  await setLeverage();

  let info;
  try {
    info = await getInstrumentInfo();
    log(`  ${SYMBOL}: qtyStep=${info.lotSizeFilter.qtyStep}  tickSize=${info.priceFilter.tickSize}`);
  } catch (e) {
    log('FATAL: Cannot load instrument info:', e.message);
    process.exit(1);
  }

  let state = loadState();

  if (!state?.initialized) {
    const price = await getPrice();
    state = freshState(price);
    saveState(state);
    log(`  Initialized — anchor: ${price}`);
    await tg(
      `📡 <b>RFRM Grid Bot started</b>\n\n` +
      `📊 ${SYMBOL}  |  Leverage: ${LEVERAGE}x\n` +
      `📍 Anchor: <code>${price.toFixed(2)}</code>\n` +
      `🎯 Target: <code>${(price * (1 + MAIN_GAP)).toFixed(2)}</code>  (+${CYCLE_GAP_PCT}%)\n\n` +
      `Grid gap: ${(GRID_GAP*100).toFixed(2)}%  |  Trade: $${TRADE_SIZE}\n` +
      `MaxActive: ${MAX_ACTIVE}  |  Recovery: ${MAX_RECOVERY} levels\n` +
      `Fractal: ${FRACTAL_ON ? `ON ($${FRACTAL_SIZE} / ${FRACTAL_PCT}%)` : 'OFF'}`
    );
  } else {
    log(`  Resumed — anchor: ${state.active_anchor.toFixed(2)}  cycle: ${state.cycle_id}  active: ${countActive(state)}`);
    await tg(
      `📡 <b>Grid Bot resumed</b>  ${SYMBOL}  Cycle #${state.cycle_id}\n` +
      `Anchor: <code>${state.active_anchor.toFixed(2)}</code>  Active: ${countActive(state)}/${MAX_ACTIVE}`
    );
  }

  while (true) {
    try {
      const price = await getPrice();
      log(`Price: ${price.toFixed(2)}`);

      const changed = await checkClosedPositions(state);
      await checkCycle(state, price);
      await runStrategy(state, price, info);

      saveState(state);
    } catch (e) {
      log('Loop error:', e.message);
      await tg(`⚠️ Grid Bot error: ${e.message}`);
    }
    await sleep(SCAN_MS);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
