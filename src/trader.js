/**
 * Bybit v5 API — signed private + unsigned public calls
 */

const crypto = require('crypto');
const axios  = require('axios');

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

async function get(path, params = {}) {
  const qs  = new URLSearchParams(params).toString();
  const res = await http.get(path + '?' + qs, { headers: sign(qs) });
  if (res.data.retCode !== 0) throw new Error(`GET ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

async function post(path, body = {}) {
  const str = JSON.stringify(body);
  const res = await http.post(path, body, { headers: { ...sign(str), 'Content-Type': 'application/json' } });
  if (res.data.retCode !== 0) throw new Error(`POST ${path}: ${res.data.retMsg}`);
  return res.data.result;
}

// ── Public ────────────────────────────────────────────────────────────────────
async function getTickers() {
  const res = await http.get('/v5/market/tickers', { params: { category: 'linear' } });
  return res.data.result.list;
}

async function getKlines(symbol, interval, limit) {
  const res = await http.get('/v5/market/kline', {
    params: { category: 'linear', symbol, interval, limit },
  });
  return res.data.result.list.reverse().map(k => ({
    time: parseInt(k[0]), open: parseFloat(k[1]),
    high: parseFloat(k[2]), low: parseFloat(k[3]),
    close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

async function getInstrumentInfo(symbol) {
  const res = await http.get('/v5/market/instruments-info', {
    params: { category: 'linear', symbol },
  });
  return res.data.result.list[0];
}

// ── Account ───────────────────────────────────────────────────────────────────
async function getBalance() {
  for (const accountType of ['UNIFIED', 'CONTRACT', 'SPOT']) {
    try {
      const r = await get('/v5/account/wallet-balance', { accountType });
      const acct = r.list?.[0];
      const bal = parseFloat(
        acct?.totalAvailableBalance || acct?.totalWalletBalance || 0
      );
      if (bal > 0) { return bal; }
    } catch (_) {}
  }
  return 0;
}

// ── Position ──────────────────────────────────────────────────────────────────
async function getPosition(symbol) {
  const r = await get('/v5/position/list', { category: 'linear', symbol });
  return r.list?.[0] ?? null;
}

async function setLeverage(symbol, lev) {
  const l = String(lev);
  return post('/v5/position/set-leverage', {
    category: 'linear', symbol, buyLeverage: l, sellLeverage: l,
  });
}

async function setTradingStop(symbol, { stopLoss, takeProfit } = {}) {
  const body = { category: 'linear', symbol, positionIdx: 2 };
  if (stopLoss   != null) body.stopLoss   = String(stopLoss);
  if (takeProfit != null) body.takeProfit = String(takeProfit);
  return post('/v5/position/trading-stop', body);
}

// ── Orders ────────────────────────────────────────────────────────────────────
async function placeLimitShort(symbol, qty, price) {
  return post('/v5/order/create', {
    category: 'linear', symbol,
    side: 'Sell', orderType: 'Limit',
    qty: String(qty), price: String(price),
    timeInForce: 'GTC', positionIdx: 2,
  });
}

async function placeStopTrigger(symbol, qty, triggerPrice) {
  // Trigger BUY when price RISES above triggerPrice (closes a short)
  return post('/v5/order/create', {
    category: 'linear', symbol,
    side: 'Buy', orderType: 'Market',
    qty: String(qty),
    triggerPrice: String(triggerPrice),
    triggerDirection: 1,          // 1 = trigger when price rises above
    triggerBy: 'MarkPrice',
    reduceOnly: true,
    timeInForce: 'IOC',
    positionIdx: 2,
  });
}

async function placeMarketClose(symbol, qty) {
  return post('/v5/order/create', {
    category: 'linear', symbol,
    side: 'Buy', orderType: 'Market',
    qty: String(qty),
    reduceOnly: true,
    timeInForce: 'IOC',
    positionIdx: 2,
  });
}

async function cancelOrder(symbol, orderId) {
  return post('/v5/order/cancel', { category: 'linear', symbol, orderId });
}

async function cancelAllOrders(symbol) {
  return post('/v5/order/cancel-all', { category: 'linear', symbol });
}

async function getOpenOrders(symbol) {
  const r = await get('/v5/order/realtime', { category: 'linear', symbol, limit: 50 });
  return r.list ?? [];
}

async function getOrderHistory(symbol, orderId) {
  const r = await get('/v5/order/history', { category: 'linear', symbol, orderId, limit: 1 });
  return r.list?.[0] ?? null;
}

// ── Precision helpers ─────────────────────────────────────────────────────────
function decimals(step) {
  const s = String(step);
  return s.includes('.') ? s.split('.')[1].length : 0;
}

function roundToStep(value, step) {
  const d   = decimals(step);
  const qty = Math.floor(value / step) * step;
  return +qty.toFixed(d);
}

function roundPrice(price, tickSize) {
  const d = decimals(tickSize);
  return +(Math.round(price / tickSize) * tickSize).toFixed(d);
}

function calcQty(capital, posTotal, numLevels, leverage, price, info) {
  const qtyStep    = parseFloat(info.lotSizeFilter.qtyStep);
  const minQty     = parseFloat(info.lotSizeFilter.minOrderQty);
  const notional   = capital * posTotal / numLevels * leverage;
  const raw        = notional / price;
  const qty        = roundToStep(raw, qtyStep);
  return Math.max(qty, minQty);
}

module.exports = {
  getTickers, getKlines, getInstrumentInfo,
  getBalance, getPosition, setLeverage, setTradingStop,
  placeLimitShort, placeStopTrigger, placeMarketClose,
  cancelOrder, cancelAllOrders, getOpenOrders, getOrderHistory,
  roundPrice, calcQty,
};
