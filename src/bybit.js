const axios = require('axios');

const BASE = 'https://api.bybit.com';

const http = axios.create({
  baseURL: BASE,
  timeout: 10000,
});

// Returns all linear USDT perp tickers with 24h change, volume, funding rate
async function getTickers() {
  const res = await http.get('/v5/market/tickers', {
    params: { category: 'linear' },
  });
  return res.data.result.list;
}

// Returns OHLCV candles oldest-first
// interval: '1','5','15','30','60','240','D'
async function getKlines(symbol, interval = '60', limit = 100) {
  const res = await http.get('/v5/market/kline', {
    params: { category: 'linear', symbol, interval, limit },
  });
  // API returns newest-first: [startTime, open, high, low, close, volume, turnover]
  return res.data.result.list
    .reverse()
    .map(k => ({
      time:   parseInt(k[0]),
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));
}

module.exports = { getTickers, getKlines };
