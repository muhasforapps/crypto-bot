require('dotenv').config();

const { getTickers, getKlines } = require('./src/bybit');
const { analyzeCandles }        = require('./src/analysis');
const { alert }                 = require('./src/alerts');

// ── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  scanIntervalMinutes : 5,      // how often to scan
  minGain24h          : 30,     // % — only look at coins up this much today
  topGainersLimit     : 30,     // max coins to deep-analyse per scan
  scoreThreshold      : 4,      // minimum signal score to fire an alert
  klineInterval       : '60',   // '60' = 1-hour candles
  klineLimit          : 100,    // candles to fetch per symbol
  requestDelayMs      : 250,    // pause between Bybit kline requests (rate limit)
};

// ── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main scan ────────────────────────────────────────────────────────────────
async function scan() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] Scanning Bybit top gainers...`);

  // 1. Fetch all tickers and filter to top gainers
  let tickers;
  try {
    const raw = await getTickers();
    tickers = raw
      .filter(t => t.symbol.endsWith('USDT'))
      .map(t => ({
        symbol      : t.symbol,
        lastPrice   : parseFloat(t.lastPrice),
        change24h   : parseFloat(t.price24hPcnt) * 100,
        fundingRate : parseFloat(t.fundingRate ?? 0),
        volume24h   : parseFloat(t.volume24h),
      }))
      .filter(t => t.change24h >= CONFIG.minGain24h)
      .sort((a, b) => b.change24h - a.change24h)
      .slice(0, CONFIG.topGainersLimit);
  } catch (err) {
    console.error(`  Failed to fetch tickers: ${err.message}`);
    return;
  }

  if (tickers.length === 0) {
    console.log(`  No coins up ${CONFIG.minGain24h}%+ found.`);
    return;
  }

  console.log(`  ${tickers.length} coins up ${CONFIG.minGain24h}%+ | analysing...`);

  // 2. Analyse each ticker
  const opportunities = [];

  for (const ticker of tickers) {
    try {
      const candles = await getKlines(ticker.symbol, CONFIG.klineInterval, CONFIG.klineLimit);
      if (candles.length < 30) continue; // too few candles to be reliable

      const result = analyzeCandles(candles, ticker.fundingRate);

      process.stdout.write(
        `  ${ticker.symbol.padEnd(15)} +${ticker.change24h.toFixed(1).padStart(6)}%` +
        `  RSI:${result.rsi.toFixed(0).padStart(3)}` +
        `  score:${result.score}` +
        (result.score >= CONFIG.scoreThreshold ? '  ← ALERT' : '') +
        '\n'
      );

      if (result.score >= CONFIG.scoreThreshold) {
        opportunities.push({
          symbol    : ticker.symbol,
          change24h : ticker.change24h,
          lastPrice : ticker.lastPrice,
          ...result,
        });
      }
    } catch (err) {
      console.error(`  ${ticker.symbol}: ${err.message}`);
    }

    await sleep(CONFIG.requestDelayMs);
  }

  // 3. Fire alerts, best score first
  if (opportunities.length === 0) {
    console.log('\n  No short opportunities meet the threshold this cycle.');
    return;
  }

  opportunities.sort((a, b) => b.score - a.score);

  for (const opp of opportunities) {
    await alert(opp);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║     Crypto Short Opportunity Scanner  ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Interval  : every ${CONFIG.scanIntervalMinutes} min`);
  console.log(`Filter    : coins up ${CONFIG.minGain24h}%+ in 24h`);
  console.log(`Alert at  : score >= ${CONFIG.scoreThreshold} pts`);
  console.log(`Timeframe : ${CONFIG.klineInterval === '60' ? '1h' : CONFIG.klineInterval} candles`);
  console.log(`Telegram  : ${process.env.TELEGRAM_TOKEN ? 'enabled' : 'disabled (set TELEGRAM_TOKEN)'}`);

  await scan();
  setInterval(scan, CONFIG.scanIntervalMinutes * 60 * 1000);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
