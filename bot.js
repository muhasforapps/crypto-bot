/**
 * Live Fibonacci Grid Short Bot
 *
 * Flow:
 *  1. Every 4h candle close → scan for best pumped coin (score ≥ 5)
 *  2. Place blind limit SHORT orders at Fib extension levels
 *  3. Each fill gets its own SL trigger order (8% above fill price)
 *  4. Master SL: 15% above highest filled level
 *  5. Trail stop: when price drops, tighten SL to lowestClose × 1.20
 *  6. TP: price returns to swing_low
 *  7. Timeout: force-close after 7 days
 *
 * Setup:
 *   cp .env.example .env   # add your Bybit API keys
 *   node bot.js
 */

require('dotenv').config();
const fs  = require('fs');
const T   = require('./src/trader');
const { analyzeCandles } = require('./src/analysis');
const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
  interval      : '240',       // 4h candles
  fetchLimit    : 200,
  lookback      : 60,
  swingLookback : 12,
  scoreThreshold: 5,
  minGain24h    : 25,
  maxGain24h    : 150,
  minVolumeUSDT : 500_000,

  fibRatios  : [1.0, 1.272, 1.618, 2.000],
  posTotal   : 0.30,           // 30% of capital per trade (safe default)
  leverage   : 5,
  levelSlPct : 8,              // individual fill SL %
  masterSlPct: 15,             // master SL % above highest fill
  trailPct   : 20,             // trail stop % above lowest close
  maxHoldMs  : 7 * 24 * 3600_000,

  STATE_FILE : './bot-state.json',
  LOOP_MS    : 60_000,         // check every 60 seconds
  REQ_DELAY  : 300,
};

// ── Telegram alerts ───────────────────────────────────────────────────────────
async function tg(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const text = msg.replace(/<[^>]+>/g, '');
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId, text, parse_mode: 'HTML',
    });
  } catch (_) {}
}

// ── State helpers ─────────────────────────────────────────────────────────────
const EMPTY_STATE = { status: 'idle', lastScanTime: 0 };

function loadState() {
  try { return JSON.parse(fs.readFileSync(CFG.STATE_FILE, 'utf8')); }
  catch (_) { return { ...EMPTY_STATE }; }
}

