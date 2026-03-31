import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { fetchCryptoCompareCandlesAggregatedMinutes } from './cryptoCompare';
import { SolanaBotV1Config } from './typesSolanaBotV1';
import { BacktestCandle, runSolanaBotV1Backtest } from './solanaBotV1BacktestEngine';

const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
const SLIPPAGE = 0.002;
const FEE = 0.0004;
const CAPITAL = 100;

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
  maxDrawdown: number;
}

function cloneConfig(cfg: SolanaBotV1Config): SolanaBotV1Config {
  return JSON.parse(JSON.stringify(cfg));
}

function runBacktest(candles: BacktestCandle[], cfg: SolanaBotV1Config): { ret: number; trades: number; winRate: number; maxDrawdown: number } {
  const result = runSolanaBotV1Backtest(candles, cfg, {
    startingCapitalUSDC: CAPITAL,
    slippagePct: SLIPPAGE,
    feePct: FEE,
  });

  return {
    ret: result.metrics.totalReturnPct,
    trades: result.metrics.closedTrades,
    winRate: result.metrics.winRatePct,
    maxDrawdown: result.metrics.maxDrawdownPct,
  };
}

async function main() {
  console.log('SolanaBotV1 - Parameter Optimization');
  console.log('='.repeat(60));
  console.log('');

  if (!CC_KEY) {
    console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
    process.exit(1);
  }

  const START_MS = Date.now() - 180 * 24 * 60 * 60 * 1000;
  const END_MS = Date.now();

  console.log('Fetching candles...');
  let candles: import('./solanaBotV1BacktestEngine').BacktestCandle[];
  try {
    candles = await fetchCryptoCompareCandlesAggregatedMinutes({
      fsym: 'SOL',
      tsym: 'USD',
      aggregateMinutes: 15,
      startMs: START_MS,
      endMs: END_MS,
      apiKey: CC_KEY,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('only available for the last 7 days')) {
      const cappedStart = END_MS - 6 * 24 * 60 * 60 * 1000;
      console.warn('[Optimize] CryptoCompare minute history is limited on free tier; falling back to last ~6 days');
      candles = await fetchCryptoCompareCandlesAggregatedMinutes({
        fsym: 'SOL',
        tsym: 'USD',
        aggregateMinutes: 15,
        startMs: cappedStart,
        endMs: END_MS,
        apiKey: CC_KEY,
      });
    } else {
      throw err;
    }
  }
  console.log(`Total 15m candles: ${candles.length}`);
  console.log('');

  const baseCfg: SolanaBotV1Config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config-solana-bot-v1.json'), 'utf-8')
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
                  cfg.solanaBotV1.strategy.rsi.period = rsiPeriod;
                  cfg.solanaBotV1.strategy.rsi.oversold = rsiOversold;
                  cfg.solanaBotV1.strategy.rsi.exitOversold = rsiExitOversold;
                  cfg.solanaBotV1.strategy.rsi.exitOverbought = rsiExitOverbought;
                  cfg.solanaBotV1.strategy.entry.minDeviationPct = minDeviationPct;
                  cfg.solanaBotV1.strategy.exit.profitTargetPct = profitTarget;
                  cfg.solanaBotV1.strategy.exit.stopLossPct = stopLoss;
                  cfg.solanaBotV1.risk.cooldownMinutes = cooldownMinutes;

                  const { ret, trades, winRate, maxDrawdown } = runBacktest(candles, cfg);

                  results.push({
                    params: { rsiPeriod, rsiOversold, rsiExitOversold, minDeviationPct, profitTarget, stopLoss, rsiExitOverbought, cooldownMinutes },
                    return: ret,
                    trades,
                    winRate,
                    maxDrawdown,
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
    console.log(`${i + 1}. Return: ${r.return.toFixed(2)}% | Trades: ${r.trades} | WR: ${r.winRate.toFixed(0)}% | MDD: ${r.maxDrawdown.toFixed(1)}%`);
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
  bestCfg.solanaBotV1.strategy.rsi.period = best.params.rsiPeriod;
  bestCfg.solanaBotV1.strategy.rsi.oversold = best.params.rsiOversold;
  bestCfg.solanaBotV1.strategy.rsi.exitOversold = best.params.rsiExitOversold;
  bestCfg.solanaBotV1.strategy.rsi.exitOverbought = best.params.rsiExitOverbought;
  bestCfg.solanaBotV1.strategy.entry.minDeviationPct = best.params.minDeviationPct;
  bestCfg.solanaBotV1.strategy.exit.profitTargetPct = best.params.profitTarget;
  bestCfg.solanaBotV1.strategy.exit.stopLossPct = best.params.stopLoss;
  bestCfg.solanaBotV1.risk.cooldownMinutes = best.params.cooldownMinutes;

  fs.writeFileSync(
    path.join(__dirname, '../config-solana-bot-v1-optimized.json'),
    JSON.stringify(bestCfg, null, 2)
  );
  console.log('Saved optimized config to config-solana-bot-v1-optimized.json');
}

main().catch(console.error);
