import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
  evaluateBot2Strategy,
  buildInitialBot2Position,
  updateBot2Position,
} from './strategyBot2';
import { Bot2Config } from './typesBot2';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const args = process.argv.slice(2);
const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];
const slipArg = args.find(a => a.startsWith('--slippage='))?.split('=')[1];

const START_MS = fromArg ? new Date(fromArg).getTime() : Date.now() - 180 * 24 * 60 * 60 * 1000;
const END_MS = Date.now();
const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';

if (!CC_KEY) {
  console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
  process.exit(1);
}

const SLIPPAGE = slipArg ? parseFloat(slipArg) / 100 : 0.002;
const CAPITAL = 100;

const cfg: Bot2Config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8')
);

interface CCHistoResp {
  Response: string;
  Data: {
    Data: Array<{
      time: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volumefrom: number;
    }>;
  };
}

async function fetchHourly(startMs: number, endMs: number): Promise<Candle[]> {
  const all: Candle[] = [];
  const startSec = Math.floor(startMs / 1000);
  let toTs = Math.floor(endMs / 1000);

  while (true) {
    const { data } = await axios.get<CCHistoResp>(
      'https://min-api.cryptocompare.com/data/v2/histohour',
      { params: { fsym: 'SOL', tsym: 'USD', limit: 2000, toTs, api_key: CC_KEY }, timeout: 30000 }
    );

    if (data.Response !== 'Success') throw new Error(data.Response);

    const rows = data.Data.Data;
    if (!rows.length) break;

    for (const r of rows) {
      if (r.time < startSec || r.time * 1000 > endMs) continue;
      if (r.open === 0 && r.close === 0) continue;
      all.push({
        timestamp: r.time * 1000,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volumefrom,
      });
    }

    toTs = rows[0].time - 1;
    if (rows[0].time <= startSec) break;
  }

  return all.sort((a, b) => a.timestamp - b.timestamp);
}

async function main() {
  console.log('Bot #2 - Mean Reversion Backtest');
  console.log('='.repeat(50));
  console.log(`Capital: $${CAPITAL}`);
  console.log(`Slippage: ${(SLIPPAGE * 100).toFixed(2)}%`);
  console.log('');

  console.log('Fetching hourly candles...');
  const hourly = await fetchHourly(START_MS, END_MS);
  console.log(`Fetched ${hourly.length} hourly candles`);

  // Aggregate to 15m (4 hourly = 1 15m)
  const candles: Candle[] = [];
  for (let i = 0; i < hourly.length; i += 4) {
    const chunk = hourly.slice(i, i + 4);
    if (chunk.length > 0) {
      candles.push({
        timestamp: chunk[0].timestamp,
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, c) => sum + c.volume, 0),
      });
    }
  }
  console.log(`Aggregated to ${candles.length} 15m candles`);

  const warmup = 100;
  let usdc = CAPITAL;
  let position = buildInitialBot2Position();
  const trades: Array<{ time: number; action: string; price: number; pnl: number }> = [];

  console.log(`Running simulation (${candles.length - warmup} candles)...`);

  for (let i = warmup; i < candles.length; i++) {
    const candle = candles[i];
    const price = candle.close;
    const window = candles.slice(Math.max(0, i - 100), i + 1);

    const signal = evaluateBot2Strategy(price, window, position, cfg, candle.timestamp);

    if (signal.action === 'buy' && !position.inPosition) {
      const tradeUsdc = Math.min(usdc * 0.30, usdc);
      const size = tradeUsdc / price;
      const slippagePrice = price * (1 - SLIPPAGE);
      usdc -= size * slippagePrice;

      position = updateBot2Position(position, 'buy', slippagePrice, size, cfg, candle.timestamp);
      trades.push({ time: candle.timestamp, action: 'BUY', price: slippagePrice, pnl: 0 });
    } else if (signal.action === 'sell' && position.inPosition && position.entryPrice) {
      const size = position.size;
      const slippagePrice = price * (1 + SLIPPAGE);
      const pnl = (slippagePrice - position.entryPrice) * size;

      usdc += size * slippagePrice;
      position = updateBot2Position(position, 'sell', slippagePrice, size, cfg, candle.timestamp);
      trades.push({ time: candle.timestamp, action: 'SELL', price: slippagePrice, pnl });
    } else if (position.inPosition) {
      position = updateBot2Position(position, 'hold', price, position.size, cfg, candle.timestamp);
    }
  }

  const finalValue = usdc + (position.inPosition ? position.size * candles[candles.length - 1].close : 0);
  const totalReturn = ((finalValue - CAPITAL) / CAPITAL) * 100;

  const sells = trades.filter(t => t.action === 'SELL');
  const wins = sells.filter(t => t.pnl > 0).length;

  console.log('');
  console.log('='.repeat(50));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(50));
  console.log(`Period: ${new Date(candles[warmup]?.timestamp ?? 0).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}`);
  console.log(`Final value: $${finalValue.toFixed(2)}`);
  console.log(`Total return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(1)}%`);
  console.log('');
  console.log(`Trades: ${trades.length} (${sells.length} closed)`);
  console.log(`Win rate: ${sells.length > 0 ? (wins / sells.length * 100).toFixed(1) : 0}%`);
  const totalPnl = sells.reduce((sum, t) => sum + t.pnl, 0);
  console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
  if (sells.length > 0) {
    const avgWin = sells.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / Math.max(1, wins);
    const avgLoss = Math.abs(sells.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / Math.max(1, sells.length - wins));
    console.log(`Avg win: $${avgWin.toFixed(2)}, Avg loss: $${avgLoss.toFixed(2)}`);
  }
  console.log('');
  console.log('Recent trades:');
  trades.slice(-10).forEach(t => {
    const d = new Date(t.time).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${d} ${t.action} @ $${t.price.toFixed(2)} ${t.pnl !== 0 ? `P: $${t.pnl.toFixed(2)}` : ''}`);
  });
}

main().catch(console.error);
