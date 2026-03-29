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

interface OptimizerResult {
  params: {
    rsiPeriod: number;
    rsiOversold: number;
    rsiExitOversold: number;
    minDeviationPct: number;
    profitTarget: number;
    stopLoss: number;
    rsiExitOverbought: number;
    cooldownMinutes: number;
  };
  return: number;
  trades: number;
  winRate: number;
  sharpe: number;
}

function cloneConfig(cfg: Bot2Config): Bot2Config {
  return JSON.parse(JSON.stringify(cfg));
}

function runBacktest(candles: Candle[], cfg: Bot2Config): { return: number; trades: number; winRate: number; sharpe: number } {
  const warmup = 100;
  let usdc = CAPITAL;
  let position = buildInitialBot2Position();
  const trades: number[] = [];

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
    } else if (signal.action === 'sell' && position.inPosition && position.entryPrice) {
      const size = position.size;
      const slippagePrice = price * (1 + SLIPPAGE);
      const pnl = (slippagePrice - position.entryPrice) * size;

      usdc += size * slippagePrice;
      position = updateBot2Position(position, 'sell', slippagePrice, size, cfg, candle.timestamp);
      trades.push(pnl);
    } else if (position.inPosition) {
      position = updateBot2Position(position, 'hold', price, position.size, cfg, candle.timestamp);
    }
  }

  const finalValue = usdc + (position.inPosition ? position.size * candles[candles.length - 1].close : 0);
  const totalReturn = ((finalValue - CAPITAL) / CAPITAL) * 100;

  const wins = trades.filter(t => t > 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;

  let sharpe = 0;
  if (trades.length > 1) {
    const mean = trades.reduce((s, t) => s + t, 0) / trades.length;
    const std = Math.sqrt(trades.map(t => Math.pow(t - mean, 2)).reduce((s, t) => s + t, 0) / trades.length);
    sharpe = std > 0 ? mean / std : 0;
  }

  return { return: totalReturn, trades: trades.length, winRate, sharpe };
}

async function main() {
  console.log('Bot #2 - Parameter Optimization');
  console.log('='.repeat(60));
  console.log('');

  const START_MS = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const END_MS = Date.now();

  console.log('Fetching candles...');
  const hourly = await fetchHourly(START_MS, END_MS);
  const candles = aggregateTo15m(hourly);
  console.log(`Total 15m candles: ${candles.length}`);
  console.log('');

  const baseCfg: Bot2Config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8')
  );

  const paramGrid = {
    rsiPeriod: [4, 6],
    rsiOversold: [25, 30],
    rsiExitOversold: [30, 35],
    minDeviationPct: [0.5, 0.75, 1.0],
    profitTarget: [1.0, 1.5, 2.0],
    stopLoss: [2.0, 2.5, 3.0],
    rsiExitOverbought: [50, 55, 60],
    cooldownMinutes: [5, 10],
  };

  const results: OptimizerResult[] = [];
  let combos = 1;
  for (const k of Object.values(paramGrid)) combos *= k.length;
  console.log(`Testing ${combos} parameter combinations...`);
  console.log('');

  let count = 0;
  for (const rsiPeriod of paramGrid.rsiPeriod) {
    for (const rsiOversold of paramGrid.rsiOversold) {
      for (const rsiExitOversold of paramGrid.rsiExitOversold) {
        for (const minDeviationPct of paramGrid.minDeviationPct) {
          for (const profitTarget of paramGrid.profitTarget) {
            for (const stopLoss of paramGrid.stopLoss) {
              for (const rsiExitOverbought of paramGrid.rsiExitOverbought) {
                for (const cooldownMinutes of paramGrid.cooldownMinutes) {
                  count++;

                  const cfg = cloneConfig(baseCfg);
                  cfg.bot2.strategy.rsi.period = rsiPeriod;
                  cfg.bot2.strategy.rsi.oversold = rsiOversold;
                  cfg.bot2.strategy.rsi.exitOversold = rsiExitOversold;
                  cfg.bot2.strategy.rsi.exitOverbought = rsiExitOverbought;
                  cfg.bot2.strategy.entry.minDeviationPct = minDeviationPct;
                  cfg.bot2.strategy.exit.profitTargetPct = profitTarget;
                  cfg.bot2.strategy.exit.stopLossPct = stopLoss;
                  cfg.bot2.risk.cooldownMinutes = cooldownMinutes;

                  const { return: ret, trades, winRate, sharpe } = runBacktest(candles, cfg);

                  results.push({
                    params: { rsiPeriod, rsiOversold, rsiExitOversold, minDeviationPct, profitTarget, stopLoss, rsiExitOverbought, cooldownMinutes },
                    return: ret,
                    trades,
                    winRate,
                    sharpe,
                  });

                  if (count % 500 === 0) {
                    process.stdout.write(`\rProgress: ${count}/${combos} (${((count / combos) * 100).toFixed(0)}%)`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  console.log('');
  console.log('');

  results.sort((a, b) => b.return - a.return);

  console.log('TOP 15 PARAMETER SETS (by return):');
  console.log('-'.repeat(70));
  for (let i = 0; i < Math.min(15, results.length); i++) {
    const r = results[i];
    console.log(`${i + 1}. Return: ${r.return.toFixed(2)}% | Trades: ${r.trades} | WR: ${r.winRate.toFixed(0)}% | Sharpe: ${r.sharpe.toFixed(2)}`);
    console.log(`   RSI: ${r.params.rsiPeriod}/${r.params.rsiOversold}/${r.params.rsiExitOversold}`);
    console.log(`   Dev: ${r.params.minDeviationPct}% | PT: ${r.params.profitTarget}% | SL: ${r.params.stopLoss}%`);
    console.log(`   RSI_xb: ${r.params.rsiExitOverbought} | CD: ${r.params.cooldownMinutes}m`);
    console.log('');
  }

  const best = results[0];
  console.log('BEST PARAMETERS:');
  console.log(JSON.stringify(best.params, null, 2));
  console.log('');

  const bestCfg = cloneConfig(baseCfg);
  bestCfg.bot2.strategy.rsi.period = best.params.rsiPeriod;
  bestCfg.bot2.strategy.rsi.oversold = best.params.rsiOversold;
  bestCfg.bot2.strategy.rsi.exitOversold = best.params.rsiExitOversold;
  bestCfg.bot2.strategy.rsi.exitOverbought = best.params.rsiExitOverbought;
  bestCfg.bot2.strategy.entry.minDeviationPct = best.params.minDeviationPct;
  bestCfg.bot2.strategy.exit.profitTargetPct = best.params.profitTarget;
  bestCfg.bot2.strategy.exit.stopLossPct = best.params.stopLoss;
  bestCfg.bot2.risk.cooldownMinutes = best.params.cooldownMinutes;

  fs.writeFileSync(
    path.join(__dirname, '../config-bot2-optimized.json'),
    JSON.stringify(bestCfg, null, 2)
  );
  console.log('Saved optimized config to config-bot2-optimized.json');
}

main().catch(console.error);
