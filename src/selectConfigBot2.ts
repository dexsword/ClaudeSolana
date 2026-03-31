import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { Bot2Config } from './typesBot2';
import { fetchCryptoCompareHourlyCandlesRange } from './cryptoCompare';
import { BacktestCandle, runBot2Backtest } from './bot2BacktestEngine';

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

function cloneCfg(cfg: Bot2Config): Bot2Config {
  return JSON.parse(JSON.stringify(cfg));
}

function aggregateHourly(hourly: BacktestCandle[], hours: number): BacktestCandle[] {
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

type Fold = { train: BacktestCandle[]; val: BacktestCandle[] };

function buildFolds(candles: BacktestCandle[]): Fold[] {
  const warmup = 120;
  const usable = Math.max(0, candles.length - warmup);
  const trainSize = Math.floor(usable * 0.6);
  const valSize = Math.floor(usable * 0.2);
  const stepSize = Math.floor(usable * 0.1);

  const folds: Fold[] = [];
  for (let start = warmup; start + trainSize + valSize <= candles.length; start += stepSize) {
    const train = candles.slice(start - warmup, start + trainSize);
    const val = candles.slice(start + trainSize - warmup, start + trainSize + valSize);
    folds.push({ train, val });
  }
  return folds;
}

function scoreCandidate(results: Array<ReturnType<typeof runBot2Backtest>['metrics']>): {
  score: number;
  positiveFolds: number;
  avgAnn: number;
  avgMdd: number;
  avgPf: number;
} {
  const avgAnn = results.reduce((s, r) => s + r.annualizedReturnPct, 0) / Math.max(1, results.length);
  const avgMdd = results.reduce((s, r) => s + r.maxDrawdownPct, 0) / Math.max(1, results.length);
  const avgPf = results.reduce((s, r) => s + r.profitFactor, 0) / Math.max(1, results.length);
  const positiveFolds = results.filter((r) => r.totalReturnPct > 0).length;
  const score = avgAnn - avgMdd * 0.75 + Math.min(2, Math.max(0, avgPf - 1)) * 2 + positiveFolds * 2;
  return { score, positiveFolds, avgAnn, avgMdd, avgPf };
}

async function main(): Promise<void> {
  const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
  if (!CC_KEY) {
    console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const tfArg = args.find((a) => a.startsWith('--timeframe='))?.split('=')[1] ?? '4h';
  const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
  const candidatesArg = args.find((a) => a.startsWith('--candidates='))?.split('=')[1];
  const seedArg = args.find((a) => a.startsWith('--seed='))?.split('=')[1];

  const timeframe = tfArg.trim().toLowerCase();
  const days = daysArg ? Math.max(365, parseInt(daysArg, 10)) : 1095;
  const candidates = candidatesArg ? Math.max(20, parseInt(candidatesArg, 10)) : 80;
  const seed = seedArg ? parseInt(seedArg, 10) : 1337;

  const tfMatch = timeframe.match(/^([0-9]+)\s*([mhd])$/);
  if (!tfMatch) throw new Error(`Invalid timeframe: ${timeframe}`);
  const n = parseInt(tfMatch[1], 10);
  const u = tfMatch[2];
  const tfMinutes = u === 'm' ? n : u === 'h' ? n * 60 : n * 1440;
  if (tfMinutes < 60) throw new Error('This selector is intended for >=1h timeframes');

  const hours = Math.max(1, Math.round(tfMinutes / 60));

  const baseCfg: Bot2Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8'));
  baseCfg.bot2.timeframe = timeframe;

  const END_MS = Date.now();
  const START_MS = END_MS - days * 24 * 60 * 60 * 1000;

  console.log(`Selecting config for ${timeframe} over ${days} days`);
  console.log(`Candidates: ${candidates} | Seed: ${seed}`);
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

  const candles = aggregateHourly(hourly, hours);
  console.log(`${timeframe} candles: ${candles.length}`);

  const folds = buildFolds(candles);
  console.log(`Folds: ${folds.length}`);

  const slippages = [0.002, 0.003];
  const fee = 0.0004;
  const capital = 100;

  const rnd = mulberry32(seed);
  let best: { cfg: Bot2Config; score: number; details: string } | null = null;

  const ranges = {
    mode: ['trend_pullback', 'mean_reversion'] as const,
    rsiPeriod: [6, 8, 10, 14],
    rsiOversold: [25, 30, 35],
    rsiExitOversold: [25, 30, 35, 40],
    minDev: [0.75, 1.0, 1.25, 1.5],
    pt: [0.75, 1.0, 1.25, 1.5, 2.0],
    sl: [1.5, 2.0, 2.5, 3.0, 4.0],
    exitOB: [45, 50, 55, 60, 65],
    emaPeriod: [30, 50, 80],
    bandBelow: [-8, -6, -4, -3],
    bandAbove: [3, 5, 8, 12],
    hold: [480, 720, 1440, 2880],
    cooldown: [5, 10, 15],
  };

  for (let i = 0; i < candidates; i++) {
    const cfg = cloneCfg(baseCfg);
    cfg.bot2.strategy.mode = pick([...ranges.mode], rnd);
    cfg.bot2.strategy.rsi.period = pick(ranges.rsiPeriod, rnd);
    cfg.bot2.strategy.rsi.oversold = pick(ranges.rsiOversold, rnd);
    cfg.bot2.strategy.rsi.exitOversold = pick(ranges.rsiExitOversold, rnd);
    cfg.bot2.strategy.entry.minDeviationPct = pick(ranges.minDev, rnd);
    cfg.bot2.strategy.exit.profitTargetPct = pick(ranges.pt, rnd);
    cfg.bot2.strategy.exit.stopLossPct = pick(ranges.sl, rnd);
    cfg.bot2.strategy.rsi.exitOverbought = pick(ranges.exitOB, rnd);
    cfg.bot2.strategy.trendFilter.emaPeriod = pick(ranges.emaPeriod, rnd);
    cfg.bot2.strategy.trendFilter.disableBelowPct = pick(ranges.bandBelow, rnd);
    cfg.bot2.strategy.trendFilter.disableAbovePct = pick(ranges.bandAbove, rnd);
    cfg.bot2.strategy.exit.maxHoldMinutes = pick(ranges.hold, rnd);
    cfg.bot2.risk.cooldownMinutes = pick(ranges.cooldown, rnd);

    // Evaluate worst-case across slippage assumptions
    let worstScore = Infinity;
    let worstPos = 0;
    let worstDetails = '';

    for (const slip of slippages) {
      const vals = folds.map((f) => runBot2Backtest(f.val, cfg, { startingCapitalUSDC: capital, slippagePct: slip, feePct: fee }).metrics);
      const sc = scoreCandidate(vals);
      if (sc.score < worstScore) {
        worstScore = sc.score;
        worstPos = sc.positiveFolds;
        worstDetails = `slip=${(slip * 100).toFixed(2)}% ann=${sc.avgAnn.toFixed(2)} mdd=${sc.avgMdd.toFixed(2)} pf=${sc.avgPf.toFixed(2)} pos=${worstPos}/${folds.length}`;
      }
    }

    if (!best || worstScore > best.score) {
      best = {
        cfg,
        score: worstScore,
        details: worstDetails,
      };
      console.log(`New best (#${i + 1}/${candidates}): score=${worstScore.toFixed(2)} | ${worstDetails}`);
    }
  }

  if (!best) {
    console.error('No candidate produced a score');
    process.exit(1);
  }

  const outPath = path.join(__dirname, '../config-bot2-selected.json');
  fs.writeFileSync(outPath, JSON.stringify(best.cfg, null, 2));
  console.log(`Saved: ${outPath}`);
  console.log(`Best score: ${best.score.toFixed(2)} | ${best.details}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
