import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Bot2Config } from './typesBot2';
import { fetchCryptoCompareHourlyCandlesRange, fetchCryptoCompareCandlesAggregatedMinutes } from './cryptoCompare';
import { BacktestCandle, runBot2Backtest } from './bot2BacktestEngine';

const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
const DEFAULT_SLIPPAGE = 0.002;
const DEFAULT_FEE = 0.0004;
const CAPITAL = 100;

type FoldResult = {
  trainPeriod: string;
  valPeriod: string;
  train: ReturnType<typeof runBot2Backtest>['metrics'];
  val: ReturnType<typeof runBot2Backtest>['metrics'];
  params: {
    mode: string;
    rsiPeriod: number;
    rsiOversold: number;
    rsiExitOversold: number;
    minDeviationPct: number;
    profitTarget: number;
    stopLoss: number;
    rsiOverbought: number;
    rsiExitOverbought: number;
    cooldownMinutes: number;
    emaPeriod: number;
    disableBelowPct: number;
    disableAbovePct: number;
    maxHoldMinutes: number;
    vwapMaxDev: number;
  } | null;
};

function cloneConfig(cfg: Bot2Config): Bot2Config {
  return JSON.parse(JSON.stringify(cfg));
}

function scoreMetrics(m: { totalReturnPct: number; maxDrawdownPct: number; closedTrades: number }): number {
  // Conservative score to discourage overfit/high-DD configs.
  return m.totalReturnPct - m.maxDrawdownPct * 0.5 + Math.min(30, m.closedTrades) * 0.1;
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

function optimizeOnTraining(
  candles: BacktestCandle[],
  baseCfg: Bot2Config,
  costs: { slippagePct: number; feePct: number },
  samples: number,
  seed: number,
): { bestCfg: Bot2Config; bestMetrics: ReturnType<typeof runBot2Backtest>['metrics']; bestParams: FoldResult['params'] } {
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

  let bestScore = -Infinity;
  let bestCfg = baseCfg;
  let bestMetrics = runBot2Backtest(candles, baseCfg, { startingCapitalUSDC: CAPITAL, slippagePct: costs.slippagePct, feePct: costs.feePct }).metrics;
  let bestParams: FoldResult['params'] = {
    mode: baseCfg.bot2.strategy.mode ?? 'mean_reversion',
    rsiPeriod: baseCfg.bot2.strategy.rsi.period,
    rsiOversold: baseCfg.bot2.strategy.rsi.oversold,
    rsiExitOversold: baseCfg.bot2.strategy.rsi.exitOversold,
    minDeviationPct: baseCfg.bot2.strategy.entry.minDeviationPct,
    profitTarget: baseCfg.bot2.strategy.exit.profitTargetPct,
    stopLoss: baseCfg.bot2.strategy.exit.stopLossPct,
    rsiOverbought: baseCfg.bot2.strategy.rsi.overbought,
    rsiExitOverbought: baseCfg.bot2.strategy.rsi.exitOverbought,
    cooldownMinutes: baseCfg.bot2.risk.cooldownMinutes,
    emaPeriod: baseCfg.bot2.strategy.trendFilter.emaPeriod,
    disableBelowPct: baseCfg.bot2.strategy.trendFilter.disableBelowPct,
    disableAbovePct: baseCfg.bot2.strategy.trendFilter.disableAbovePct,
    maxHoldMinutes: baseCfg.bot2.strategy.exit.maxHoldMinutes,
    vwapMaxDev: baseCfg.bot2.strategy.vwap.deviationThresholdPct,
  };

  for (let i = 0; i < samples; i++) {
    const rsiPeriod = pick(ranges.rsiPeriod, rnd);
    const rsiOversold = pick(ranges.rsiOversold, rnd);
    const rsiExitOversold = pick(ranges.rsiExitOversold, rnd);
    const minDeviationPct = pick(ranges.minDeviationPct, rnd);
    const profitTarget = pick(ranges.profitTarget, rnd);
    const stopLoss = pick(ranges.stopLoss, rnd);
    const rsiExitOverbought = pick(ranges.rsiExitOverbought, rnd);
    const rsiOverbought = pick(ranges.rsiOverbought, rnd);
    const vwapMaxDev = pick(ranges.vwapMaxDev, rnd);
    const cooldownMinutes = pick(ranges.cooldownMinutes, rnd);
    const mode = pick([...ranges.mode], rnd);
    const emaPeriod = pick(ranges.emaPeriod, rnd);
    const disableBelowPct = pick(ranges.disableBelowPct, rnd);
    const disableAbovePct = pick(ranges.disableAbovePct, rnd);
    const maxHoldMinutes = pick(ranges.maxHoldMinutes, rnd);

    const regimeEmaDays = pick(ranges.regimeEmaDays, rnd);
    const entryBuffer = pick(ranges.entryBuffer, rnd);
    const exitBuffer = pick(ranges.exitBuffer, rnd);

    const cfg = cloneConfig(baseCfg);
    cfg.bot2.strategy.mode = mode as 'mean_reversion' | 'trend_pullback' | 'regime_switch' | 'trend';

    cfg.bot2.strategy.regimeFilter = cfg.bot2.strategy.regimeFilter ?? {
      enabled: true,
      emaPeriodDays: 200,
      requireAboveEma: true,
      requireEmaSlopeUp: false,
    };
    cfg.bot2.strategy.regimeFilter.enabled = mode === 'regime_switch';
    cfg.bot2.strategy.regimeFilter.emaPeriodDays = regimeEmaDays;
    cfg.bot2.strategy.regimeFilter.entryBufferPct = entryBuffer;
    cfg.bot2.strategy.regimeFilter.exitBufferPct = exitBuffer;
    cfg.bot2.strategy.rsi.period = rsiPeriod;
    cfg.bot2.strategy.rsi.oversold = rsiOversold;
    cfg.bot2.strategy.rsi.exitOversold = rsiExitOversold;
    cfg.bot2.strategy.rsi.exitOverbought = rsiExitOverbought;
    cfg.bot2.strategy.rsi.overbought = rsiOverbought;
    cfg.bot2.strategy.vwap.deviationThresholdPct = vwapMaxDev;
    cfg.bot2.strategy.entry.minDeviationPct = minDeviationPct;
    cfg.bot2.strategy.exit.profitTargetPct = profitTarget;
    cfg.bot2.strategy.exit.stopLossPct = stopLoss;
    cfg.bot2.risk.cooldownMinutes = cooldownMinutes;
    cfg.bot2.strategy.trendFilter.emaPeriod = emaPeriod;
    cfg.bot2.strategy.trendFilter.disableBelowPct = disableBelowPct;
    cfg.bot2.strategy.trendFilter.disableAbovePct = disableAbovePct;
    cfg.bot2.strategy.exit.maxHoldMinutes = maxHoldMinutes;

    const res = runBot2Backtest(candles, cfg, { startingCapitalUSDC: CAPITAL, slippagePct: costs.slippagePct, feePct: costs.feePct });
    if (res.metrics.closedTrades < 10) continue;

    const s = scoreMetrics(res.metrics);
    if (s > bestScore) {
      bestScore = s;
      bestCfg = cfg;
      bestMetrics = res.metrics;
      bestParams = {
        mode,
        rsiPeriod,
        rsiOversold,
        rsiExitOversold,
        minDeviationPct,
        profitTarget,
        stopLoss,
        rsiOverbought,
        rsiExitOverbought,
        cooldownMinutes,
        emaPeriod,
        disableBelowPct,
        disableAbovePct,
        maxHoldMinutes,
        vwapMaxDev,

        // regime params are derived from cfg.bot2.strategy.regimeFilter
      };
    }
  }

  return { bestCfg, bestMetrics, bestParams };
}

async function main(): Promise<void> {
  console.log('Bot #2 - Walk-Forward Optimization (15m)');
  console.log('='.repeat(70));

  if (!CC_KEY) {
    console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const tfArg = args.find((a) => a.startsWith('--timeframe='))?.split('=')[1];
  const slipArg = args.find((a) => a.startsWith('--slippage='))?.split('=')[1];
  const feeArg = args.find((a) => a.startsWith('--fee='))?.split('=')[1];
  const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
  const samplesArg = args.find((a) => a.startsWith('--samples='))?.split('=')[1];
  const noOpt = args.includes('--no-opt');

  const timeframe = (tfArg ?? '15m').trim();
  const slippagePct = slipArg ? parseFloat(slipArg) : DEFAULT_SLIPPAGE;
  const feePct = feeArg ? parseFloat(feeArg) : DEFAULT_FEE;
  const days = daysArg ? Math.max(30, parseInt(daysArg, 10)) : 365;
  const samples = samplesArg ? Math.max(50, parseInt(samplesArg, 10)) : 160;

  const baseCfg: Bot2Config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8'),
  );
  baseCfg.bot2.timeframe = timeframe;

  const END_MS = Date.now();

  const tfMatch = timeframe.toLowerCase().match(/^([0-9]+)\s*([mhd])$/);
  const tfMinutes = tfMatch
    ? (() => {
        const n = parseInt(tfMatch[1], 10);
        const u = tfMatch[2];
        if (u === 'm') return n;
        if (u === 'h') return n * 60;
        return n * 1440;
      })()
    : 15;

  if (tfMinutes < 1) {
    console.error(`ERROR: timeframe '${timeframe}' unsupported`);
    process.exit(1);
  }

  let effectiveDays = days;
  if (tfMinutes < 60 && days > 6) {
    console.warn('[WalkForward] CryptoCompare minute history is limited on free tier; capping --days to ~6');
    effectiveDays = 6;
  }

  const START_MS = END_MS - effectiveDays * 24 * 60 * 60 * 1000;

  console.log(`Fetching ${timeframe} candles...`);

  let candles: BacktestCandle[];
  if (tfMinutes <= 60) {
    candles = await fetchCryptoCompareCandlesAggregatedMinutes({
      fsym: 'SOL',
      tsym: 'USD',
      aggregateMinutes: tfMinutes,
      startMs: START_MS,
      endMs: END_MS,
      apiKey: CC_KEY,
    });
  } else {
    const hourly = await fetchCryptoCompareHourlyCandlesRange({
      fsym: 'SOL',
      tsym: 'USD',
      startMs: START_MS,
      endMs: END_MS,
      apiKey: CC_KEY,
      sleepMsBetweenCalls: 350,
    });
    const hours = Math.max(1, Math.round(tfMinutes / 60));
    const agg: BacktestCandle[] = [];
    for (let i = 0; i + hours <= hourly.length; i += hours) {
      const chunk = hourly.slice(i, i + hours);
      agg.push({
        timestamp: chunk[0].timestamp,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
      });
    }
    candles = agg;
  }
  console.log(`Candles: ${candles.length} (${timeframe})`);
  console.log(`Costs: slippage=${(slippagePct * 100).toFixed(2)}% fee=${(feePct * 100).toFixed(3)}%`);
  console.log(`Optimization samples/fold: ${samples}`);
  if (noOpt) console.log('Optimization disabled: using base config for all folds');

  // Walk-forward splits (by candle count)
  const warmup = 120;
  const usable = Math.max(0, candles.length - warmup);
  const trainSize = Math.floor(usable * 0.6);
  const valSize = Math.floor(usable * 0.2);
  const stepSize = Math.floor(usable * 0.1);

  console.log(`Train: ${trainSize} candles | Val: ${valSize} candles | Step: ${stepSize} candles`);
  console.log('');

  const folds: FoldResult[] = [];
  for (let start = warmup; start + trainSize + valSize <= candles.length; start += stepSize) {
    const trainCandles = candles.slice(start - warmup, start + trainSize);
    const valCandles = candles.slice(start + trainSize - warmup, start + trainSize + valSize);

    const seed = 10_000 + start;
    const opt: {
      bestCfg: Bot2Config;
      bestMetrics: ReturnType<typeof runBot2Backtest>['metrics'];
      bestParams: FoldResult['params'] | null;
    } = noOpt
      ? { bestCfg: baseCfg, bestMetrics: runBot2Backtest(trainCandles, baseCfg, { startingCapitalUSDC: CAPITAL, slippagePct, feePct }).metrics, bestParams: null }
      : optimizeOnTraining(
          trainCandles,
          baseCfg,
          { slippagePct, feePct },
          samples,
          seed,
        );

    const bestCfg = opt.bestCfg;
    const trainMetrics = opt.bestMetrics;
    const bestParams = opt.bestParams;
    const valResult = runBot2Backtest(valCandles, bestCfg, { startingCapitalUSDC: CAPITAL, slippagePct, feePct });

    const trainPeriod = `${new Date(trainCandles[0].timestamp).toISOString().slice(0, 10)}-${new Date(trainCandles[trainCandles.length - 1].timestamp).toISOString().slice(0, 10)}`;
    const valPeriod = `${new Date(valCandles[0].timestamp).toISOString().slice(0, 10)}-${new Date(valCandles[valCandles.length - 1].timestamp).toISOString().slice(0, 10)}`;

    folds.push({
      trainPeriod,
      valPeriod,
      train: trainMetrics,
      val: valResult.metrics,
      params: bestParams,
    });

    console.log(`[${valPeriod}] Train Ann ${trainMetrics.annualizedReturnPct.toFixed(1)}% | Ret ${trainMetrics.totalReturnPct.toFixed(1)}% | MDD ${trainMetrics.maxDrawdownPct.toFixed(1)}% | Sharpe ${trainMetrics.sharpe.toFixed(2)} | ${trainMetrics.closedTrades} trades`);
    console.log(`            Val   Ann ${valResult.metrics.annualizedReturnPct.toFixed(1)}% | Ret ${valResult.metrics.totalReturnPct.toFixed(1)}% | MDD ${valResult.metrics.maxDrawdownPct.toFixed(1)}% | Sharpe ${valResult.metrics.sharpe.toFixed(2)} | PF ${valResult.metrics.profitFactor.toFixed(2)} | ${valResult.metrics.closedTrades} trades`);
    if (bestParams) {
      console.log(`            Params mode=${bestParams.mode} ema=${bestParams.emaPeriod}h band=[${bestParams.disableBelowPct},${bestParams.disableAbovePct}] hold=${bestParams.maxHoldMinutes}m`);
      console.log(`                   RSI ${bestParams.rsiPeriod}/${bestParams.rsiOversold}/${bestParams.rsiExitOversold} ob=${bestParams.rsiOverbought} exitOB=${bestParams.rsiExitOverbought} vwapMaxDev=${bestParams.vwapMaxDev}`);
      console.log(`                   Dev ${bestParams.minDeviationPct}% | PT ${bestParams.profitTarget}% | SL ${bestParams.stopLoss}% | CD ${bestParams.cooldownMinutes}m`);
    }
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const avgValReturn = folds.reduce((s, f) => s + f.val.totalReturnPct, 0) / Math.max(1, folds.length);
  const avgValAnn = folds.reduce((s, f) => s + f.val.annualizedReturnPct, 0) / Math.max(1, folds.length);
  const avgValMdd = folds.reduce((s, f) => s + f.val.maxDrawdownPct, 0) / Math.max(1, folds.length);
  const avgValSharpe = folds.reduce((s, f) => s + f.val.sharpe, 0) / Math.max(1, folds.length);
  const positive = folds.filter((f) => f.val.totalReturnPct > 0).length;
  console.log(`Folds: ${folds.length}`);
  console.log(`Avg val annualized: ${avgValAnn.toFixed(2)}%`);
  console.log(`Avg val return: ${avgValReturn.toFixed(2)}%`);
  console.log(`Avg val Sharpe: ${avgValSharpe.toFixed(2)}`);
  console.log(`Avg val max DD: ${avgValMdd.toFixed(2)}%`);
  console.log(`Positive folds: ${positive}/${folds.length} (${folds.length ? ((positive / folds.length) * 100).toFixed(0) : '0'}%)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