function saveState(state) {
  fs.writeFileSync(CFG.STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const log    = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const fmt2   = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

function isNewCandle() {
  const now = new Date();
  const h   = now.getUTCHours();
  const m   = now.getUTCMinutes();
  return m >= 1 && m <= 3 && h % 4 === 0;   // 1–3 min after 4h boundary
}

// ── Scanner ───────────────────────────────────────────────────────────────────
async function scan() {
  log('Scanning all tickers...');
  const tickers = await T.getTickers();

  // Filter: USDT perps that pumped 25–150% in 24h with enough volume
  const candidates = tickers
    .filter(t => t.symbol.endsWith('USDT'))
    .map(t => ({
      symbol    : t.symbol,
      gain24h   : parseFloat(t.price24hPcnt) * 100,
      volume24h : parseFloat(t.turnover24h),
      funding   : parseFloat(t.fundingRate ?? 0),
    }))
    .filter(t => t.gain24h >= CFG.minGain24h && t.gain24h <= CFG.maxGain24h)
    .filter(t => t.volume24h >= CFG.minVolumeUSDT)
    .sort((a, b) => b.gain24h - a.gain24h);

  log(`  ${candidates.length} coins pumped 25–150% — checking TA scores...`);

  let best = null;

  for (const cand of candidates) {
    try {
      const candles = await T.getKlines(cand.symbol, CFG.interval, CFG.fetchLimit);
      if (candles.length < CFG.lookback + CFG.swingLookback + 5) {
        await sleep(CFG.REQ_DELAY); continue;
      }
      const { score } = analyzeCandles(candles.slice(-CFG.lookback - 1), cand.funding);
      if (score >= CFG.scoreThreshold) {
        log(`  ✓ ${cand.symbol}  gain:${fmt2(cand.gain24h)}  score:${score}`);
        if (!best || score > best.score || (score === best.score && cand.gain24h > best.gain24h)) {
          best = { ...cand, score, candles };
        }
      }
    } catch (e) {
      log(`  ! ${cand.symbol} error: ${e.message}`);
    }
    await sleep(CFG.REQ_DELAY);
  }

  return best;
}

// ── Build Fib grid ────────────────────────────────────────────────────────────
function buildGrid(swingLow, pumpHigh) {
  const range = pumpHigh - swingLow;
  return CFG.fibRatios.map(ratio => ({
    ratio,
    price : swingLow + range * ratio,
    status: 'pending',   // pending | filled | sl_hit | cancelled
    qty   : 0,
    fillPrice : null,
    orderId   : null,
    slOrderId : null,
  }));
}

// ── Open grid position ────────────────────────────────────────────────────────
async function openGrid(signal, capital) {
  const { symbol, candles, score, gain24h } = signal;
  const i         = candles.length - 1;
  const swingLow  = Math.min(...candles.slice(i - CFG.swingLookback, i - 1).map(c => c.low));
  const pumpHigh  = Math.max(...candles.slice(i - 2, i + 1).map(c => c.high));

  if (swingLow <= 0 || pumpHigh <= swingLow) {
    log(`  ! ${symbol} invalid swing/pump — skip`);
    return null;
  }

  log(`Opening grid on ${symbol}  swingLow:${swingLow}  pumpHigh:${pumpHigh}`);

  // Set leverage (ignore error if already set)
  try { await T.setLeverage(symbol, CFG.leverage); } catch (_) {}

  const info   = await T.getInstrumentInfo(symbol);
  const tick   = parseFloat(info.priceFilter.tickSize);
  const levels = buildGrid(swingLow, pumpHigh);
  const n      = levels.length;

  // Place limit short at each Fib level
  for (const lvl of levels) {
    const price = T.roundPrice(lvl.price, tick);
    const qty   = T.calcQty(capital, CFG.posTotal, n, CFG.leverage, price, info);
    try {
      const res    = await T.placeLimitShort(symbol, qty, price);
      lvl.orderId  = res.orderId;
      lvl.qty      = qty;
      lvl.price    = price;
      log(`  placed SELL limit  ${symbol}  qty:${qty}  price:${price}  ratio:${lvl.ratio}x`);
    } catch (e) {
      log(`  ! failed to place level ${lvl.ratio}: ${e.message}`);
      lvl.status = 'cancelled';
    }
    await sleep(200);
  }

  const state = {
    status     : 'grid_open',
    symbol,
    score,
    gain24h,
    openedAt   : Date.now(),
    swingLow,
    pumpHigh,
    tpPrice    : swingLow,
    capital,
    levels,
    lowestClose: null,
    masterSlOrderId: null,
  };

  const placed = levels.filter(l => l.status === 'pending').length;
  await tg(`🔴 <b>Grid opened</b>\nCoin: ${symbol}\nGain: ${fmt2(gain24h)} | Score: ${score}\nLevels: ${placed}/${n} placed\nTP: ${swingLow.toFixed(6)} | Capital: $${capital.toFixed(0)}`);

  return state;
}

// ── Manage open grid ──────────────────────────────────────────────────────────
async function managePosition(state) {
  const { symbol } = state;

  // 1. Fetch live data
  const [openOrders, position, candles] = await Promise.all([
    T.getOpenOrders(symbol),
    T.getPosition(symbol),
    T.getKlines(symbol, CFG.interval, 10),
  ]);

  const openOrderIds = new Set(openOrders.map(o => o.orderId));
  const posSize      = position ? parseFloat(position.size) : 0;
  const markPrice    = position ? parseFloat(position.markPrice) : 0;
  const lastClose    = candles[candles.length - 1].close;

  // 2. Detect newly filled levels
  for (const lvl of state.levels) {
    if (lvl.status !== 'pending' || !lvl.orderId) continue;
    if (openOrderIds.has(lvl.orderId)) continue; // still open, not filled yet

    // No longer in open orders — check history for fill confirmation
    try {
      const hist = await T.getOrderHistory(symbol, lvl.orderId);
      if (hist && hist.orderStatus === 'Filled') {
        lvl.status    = 'filled';
        lvl.fillPrice = parseFloat(hist.avgPrice);
        log(`  ✓ FILL  ${symbol}  ratio:${lvl.ratio}x  fillPrice:${lvl.fillPrice}  qty:${lvl.qty}`);

        // Place individual SL trigger for this fill's qty
        const slPrice = T.roundPrice(lvl.fillPrice * (1 + CFG.levelSlPct / 100),
                                     parseFloat((await T.getInstrumentInfo(symbol)).priceFilter.tickSize));
        try {
          const slRes      = await T.placeStopTrigger(symbol, lvl.qty, slPrice);
          lvl.slOrderId    = slRes.orderId;
          log(`  SL set  ${symbol}  triggerPrice:${slPrice}  orderId:${slRes.orderId}`);
        } catch (e) { log(`  ! SL placement failed: ${e.message}`); }

        await tg(`📥 <b>Fill</b> ${symbol} @ ${lvl.fillPrice} (${lvl.ratio}x)\nQty: ${lvl.qty} | SL: ${slPrice}`);
      } else if (hist && ['Cancelled', 'Rejected'].includes(hist.orderStatus)) {
        lvl.status = 'cancelled';
      }
    } catch (e) { log(`  ! order history error: ${e.message}`); }
    await sleep(200);
  }

  const filledLevels = state.levels.filter(l => l.status === 'filled');
  const pendingLevels = state.levels.filter(l => l.status === 'pending');

  // Switch to 'managing' once we have at least one fill
  if (filledLevels.length > 0) state.status = 'managing';

  // 3. Update trailing low
  if (filledLevels.length > 0) {
    if (state.lowestClose === null || lastClose < state.lowestClose) {
      state.lowestClose = lastClose;
    }
  }

  // 4. Check: no fills and all pending orders gone → nothing filled, reset
  if (filledLevels.length === 0 && pendingLevels.length === 0) {
    log(`  No fills, all orders gone — resetting to idle`);
    await tg(`⚪ ${symbol} — no fills, grid expired. Back to idle.`);
    return { ...EMPTY_STATE };
  }

  // 5. Check exits (only when we have open position)
  if (posSize > 0 && filledLevels.length > 0) {
    const highestFill = Math.max(...filledLevels.map(l => l.fillPrice));
    const lowestFill  = Math.min(...filledLevels.map(l => l.fillPrice));
    const masterSl    = highestFill * (1 + CFG.masterSlPct / 100);
    const trailStop   = state.lowestClose ? state.lowestClose * (1 + CFG.trailPct / 100) : null;
    const age         = Date.now() - state.openedAt;

    // ── Master SL ──────────────────────────────────────────────────────────
    if (markPrice >= masterSl) {
      log(`  ⚠ MASTER SL hit  ${symbol}  markPrice:${markPrice}  masterSl:${masterSl}`);
      await closeAll(state, posSize, 'master_sl', markPrice);
      return { ...EMPTY_STATE };
    }

    // ── Trail stop (only triggers after price moved below avg entry) ───────
    if (trailStop && state.lowestClose < lowestFill && markPrice >= trailStop) {
      log(`  ✓ TRAIL STOP  ${symbol}  lowestClose:${state.lowestClose}  trailStop:${trailStop}  markPrice:${markPrice}`);
      await closeAll(state, posSize, 'trail', markPrice);
      return { ...EMPTY_STATE };
    }

    // ── TP: price returns to swing_low ─────────────────────────────────────
    if (markPrice <= state.tpPrice) {
      log(`  ✓ TP hit  ${symbol}  markPrice:${markPrice}  tp:${state.tpPrice}`);
      await closeAll(state, posSize, 'tp', markPrice);
      return { ...EMPTY_STATE };
    }

    // ── Timeout ────────────────────────────────────────────────────────────
    if (age >= CFG.maxHoldMs) {
      log(`  ⏰ TIMEOUT  ${symbol}  age:${(age / 3600_000).toFixed(1)}h`);
      await closeAll(state, posSize, 'timeout', markPrice);
      return { ...EMPTY_STATE };
    }

    // ── Update position-level SL to tightest of: masterSL or trailStop ────
    const slToSet = trailStop && state.lowestClose < lowestFill
      ? Math.min(masterSl, trailStop)
      : masterSl;
    try {
      await T.setTradingStop(symbol, { stopLoss: T.roundPrice(slToSet, 0.0001), takeProfit: state.tpPrice });
    } catch (_) {}

    log(`  managing ${symbol}  pos:${posSize}  mark:${markPrice}  masterSL:${masterSl.toFixed(4)}  trail:${trailStop?.toFixed(4) ?? 'n/a'}  tp:${state.tpPrice}`);
  }

  // 6. If position is gone but we didn't trigger an exit ourselves → external close
  if (posSize === 0 && filledLevels.length > 0) {
    log(`  Position gone externally on ${symbol} — resetting`);
    await tg(`⚪ ${symbol} — position closed externally.`);
    return { ...EMPTY_STATE };
  }

  return state;
}

// ── Close everything ──────────────────────────────────────────────────────────
async function closeAll(state, posSize, reason, exitPrice) {
  const { symbol } = state;
  log(`  Closing ${symbol}  reason:${reason}  size:${posSize}  price:${exitPrice}`);

  // Cancel all unfilled grid orders
  try { await T.cancelAllOrders(symbol); } catch (_) {}
  await sleep(500);

  // Market close the entire position
  try { await T.placeMarketClose(symbol, posSize); }
  catch (e) { log(`  ! market close failed: ${e.message}`); }

  // P&L estimate
  const filledLevels = state.levels.filter(l => l.status === 'filled');
  const pnlEst = filledLevels.reduce((sum, lvl) => {
    const notional = state.capital * CFG.posTotal / CFG.fibRatios.length * CFG.leverage;
    return sum + notional * (lvl.fillPrice - exitPrice) / lvl.fillPrice;
  }, 0);

  const emoji = pnlEst >= 0 ? '✅' : '❌';
  await tg(`${emoji} <b>Closed: ${symbol}</b>\nReason: ${reason}\nFills: ${filledLevels.length}/${CFG.fibRatios.length}\nExit: ${exitPrice}\nEst. P&L: ${pnlEst >= 0 ? '+' : ''}$${pnlEst.toFixed(2)}`);
}

// ── Test mode ─────────────────────────────────────────────────────────────────
async function runTest() {
  log('═══════════════════════════════════════════');
  log('  TEST MODE — scan now + place qty=1 orders');
  log('═══════════════════════════════════════════');

  // 1. Check balance
  const capital = await T.getBalance();
  log(`Wallet balance: $${isNaN(capital) ? 'NaN (check account type)' : capital.toFixed(2)}`);

  // 2. Run scanner
  const signal = await scan();
  if (!signal) { log('No signal found right now.'); return; }
  log(`Signal: ${signal.symbol}  score:${signal.score}  gain:${fmt2(signal.gain24h)}`);

  // 3. Build grid
  const { candles } = signal;
  const i        = candles.length - 1;
  const swingLow = Math.min(...candles.slice(i - CFG.swingLookback, i - 1).map(c => c.low));
  const pumpHigh = Math.max(...candles.slice(i - 2, i + 1).map(c => c.high));
  const levels   = buildGrid(swingLow, pumpHigh);
  const info     = await T.getInstrumentInfo(signal.symbol);
  const tick     = parseFloat(info.priceFilter.tickSize);
  const minQty   = parseFloat(info.lotSizeFilter.minOrderQty);
  const qtyStep  = parseFloat(info.lotSizeFilter.qtyStep);

  log(`\nGrid levels for ${signal.symbol}:`);
  log(`  swingLow: ${swingLow}  pumpHigh: ${pumpHigh}`);
  log(`  minQty: ${minQty}  qtyStep: ${qtyStep}  tickSize: ${tick}`);

  try { await T.setLeverage(signal.symbol, CFG.leverage); } catch (_) {}

  // 4. Place qty=1 test orders at each level
  for (const lvl of levels) {
    const price = T.roundPrice(lvl.price, tick);
    const qty   = Math.max(1, minQty);   // use minimum qty for test
    try {
      const res = await T.placeLimitShort(signal.symbol, qty, price);
      log(`  ✓ TEST ORDER placed  ratio:${lvl.ratio}x  price:${price}  qty:${qty}  orderId:${res.orderId}`);
      await sleep(500);
      // Cancel immediately after confirming it was placed
      await T.cancelOrder(signal.symbol, res.orderId);
      log(`  ✓ Cancelled orderId:${res.orderId}`);
    } catch (e) {
      log(`  ✗ FAILED ratio:${lvl.ratio}x  price:${price}  qty:${qty}  error:${e.message}`);
    }
    await sleep(300);
  }

  log('\nTest complete. Check above for ✓ or ✗ on each level.');
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════');
  log('  Fibonacci Grid Short Bot — LIVE');
  log(`  posTotal: ${CFG.posTotal * 100}%  leverage: ${CFG.leverage}x  SL: ${CFG.levelSlPct}%/fill + ${CFG.masterSlPct}% master`);
  log('═══════════════════════════════════════════');

  if (!process.env.BYBIT_API_KEY || !process.env.BYBIT_API_SECRET) {
    console.error('❌  Missing BYBIT_API_KEY or BYBIT_API_SECRET in .env');
    process.exit(1);
  }

  // Test mode: node bot.js --test
  if (process.argv.includes('--test')) {
    await runTest();
    process.exit(0);
  }

  let state = loadState();
  log(`Loaded state: ${state.status}${state.symbol ? ' → ' + state.symbol : ''}`);

  while (true) {
    try {
      // ── No active position: scan on 4h candle close ──────────────────────
      if (state.status === 'idle') {
        if (isNewCandle()) {
          const sinceLastScan = Date.now() - (state.lastScanTime || 0);
          if (sinceLastScan > 3 * 3600_000) {     // don't scan twice in same 4h window
            state.lastScanTime = Date.now();
            saveState(state);

            const signal = await scan();
            if (signal) {
              log(`Signal: ${signal.symbol}  score:${signal.score}  gain:${fmt2(signal.gain24h)}`);
              const capital = await T.getBalance();
              log(`Wallet balance: $${capital.toFixed(2)}`);
              if (capital < 50) {
                log('  ! Balance too low — skip');
              } else {
                const newState = await openGrid(signal, capital);
                if (newState) { state = newState; }
              }
            } else {
              log('No qualifying signal this candle.');
            }
          }
        }
      }

      // ── Active position: check fills + exits every loop ──────────────────
      else if (state.status === 'grid_open' || state.status === 'managing') {
        state = await managePosition(state);
      }

    } catch (e) {
      log(`ERROR: ${e.message}`);
      if (e.stack) log(e.stack.split('\n')[1]);
    }

    saveState(state);
    await sleep(CFG.LOOP_MS);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
