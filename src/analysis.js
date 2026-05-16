const { RSI, BollingerBands, MACD } = require('technicalindicators');

// Each signal has a name, detail string, and weight (higher = stronger conviction)
function analyzeCandles(candles, fundingRate) {
  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);

  const signals = [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  // ── 1. RSI overbought ────────────────────────────────────────────────────
  const rsiSeries = RSI.calculate({ period: 14, values: closes });
  const rsi = rsiSeries[rsiSeries.length - 1];

  if (rsi >= 85) {
    signals.push({ name: 'RSI_EXTREME',     detail: rsi.toFixed(1), weight: 3 });
  } else if (rsi >= 78) {
    signals.push({ name: 'RSI_OVERBOUGHT',  detail: rsi.toFixed(1), weight: 2 });
  } else if (rsi >= 70) {
    signals.push({ name: 'RSI_HIGH',        detail: rsi.toFixed(1), weight: 1 });
  }

  // ── 2. Price vs Bollinger Bands (20,2) ───────────────────────────────────
  const bbSeries = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const bb = bbSeries[bbSeries.length - 1];
  if (bb && last.close > bb.upper) {
    const pct = ((last.close - bb.upper) / bb.upper * 100).toFixed(2);
    signals.push({ name: 'ABOVE_BB_UPPER', detail: `+${pct}% above`, weight: 2 });
  }

  // ── 3. Volume distribution (avg of last 3 vs prior 3 candles) ────────────
  const avgRecent = avg(volumes.slice(-3));
  const avgPrior  = avg(volumes.slice(-6, -3));
  if (avgPrior > 0 && avgRecent < avgPrior * 0.65) {
    const drop = ((1 - avgRecent / avgPrior) * 100).toFixed(1);
    signals.push({ name: 'VOLUME_DECLINING', detail: `-${drop}% vs prev`, weight: 2 });
  }

  // ── 4. MACD bearish divergence ────────────────────────────────────────────
  // Price making higher high while MACD histogram making lower high
  const macdSeries = MACD.calculate({
    fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    values: closes,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  if (macdSeries.length >= 10) {
    const tail = macdSeries.slice(-10);
    const hist = tail.map(m => m.histogram ?? 0);
    const pxTail = closes.slice(-10);
    const priceHigher = pxTail[9] > pxTail[0];
    const macdLower   = hist[9] < hist[0];
    if (priceHigher && macdLower) {
      signals.push({ name: 'BEARISH_DIVERGENCE', detail: 'price↑ MACD↓', weight: 2 });
    }
  }

  // ── 5. Shooting star candle on the most recent candle ────────────────────
  const body      = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  if (body > 0 && upperWick > body * 2 && lowerWick < body * 0.5 && last.close < last.open) {
    signals.push({ name: 'SHOOTING_STAR', detail: 'bearish reversal candle', weight: 2 });
  }

  // ── 6. Consecutive red candles after peak ────────────────────────────────
  const last3 = candles.slice(-3);
  const allRed = last3.every(c => c.close < c.open);
  if (allRed) {
    signals.push({ name: 'CONSECUTIVE_RED', detail: '3 red candles', weight: 1 });
  }

  // ── 7. High funding rate (longs paying shorts → crowded long) ─────────────
  if (fundingRate >= 0.001) {       // 0.1% per 8h = extreme
    signals.push({ name: 'HIGH_FUNDING', detail: `${(fundingRate * 100).toFixed(3)}%`, weight: 2 });
  } else if (fundingRate >= 0.0005) { // 0.05%
    signals.push({ name: 'ELEVATED_FUNDING', detail: `${(fundingRate * 100).toFixed(3)}%`, weight: 1 });
  }

  // ── 8. Price extended from 50-period SMA ─────────────────────────────────
  if (closes.length >= 50) {
    const sma50 = avg(closes.slice(-50));
    const extension = ((last.close - sma50) / sma50 * 100).toFixed(1);
    if (last.close > sma50 * 1.5) {
      signals.push({ name: 'EXTENDED_FROM_SMA50', detail: `+${extension}% above`, weight: 1 });
    }
  }

  return {
    signals,
    score: signals.reduce((sum, s) => sum + s.weight, 0),
    rsi,
    bb,
    lastCandle: last,
  };
}

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

module.exports = { analyzeCandles };
