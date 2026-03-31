import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { SolanaBotV1Config } from './typesSolanaBotV1';
import { fetchCryptoCompareHourlyCandlesRange } from './cryptoCompare';
import { BacktestCandle, runSolanaBotV1Backtest } from './solanaBotV1BacktestEngine';

const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
const SLIPPAGE = 0.002;
const FEE = 0.0004;
const CAPITAL = 100;

type TimeframeSpec = { tf: string; hours: number };
const TIMEFRAMES: TimeframeSpec[] = [
  { tf: '1h', hours: 1 },
  { tf: '4h', hours: 4 },
  { tf: '3d', hours: 72 },
];

function aggregateHourlyToTf(hourly: BacktestCandle[], hours: number): BacktestCandle[] {
  if (hours <= 1) return hourly;
  const out: BacktestCandle[] = [];
  for (let i = 0; i + hours <= hourly.length; i += hours) {
    const chunk = hourly.slice(i, i + hours);
    out.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

function cloneConfig(cfg: SolanaBotV1Config): SolanaBotV1Config {
  return JSON.parse(JSON.stringify(cfg));
}

function score(m: { totalReturnPct: number; maxDrawdownPct: number; closedTrades: number; profitFactor: number }): number {
  return m.totalReturnPct - m.maxDrawdownPct * 0.5 + Math.min(30, m.closedTrades) * 0.1 + Math.min(2, Math.max(0, m.profitFactor - 1)) * 2;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

function optimizeOnTraining(candles: BacktestCandle[], baseCfg: SolanaBotV1Config, samples: number, seed: number): SolanaBotV1Config {
  const ranges = {
    mode: ['mean_reversion', 'trend_pullback', 'regime_switch'] as const,
    rsiPeriod: [6, 8, 10, 14],
    rsiOversold: [20, 25, 30, 35],
    rsiExitOversold: [25, 30, 35, 40],
    minDeviationPct: [0.75, 1.0, 1.25, 1.5],
    profitTarget: [0.75, 1.0, 1.25, 1.5, 2.0],
    stopLoss: [1.5, 2.0, 2.5, 3.0, 4.0],
    rsiExitOverbought: [45, 50, 55, 60, 65],
    rsiOverbought: [40, 45, 50, 55, 60],
    vwapMaxDev: [1, 2, 3, 4, 6],
    cooldownMinutes: [5, 10, 15],
    emaPeriod: [20, 30, 50, 80],
    disableBelowPct: [-8, -6, -4, -3, -2],
    disableAbovePct: [3, 5, 8, 12],
    maxHoldMinutes: [240, 480, 720, 1440, 2880],

    regimeEmaDays: [100, 150, 200],
    entryBuffer: [0, 0.5, 1.0],
    exitBuffer: [0, 0.5, 1.0],
  };

  const rnd = mulberry32(seed);
  let bestCfg = baseCfg;
  let bestScore = -Infinity;

  for (let i = 0; i < samples; i++) {
    const cfg = cloneConfig(baseCfg);
    cfg.solanaBotV1.strategy.mode = pick([...ranges.mode], rnd);

    // Regime switch params
    cfg.solanaBotV1.strategy.regimeFilter = cfg.solanaBotV1.strategy.regimeFilter ?? {
      enabled: true,
      emaPeriodDays: 200,
      requireAboveEma: true,
      requireEmaSlopeUp: false,
    };
    cfg.solanaBotV1.strategy.regimeFilter.enabled = true;
    cfg.solanaBotV1.strategy.regimeFilter.emaPeriodDays = pick(ranges.regimeEmaDays, rnd);
    cfg.solanaBotV1.strategy.regimeFilter.entryBufferPct = pick(ranges.entryBuffer, rnd);
    cfg.solanaBotV1.strategy.regimeFilter.exitBufferPct = pick(ranges.exitBuffer, rnd);
    cfg.solanaBotV1.strategy.rsi.period = pick(ranges.rsiPeriod, rnd);
    cfg.solanaBotV1.strategy.rsi.oversold = pick(ranges.rsiOversold, rnd);
    cfg.solanaBotV1.strategy.rsi.exitOversold = pick(ranges.rsiExitOversold, rnd);
    cfg.solanaBotV1.strategy.rsi.exitOverbought = pick(ranges.rsiExitOverbought, rnd);
    cfg.solanaBotV1.strategy.rsi.overbought = pick(ranges.rsiOverbought, rnd);
    cfg.solanaBotV1.strategy.vwap.deviationThresholdPct = pick(ranges.vwapMaxDev, rnd);
    cfg.solanaBotV1.strategy.entry.minDeviationPct = pick(ranges.minDeviationPct, rnd);
    cfg.solanaBotV1.strategy.exit.profitTargetPct = pick(ranges.profitTarget, rnd);
    cfg.solanaBotV1.strategy.exit.stopLossPct = pick(ranges.stopLoss, rnd);
    cfg.solanaBotV1.risk.cooldownMinutes = pick(ranges.cooldownMinutes, rnd);
    cfg.solanaBotV1.strategy.trendFilter.emaPeriod = pick(ranges.emaPeriod, rnd);
    cfg.solanaBotV1.strategy.trendFilter.disableBelowPct = pick(ranges.disableBelowPct, rnd);
    cfg.solanaBotV1.strategy.trendFilter.disableAbovePct = pick(ranges.disableAbovePct, rnd);
    cfg.solanaBotV1.strategy.exit.maxHoldMinutes = pick(ranges.maxHoldMinutes, rnd);

    const res = runSolanaBotV1Backtest(candles, cfg, { startingCapitalUSDC: CAPITAL, slippagePct: SLIPPAGE, feePct: FEE });
    if (res.metrics.closedTrades < 10) continue;

    const sc = score(res.metrics);
    if (sc > bestScore) {
      bestScore = sc;
      bestCfg = cfg;
    }
  }

  return bestCfg;
}

async function main(): Promise<void> {
  console.log('SolanaBotV1 - Timeframe Evaluation (CryptoCompare histominute aggregate)');
  console.log('='.repeat(80));

  if (!CC_KEY) {
    console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
    process.exit(1);
  }

  const baseCfg: SolanaBotV1Config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config-solana-bot-v1.json'), 'utf-8'),
  );

  const END_MS = Date.now();

  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='))?.split('=')[1];
  const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
  const samplesArg = args.find((a) => a.startsWith('--samples='))?.split('=')[1];
  const only = onlyArg
    ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const days = daysArg ? Math.max(120, parseInt(daysArg, 10)) : 1095; // default 3y so 3d has enough candles
  const samples = samplesArg ? Math.max(50, parseInt(samplesArg, 10)) : 180;
  const START_MS = END_MS - days * 24 * 60 * 60 * 1000;

  const results: Array<{
    timeframe: string;
    fixed: ReturnType<typeof runSolanaBotV1Backtest>['metrics'];
    optimizedVal: ReturnType<typeof runSolanaBotV1Backtest>['metrics'];
    robustness: number;
  }> = [];

  console.log(`History window: last ${days} days`);
  console.log(`Optimization samples/timeframe: ${samples}`);
  console.log('');

  console.log('Fetching hourly candles...');
  const hourly = await fetchCryptoCompareHourlyCandlesRange({
    fsym: 'SOL',
    tsym: 'USD',
    startMs: START_MS,
    endMs: END_MS,
    apiKey: CC_KEY,
    sleepMsBetweenCalls: 350,
  });
  console.log(`Hourly candles: ${hourly.length}`);
  console.log('');

  for (const { tf, hours } of TIMEFRAMES) {
    if (only && !only.has(tf)) continue;
    const candles = aggregateHourlyToTf(hourly, hours);
    console.log(`[${tf}] Candles: ${candles.length}`);
    if (candles.length < 250) {
      console.log(`[${tf}] Skipping (too few candles for eval)`);
      continue;
    }

    // Update cfg timeframe to keep VWAP session consistent.
    const cfgFixed = cloneConfig(baseCfg);
    cfgFixed.solanaBotV1.timeframe = tf;

    const fixed = runSolanaBotV1Backtest(candles, cfgFixed, { startingCapitalUSDC: CAPITAL, slippagePct: SLIPPAGE, feePct: FEE }).metrics;

    // Train/val split with warmup overlap
    const warmup = 120;
    const trainEnd = Math.floor(candles.length * 0.6);
    const train = candles.slice(0, Math.max(warmup + 50, trainEnd));
    const val = candles.slice(Math.max(0, trainEnd - warmup));

    const cfgTrain = cloneConfig(baseCfg);
    cfgTrain.solanaBotV1.timeframe = tf;
    const optimizedCfg = optimizeOnTraining(train, cfgTrain, samples, 1337 + hours * 17);
    const optimizedVal = runSolanaBotV1Backtest(val, optimizedCfg, { startingCapitalUSDC: CAPITAL, slippagePct: SLIPPAGE, feePct: FEE }).metrics;

    const robustness = score(optimizedVal);
    results.push({ timeframe: tf, fixed, optimizedVal, robustness });

    console.log(
      `[${tf}] Fixed:  Ann ${fixed.annualizedReturnPct.toFixed(1)}% | Ret ${fixed.totalReturnPct.toFixed(1)}% | Sharpe ${fixed.sharpe.toFixed(2)} | MDD ${fixed.maxDrawdownPct.toFixed(1)}% | Trades/Yr ${fixed.tradesPerYear.toFixed(0)} | WR ${fixed.winRatePct.toFixed(0)}% | PF ${fixed.profitFactor.toFixed(2)} | Avg/Trade $${fixed.avgProfitPerTradeUSDC.toFixed(3)} | Net $${fixed.netAfterCostsUSDC.toFixed(2)}`,
    );
    console.log(
      `     Val*: Ann ${optimizedVal.annualizedReturnPct.toFixed(1)}% | Ret ${optimizedVal.totalReturnPct.toFixed(1)}% | Sharpe ${optimizedVal.sharpe.toFixed(2)} | MDD ${optimizedVal.maxDrawdownPct.toFixed(1)}% | Trades/Yr ${optimizedVal.tradesPerYear.toFixed(0)} | WR ${optimizedVal.winRatePct.toFixed(0)}% | PF ${optimizedVal.profitFactor.toFixed(2)} | Avg/Trade $${optimizedVal.avgProfitPerTradeUSDC.toFixed(3)} | Net $${optimizedVal.netAfterCostsUSDC.toFixed(2)} | Score ${robustness.toFixed(2)}`,
    );
  }

  results.sort((a, b) => b.robustness - a.robustness);
  console.log('');
  console.log('='.repeat(80));
  console.log('RANKED (by robustness score on validation)');
  console.log('='.repeat(80));
  results.slice(0, 10).forEach((r, i) => {
    console.log(`${i + 1}. ${r.timeframe}: ValAnn ${r.optimizedVal.annualizedReturnPct.toFixed(1)}% | ValRet ${r.optimizedVal.totalReturnPct.toFixed(1)}% | ValSharpe ${r.optimizedVal.sharpe.toFixed(2)} | ValMDD ${r.optimizedVal.maxDrawdownPct.toFixed(1)}% | Trades/Yr ${r.optimizedVal.tradesPerYear.toFixed(0)} | PF ${r.optimizedVal.profitFactor.toFixed(2)} | Score ${r.robustness.toFixed(2)}`);
  });

  const outPath = path.join(__dirname, '../timeframe-evaluation.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('');
  console.log(`Saved results: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
