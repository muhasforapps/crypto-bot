const axios = require('axios');

const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function formatAlert(result) {
  const signalLines = result.signals
    .sort((a, b) => b.weight - a.weight)
    .map(s => `  [${s.weight}pt] ${s.name}: ${s.detail}`)
    .join('\n');

  return [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `🚨 SHORT SIGNAL: ${result.symbol}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `24h Gain   : +${result.change24h.toFixed(2)}%`,
    `Price      : $${result.lastPrice}`,
    `RSI (1h)   : ${result.rsi.toFixed(1)}`,
    `Score      : ${result.score} pts`,
    ``,
    `Signals:`,
    signalLines,
    ``,
    `⚠️  Not financial advice — always use stop loss`,
  ].join('\n');
}

function formatAlertTelegram(result) {
  const signalLines = result.signals
    .sort((a, b) => b.weight - a.weight)
    .map(s => `  <b>[${s.weight}pt]</b> ${s.name}: <code>${s.detail}</code>`)
    .join('\n');

  return [
    `🚨 <b>SHORT SIGNAL: ${result.symbol}</b>`,
    ``,
    `📈 24h Gain: <b>+${result.change24h.toFixed(2)}%</b>`,
    `💰 Price: <code>$${result.lastPrice}</code>`,
    `📊 RSI (1h): <b>${result.rsi.toFixed(1)}</b>`,
    `🎯 Score: <b>${result.score} pts</b>`,
    ``,
    `<b>Signals:</b>`,
    signalLines,
    ``,
    `⚠️ Not financial advice`,
  ].join('\n');
}

function printAlert(result) {
  console.log('\n' + formatAlert(result));
}

async function sendTelegram(result) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: formatAlertTelegram(result),
        parse_mode: 'HTML',
      },
      { timeout: 8000 }
    );
  } catch (err) {
    console.error(`  Telegram send failed: ${err.message}`);
  }
}

async function alert(result) {
  printAlert(result);
  await sendTelegram(result);
}

module.exports = { alert };
