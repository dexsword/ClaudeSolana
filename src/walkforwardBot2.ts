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

const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
const SLIPPAGE = 0.002;
const CAPITAL = 100;

const baseCfg: Bot2Config = JSON.parse(
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

function aggregateTo15m(hourly: Candle[]): Candle[] {
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
  return candles;
}

interface BacktestResult {
  totalReturn: number;
  trades: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
}

function runBacktest(candles: Candle[], cfg: Bot2Config): BacktestResult {
  const warmup = 100;
  let usdc = CAPITAL;
  let position = buildInitialBot2Position();
  const trades: Array<{ time: number; action: string; price: number; pnl: number }> = [];
  let peak = CAPITAL;
  let maxDrawdown = 0;

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

    const portfolioValue = usdc + (position.inPosition ? position.size * price : 0);
    if (portfolioValue > peak) peak = portfolioValue;
    const drawdown = (peak - portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const finalValue = usdc + (position.inPosition ? position.size * candles[candles.length - 1].close : 0);
  const totalReturn = ((finalValue - CAPITAL) / CAPITAL) * 100;

  const sells = trades.filter(t => t.action === 'SELL');
  const wins = sells.filter(t => t.pnl > 0).length;
  const totalPnl = sells.reduce((sum, t) => sum + t.pnl, 0);

  const avgWin = wins > 0 ? sells.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / wins : 0;
  const avgLoss = sells.length > wins ? Math.abs(sells.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0) / (sells.length - wins)) : 0;

  return {
    totalReturn,
    trades: sells.length,
    winRate: sells.length > 0 ? (wins / sells.length) * 100 : 0,
    totalPnl,
    avgWin,
    avgLoss,
    maxDrawdown: maxDrawdown * 100,
  };
}

interface WalkForwardResult {
  trainPeriod: string;
  valPeriod: string;
  trainResult: BacktestResult;
  valResult: BacktestResult;
}

async function main() {
  console.log('Bot #2 - Walk-Forward Validation');
  console.log('='.repeat(60));
  console.log('');

  const START_MS = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const END_MS = Date.now();

  console.log('Fetching hourly candles...');
  const hourly = await fetchHourly(START_MS, END_MS);
  const candles = aggregateTo15m(hourly);
  console.log(`Total 15m candles: ${candles.length}`);
  console.log(`Period: ${new Date(candles[0].timestamp).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].timestamp).toISOString().slice(0, 10)}`);
  console.log('');

  const totalCandles = candles.length;
  const trainSize = Math.floor(totalCandles * 0.6);
  const valSize = Math.floor(totalCandles * 0.2);
  const stepSize = Math.floor(totalCandles * 0.1);

  console.log(`Walk-Forward Settings:`);
  console.log(`  Training period: ${Math.floor(trainSize / 96)} days (${trainSize} candles)`);
  console.log(`  Validation period: ${Math.floor(valSize / 96)} days (${valSize} candles)`);
  console.log(`  Step size: ${Math.floor(stepSize / 96)} days (${stepSize} candles)`);
  console.log('');

  const results: WalkForwardResult[] = [];

  for (let i = 0; i + trainSize + valSize <= totalCandles; i += stepSize) {
    const trainEnd = i + trainSize;
    const valEnd = trainEnd + valSize;

    const trainCandles = candles.slice(i, trainEnd);
    const valCandles = candles.slice(trainEnd, valEnd);

    const trainResult = runBacktest(trainCandles, baseCfg);
    const valResult = runBacktest(valCandles, baseCfg);

    const trainPeriod = `${new Date(trainCandles[0].timestamp).toISOString().slice(0, 10)}-${new Date(trainCandles[trainCandles.length - 1].timestamp).toISOString().slice(0, 10)}`;
    const valPeriod = `${new Date(valCandles[0].timestamp).toISOString().slice(0, 10)}-${new Date(valCandles[valCandles.length - 1].timestamp).toISOString().slice(0, 10)}`;

    results.push({ trainPeriod, valPeriod, trainResult, valResult });

    console.log(`[${valPeriod}] Train: ${trainResult.totalReturn.toFixed(1)}% (${trainResult.trades}t, ${trainResult.winRate.toFixed(0)}% WR) | Val: ${valResult.totalReturn.toFixed(1)}% (${valResult.trades}t, ${valResult.winRate.toFixed(0)}% WR) | MDD: ${valResult.maxDrawdown.toFixed(1)}%`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  const avgTrainReturn = results.reduce((s, r) => s + r.trainResult.totalReturn, 0) / results.length;
  const avgValReturn = results.reduce((s, r) => s + r.valResult.totalReturn, 0) / results.length;
  const avgValTrades = results.reduce((s, r) => s + r.valResult.trades, 0) / results.length;
  const avgValWinRate = results.reduce((s, r) => s + r.valResult.winRate, 0) / results.length;
  const avgValMdd = results.reduce((s, r) => s + r.valResult.maxDrawdown, 0) / results.length;

  console.log(`Average Training Return: ${avgTrainReturn.toFixed(2)}%`);
  console.log(`Average Validation Return: ${avgValReturn.toFixed(2)}%`);
  console.log(`Average Validation Trades: ${avgValTrades.toFixed(1)}`);
  console.log(`Average Validation Win Rate: ${avgValWinRate.toFixed(1)}%`);
  console.log(`Average Validation Max Drawdown: ${avgValMdd.toFixed(2)}%`);
  console.log('');

  const valPeriodsWithPositiveReturn = results.filter(r => r.valResult.totalReturn > 0).length;
  console.log(`Validation periods with positive return: ${valPeriodsWithPositiveReturn}/${results.length} (${((valPeriodsWithPositiveReturn / results.length) * 100).toFixed(0)}%)`);

  if (avgValReturn > 0 && valPeriodsWithPositiveReturn / results.length >= 0.5) {
    console.log('');
    console.log('✓ Strategy shows positive edge in walk-forward validation');
  } else {
    console.log('');
    console.log('✗ Strategy does NOT show consistent positive edge in walk-forward validation');
  }
}

main().catch(console.error);
