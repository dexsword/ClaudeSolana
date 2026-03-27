/**
 * Parameter optimizer for the SOL swing trading strategy.
 *
 * Fetches candle data ONCE, then sweeps a grid of parameter combinations
 * entirely in memory — no additional API calls during optimization.
 *
 * Modes:
 *
 *   SINGLE-SPLIT (default):
 *     In-sample  : --from  (default 2022-03-01) → --split (default 2025-01-01)
 *     Out-of-sample: --split → now
 *
 *   WALK-FORWARD (--walk-forward):
 *     Split A:  Train Mar 2022 → Dec 2023  |  Validate Jan 2024+1d → Jun 2024
 *               (tests whether params found during crash/base survive recovery)
 *     Split B:  Train Mar 2022 → Jun 2024  |  Validate Jul 2024+1d → Mar 2025
 *               (tests behavior in explosive bullish/volatile period)
 *     Split C:  Train Mar 2022 → Mar 2025  |  Validate Apr 2025+1d → now
 *               (tests recent breakdown/bearish regime)
 *     Aggregate score = 60% average split score + 40% minimum split score
 *     Penalty: any split with sharpe < -1 OR drawdown worse than B&H by >10pp → score × 0.7
 *
 * Grid size: 3^13 = 1 594 323 combinations (9 zone/risk axes + 4 regime axes).
 * Each simulation is ~2 ms, so the full sweep completes in ~50–60 minutes.
 *
 * Usage:
 *   CRYPTOCOMPARE_API_KEY=xxx npm run optimize
 *   CRYPTOCOMPARE_API_KEY=xxx npx ts-node src/optimize.ts [--from=YYYY-MM-DD] [--split=YYYY-MM-DD]
 *   CRYPTOCOMPARE_API_KEY=xxx npx ts-node src/optimize.ts --walk-forward
 *
 * Output:
 *   optimize_results.csv  — top combinations ranked by aggregate validation score
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Candle, BotConfig, PositionState, RsiDirection } from './types';
import { evaluateStrategy, updateTrailingStop, buildInitialPosition } from './strategy';
import { calculateRSI, calculateVWAP, calculateSMA } from './indicators';

// ── CLI ───────────────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const fromArg   = args.find(a => a.startsWith('--from='))?.split('=')[1];
const splitArg  = args.find(a => a.startsWith('--split='))?.split('=')[1];
const randomArg = args.find(a => a.startsWith('--random='))?.split('=')[1];
const maxArg    = args.find(a => a.startsWith('--max='))?.split('=')[1];
const topArg    = args.find(a => a.startsWith('--top='))?.split('=')[1];
const fastMode  = args.includes('--fast');
const resumeMode = args.includes('--resume');
const walkForwardMode = args.includes('--walk-forward');

const START_MS  = fromArg  ? new Date(fromArg).getTime()  : new Date('2022-03-01').getTime();
const SPLIT_MS  = splitArg ? new Date(splitArg).getTime() : new Date('2025-01-01').getTime();
const RANDOM_N  = randomArg ? parseInt(randomArg, 10) : null;
const MAX_COMBOS = maxArg  ? parseInt(maxArg, 10)   : null;
const TOP_K_SIZE = topArg  ? parseInt(topArg, 10)   : 50;

const CC_KEY    = process.env.CRYPTOCOMPARE_API_KEY ?? '';
if (!CC_KEY) {
  console.error('ERROR: CRYPTOCOMPARE_API_KEY is not set.');
  process.exit(1);
}

const SLIPPAGE = 0.002;

// ── Walk-forward split definitions ───────────────────────────────────────────
interface SplitDef {
  name:     string;
  purpose:  string;
  trainMs:  [number, number];
  valMs:    [number, number];
}

const WALK_FORWARD_SPLITS: SplitDef[] = [
  {
    name:    'Split A',
    purpose: 'Crash/base → recovery',
    trainMs: [new Date('2022-03-01').getTime(), new Date('2024-01-01').getTime()],
    valMs:   [new Date('2024-01-02').getTime(), new Date('2024-07-01').getTime()],
  },
  {
    name:    'Split B',
    purpose: 'Explosive bull/volatile',
    trainMs: [new Date('2022-03-01').getTime(), new Date('2024-07-01').getTime()],
    valMs:   [new Date('2024-07-02').getTime(), new Date('2025-04-01').getTime()],
  },
  {
    name:    'Split C',
    purpose: 'Recent bearish regime',
    trainMs: [new Date('2022-03-01').getTime(), new Date('2025-04-01').getTime()],
    valMs:   [new Date('2025-04-02').getTime(), Date.now()],
  },
];

// ── Load base config ──────────────────────────────────────────────────────────
const baseCfg: BotConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'),
);
const CAPITAL = baseCfg.capital.startingCapitalUSDC;

// ── CryptoCompare fetcher (same as backtest.ts) ────────────────────────────────
const CC_BASE = 'https://min-api.cryptocompare.com/data/v2';

interface CCHistoResp {
  Response: string;
  Message:  string;
  Data: { Data: Array<{ time: number; open: number; high: number; low: number; close: number; volumefrom: number }> };
}

async function fetchCCCandles(
  endpoint: 'histohour' | 'histoday',
  startMs: number,
  endMs: number,
): Promise<Candle[]> {
  const all: Candle[] = [];
  const startSec = Math.floor(startMs / 1000);
  let toTs = Math.floor(endMs / 1000);

  while (true) {
    const { data } = await axios.get<CCHistoResp>(`${CC_BASE}/${endpoint}`, {
      params:  { fsym: 'SOL', tsym: 'USD', limit: 2000, toTs, api_key: CC_KEY },
      timeout: 20000,
    });
    if (data.Response !== 'Success') throw new Error(`CryptoCompare: ${data.Message}`);
    const rows = data.Data.Data;
    if (!rows.length) break;
    for (const r of rows) {
      if (r.time < startSec || r.time * 1000 > endMs) continue;
      if (r.open === 0 && r.close === 0) continue;
      all.push({ timestamp: r.time * 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volumefrom });
    }
    process.stdout.write('.');
    const firstTime = rows[0].time;
    if (firstTime <= startSec || rows.length < 2000) break;
    toTs = firstTime - 1;
    await new Promise(r => setTimeout(r, 150));
  }

  return all.sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateTo4h(hourly: Candle[]): Candle[] {
  const h4ms = 4 * 60 * 60 * 1000;
  const buckets = new Map<number, Candle[]>();
  for (const c of hourly) {
    const key = Math.floor(c.timestamp / h4ms) * h4ms;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, cs]) => cs.length >= 3)
    .map(([ts, cs]) => ({
      timestamp: ts,
      open:   cs[0].open,
      high:   Math.max(...cs.map(c => c.high)),
      low:    Math.min(...cs.map(c => c.low)),
      close:  cs[cs.length - 1].close,
      volume: cs.reduce((a, c) => a + c.volume, 0),
    }));
}

function aggregateTo3d(daily: Candle[]): Candle[] {
  const result: Candle[] = [];
  for (let i = 0; i + 2 < daily.length; i += 3) {
    const chunk = daily.slice(i, i + 3);
    result.push({
      timestamp: chunk[0].timestamp,
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[2].close,
      volume: chunk.reduce((a, c) => a + c.volume, 0),
    });
  }
  return result;
}

// ── Parameter grid ────────────────────────────────────────────────────────────
interface ParamSet {
  strongBuyRsi:              number;
  moderateBuyRsi:            number;
  moderateSellRsi:           number;
  strongSellRsi:             number;
  driftThresholdPct:         number;
  stopLossPct:               number;
  trailingStopActivationPct: number;
  trailingStopPct:           number;
  bearishSolCutPct:          number;
  bearTargetMultiplier:          number;
  bearDriftOverridePct:          number;
  bearModerateBuyRsiAdjustment:  number;
  bearExtraVwapDiscountPct:      number;
}

const GRID: { [K in keyof ParamSet]: number[] } = {
  strongBuyRsi:              [25, 28, 31],
  moderateBuyRsi:            [37, 40, 43],
  moderateSellRsi:           [58, 62, 65],
  strongSellRsi:             [70, 73, 76],
  driftThresholdPct:         [5,  7,  9],
  stopLossPct:               [10, 13, 16],
  trailingStopActivationPct: [8,  10, 13],
  trailingStopPct:           [5,  7,  9],
  bearishSolCutPct:          [9,  12, 15],
  bearTargetMultiplier:         [0.75, 0.80, 0.85],
  bearDriftOverridePct:         [5,    6,    7],
  bearModerateBuyRsiAdjustment: [-6,   -4,   -2],
  bearExtraVwapDiscountPct:     [1.0,  1.5,  2.0],
};

const FAST_GRID: { [K in keyof ParamSet]: number[] } = {
  strongBuyRsi:              [25, 31],
  moderateBuyRsi:            [37, 43],
  moderateSellRsi:           [58, 65],
  strongSellRsi:             [70, 76],
  driftThresholdPct:         [5,  9],
  stopLossPct:               [10, 16],
  trailingStopActivationPct: [8,  13],
  trailingStopPct:           [5,  9],
  bearishSolCutPct:          [9,  15],
  bearTargetMultiplier:         [0.75, 0.85],
  bearDriftOverridePct:         [5,    7],
  bearModerateBuyRsiAdjustment: [-6,   -2],
  bearExtraVwapDiscountPct:     [1.0,  2.0],
};

const ACTIVE_GRID = fastMode ? FAST_GRID : GRID;

function* gridCombinations(startAt = 0): Generator<ParamSet> {
  const keys  = Object.keys(ACTIVE_GRID) as (keyof ParamSet)[];
  const vals  = keys.map(k => ACTIVE_GRID[k]);
  const total = vals.reduce((a, v) => a * v.length, 1);

  for (let idx = startAt; idx < total; idx++) {
    const combo: Partial<ParamSet> = {};
    let rem = idx;
    for (let d = keys.length - 1; d >= 0; d--) {
      combo[keys[d]] = vals[d][rem % vals[d].length];
      rem = Math.floor(rem / vals[d].length);
    }
    yield combo as ParamSet;
  }
}

function* randomCombinations(n: number, startAt = 0): Generator<ParamSet> {
  const keys = Object.keys(ACTIVE_GRID) as (keyof ParamSet)[];
  for (let i = startAt; i < n; i++) {
    const combo: Partial<ParamSet> = {};
    for (const k of keys) {
      const vals = ACTIVE_GRID[k];
      combo[k] = vals[Math.floor(Math.random() * vals.length)];
    }
    yield combo as ParamSet;
  }
}

// ── Top-K ─────────────────────────────────────────────────────────────────────
class TopK<T> {
  private items: T[] = [];
  constructor(private readonly k: number, private readonly scoreFn: (item: T) => number) {}

  add(item: T): void {
    const s = this.scoreFn(item);
    if (this.items.length < this.k) {
      this.items.push(item);
      this.items.sort((a, b) => this.scoreFn(b) - this.scoreFn(a));
    } else if (s > this.scoreFn(this.items[this.items.length - 1] as T)) {
      this.items[this.items.length - 1] = item;
      for (let i = this.items.length - 1; i > 0 && this.scoreFn(this.items[i]) > this.scoreFn(this.items[i - 1]); i--) {
        [this.items[i], this.items[i - 1]] = [this.items[i - 1], this.items[i]];
      }
    }
  }

  get best(): T | undefined { return this.items[0]; }
  get all(): T[] { return this.items; }
  restore(items: T[]): void { this.items = items.slice(0, this.k); }
}

// ── Checkpoint ────────────────────────────────────────────────────────────────
const CHECKPOINT_FILE  = path.join(__dirname, '../optimize_checkpoint.json');
const CHECKPOINT_EVERY = 5_000;
const REPORT_EVERY     = 1_000;

interface Checkpoint {
  version:      number;
  mode:         'grid' | 'random';
  walkForward:  boolean;
  fast:         boolean;
  startMs:      number;
  splitMs:      number;
  totalCombos:  number;
  doneCount:    number;
  topResults:   unknown[];
  savedAt:      number;
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp));
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (!fs.existsSync(CHECKPOINT_FILE)) return null;
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8')) as Checkpoint;
  } catch { return null; }
}

// ── Simulation result types ────────────────────────────────────────────────────
interface PeriodMetrics {
  finalValue:  number;
  stratReturn: number;
  bhReturn:    number;
  alpha:       number;
  sharpe:      number;
  maxDD:       number;
  bhDD:        number;
  ddDelta:     number;
  trades:      number;
  winRate:     number;
}

interface SingleSplitResult {
  params:     ParamSet;
  inSample:   PeriodMetrics;
  outSample:  PeriodMetrics | null;
  score:      number;
}

interface SplitSimResult {
  split:        string;
  trainMetrics: PeriodMetrics;
  valMetrics:   PeriodMetrics;
  splitScore:   number;
}

interface WalkForwardResult {
  params:         ParamSet;
  splits:         SplitSimResult[];
  aggregateScore: number;
  penalized:      boolean;
}

// ── Scoring functions ────────────────────────────────────────────────────────
function computeSplitScore(m: PeriodMetrics): number {
  const consistency = m.winRate;
  return (m.alpha * 0.35)
    + (m.sharpe * 10 * 0.35)
    + (m.ddDelta * 0.20)
    + (consistency * 0.10);
}

function computeAggregateScore(splits: SplitSimResult[]): { score: number; penalized: boolean } {
  const splitScores = splits.map(s => s.splitScore);
  const splitMaxDDs = splits.map(s => s.valMetrics.maxDD);
  const splitBhDDs  = splits.map(s => s.valMetrics.bhDD);
  const splitSharpes = splits.map(s => s.valMetrics.sharpe);

  const avg = splitScores.reduce((a, b) => a + b, 0) / splitScores.length;
  const min = Math.min(...splitScores);
  const raw = avg * 0.6 + min * 0.4;

  const isPenalized = splitSharpes.some(s => s < -1.0)
    || splitMaxDDs.some((dd, i) => dd < splitBhDDs[i] - 10);

  return { score: isPenalized ? raw * 0.7 : raw, penalized: isPenalized };
}

// ── Core simulation (no I/O, pure computation) ────────────────────────────────
function simulate(
  params: ParamSet,
  candles4h: Candle[],
  candles3d: Candle[],
  rsiSeries4h:  (number | null)[],
  vwapSeries4h: (number | null)[],
  smaSeries3d:  (number | null)[],
  bounds4h: CandleBounds,
  bounds3d: CandleBounds,
): PeriodMetrics {
  const cfg: BotConfig = JSON.parse(JSON.stringify(baseCfg));
  const r = cfg.strategy.rebalance;
  const risk = cfg.strategy.risk;

  r.strongBuyRsi              = params.strongBuyRsi;
  r.moderateBuyRsi            = params.moderateBuyRsi;
  r.moderateSellRsi           = params.moderateSellRsi;
  r.strongSellRsi             = params.strongSellRsi;
  r.driftThresholdPct         = params.driftThresholdPct;
  risk.stopLossPct            = params.stopLossPct;
  risk.trailingStopActivationPct = params.trailingStopActivationPct;
  risk.trailingStopPct        = params.trailingStopPct;
  r.trendAdjustment.bearishSolCutPct = params.bearishSolCutPct;
  cfg.strategy.regime.bearTargetMultiplier         = params.bearTargetMultiplier;
  cfg.strategy.regime.bearDriftOverridePct         = params.bearDriftOverridePct;
  cfg.strategy.regime.bearModerateBuyRsiAdjustment = params.bearModerateBuyRsiAdjustment;
  cfg.strategy.regime.bearExtraVwapDiscountPct     = params.bearExtraVwapDiscountPct;

  const simStartTs = candles4h[bounds4h.startIdx].timestamp;
  let sma3dPtr = bounds3d.startIdx;
  while (sma3dPtr + 1 < bounds3d.endIdx && candles3d[sma3dPtr + 1].timestamp <= simStartTs) {
    sma3dPtr++;
  }

  function getSma3d(atTs: number): number | null {
    while (sma3dPtr + 1 < bounds3d.endIdx && candles3d[sma3dPtr + 1].timestamp <= atTs) sma3dPtr++;
    for (let j = sma3dPtr; j >= bounds3d.startIdx; j--) {
      if (candles3d[j].timestamp <= atTs && smaSeries3d[j] !== null) return smaSeries3d[j];
    }
    return null;
  }

  function getRsiDir(i: number): RsiDirection {
    let cur: number | null = null, prev: number | null = null, found = 0;
    for (let j = i; j >= 0 && found < 2; j--) {
      if (rsiSeries4h[j] !== null) {
        if (found === 0) cur  = rsiSeries4h[j] as number;
        else             prev = rsiSeries4h[j] as number;
        found++;
      }
    }
    if (cur !== null && prev !== null) {
      const d = cur - prev;
      if (d > 1.0) return 'rising';
      if (d < -1.0) return 'falling';
    }
    return 'flat';
  }

  let usdcBalance = CAPITAL;
  let position: PositionState = buildInitialPosition();
  let pendingZone: string | null = null;
  let pendingZoneCount = 0;

  const equity: { value: number; price: number }[] = [];
  let   tradeCount = 0;
  let   winCount   = 0;
  let   totalSells = 0;

  for (let i = bounds4h.startIdx; i < bounds4h.endIdx; i++) {
    const candle = candles4h[i];
    const price  = candle.close;
    const nowMs  = candle.timestamp;

    const rsi4h        = rsiSeries4h[i];
    const vwap4h       = vwapSeries4h[i];
    const sma3d        = getSma3d(nowMs);
    const rsiDirection = getRsiDir(i);

    position = updateTrailingStop(position, price, cfg);

    const solValue    = position.solBalance * price;
    const totalValue  = solValue + usdcBalance;
    const solPct      = totalValue > 0 ? (solValue / totalValue) * 100 : 0;

    if (i % 6 === 0) equity.push({ value: totalValue, price });

    const signal = evaluateStrategy(price, rsi4h, vwap4h, sma3d, position, cfg, nowMs, solPct, rsiDirection);
    position = { ...position, lastTrendBias: signal.trendBias };

    const isEmergency = signal.action === 'emergency_sell';
    const isBuy       = signal.action === 'bootstrap' || signal.action === 'rebalance_buy';
    const isSell      = signal.action === 'rebalance_sell';

    let shouldExecute = false;
    if (isEmergency) {
      shouldExecute = true; pendingZone = null; pendingZoneCount = 0;
    } else if (isBuy || isSell) {
      const required = isBuy ? cfg.strategy.rebalance.buyConfirmationCandles : cfg.strategy.rebalance.sellConfirmationCandles;
      if (pendingZone === signal.zone) pendingZoneCount++;
      else { pendingZone = signal.zone; pendingZoneCount = 1; }
      shouldExecute = pendingZoneCount >= required;
    } else {
      pendingZone = null; pendingZoneCount = 0;
    }

    if (shouldExecute && isBuy && position.requireOversoldRecovery) {
      const oversold = new Set(['strong_buy', 'moderate_buy', 'bootstrap']);
      if (!oversold.has(signal.zone)) shouldExecute = false;
    }

    if (!shouldExecute) continue;

    if (isBuy) {
      const targetSolValue = (signal.targetSolPct / 100) * totalValue;
      const usdcToSpend    = Math.min(Math.max(0, targetSolValue - solValue), usdcBalance);
      if (usdcToSpend >= cfg.strategy.rebalance.minTradeUSDC) {
        const solReceived = (usdcToSpend * (1 - SLIPPAGE)) / price;
        const prevSol     = position.solBalance;
        const newAvgEntry = prevSol === 0 ? price : (prevSol * position.averageEntryPrice + solReceived * price) / (prevSol + solReceived);
        usdcBalance -= usdcToSpend;
        position = { ...position, solBalance: prevSol + solReceived, averageEntryPrice: newAvgEntry, bootstrapDone: true, highWaterMark: Math.max(position.highWaterMark, price), requireOversoldRecovery: false };
        tradeCount++; pendingZone = null; pendingZoneCount = 0;
      }
    } else if (isSell || isEmergency) {
      let solToSell: number;
      if (isEmergency) {
        solToSell = position.solBalance;
      } else {
        const targetSolValue = (signal.targetSolPct / 100) * totalValue;
        solToSell = Math.min(Math.max(0, (solValue - targetSolValue) / price), position.solBalance);
      }
      const minSol = cfg.strategy.rebalance.minTradeUSDC / price;
      if (solToSell >= minSol) {
        const usdcReceived = solToSell * price * (1 - SLIPPAGE);
        const pnl          = usdcReceived - solToSell * position.averageEntryPrice;
        const remainingSol = position.solBalance - solToSell;
        usdcBalance += usdcReceived;
        if (pnl > 0) winCount++;
        totalSells++; tradeCount++;
        if (isEmergency) {
          const cooldownMs = cfg.strategy.cooldown.candlesAfterExit * cfg.strategy.cooldown.candleDurationMinutes * 60000;
          position = { ...position, solBalance: remainingSol, averageEntryPrice: remainingSol > 0 ? position.averageEntryPrice : 0, trailingStopActive: false, trailingStopPrice: null, highWaterMark: 0, cooldownUntil: nowMs + cooldownMs, requireOversoldRecovery: true };
        } else {
          position = { ...position, solBalance: remainingSol };
        }
        pendingZone = null; pendingZoneCount = 0;
      }
    }
  }

  const firstCandle = candles4h[bounds4h.startIdx];
  const lastCandle  = candles4h[bounds4h.endIdx - 1];
  const firstPrice  = firstCandle.close;
  const lastPrice   = lastCandle.close;

  const finalValue   = position.solBalance * lastPrice + usdcBalance;
  const bhValue      = (CAPITAL / firstPrice) * lastPrice;
  const stratReturn  = ((finalValue - CAPITAL) / CAPITAL) * 100;
  const bhReturn     = ((bhValue   - CAPITAL) / CAPITAL) * 100;
  const alpha        = stratReturn - bhReturn;

  let stratDD = 0, bhDD = 0, stratPeak = CAPITAL;
  const bhSolAmt = CAPITAL / firstPrice;
  let bhPeak = CAPITAL;
  for (const p of equity) {
    if (p.value > stratPeak) stratPeak = p.value;
    const dd = (stratPeak - p.value) / stratPeak * 100;
    if (dd > stratDD) stratDD = dd;
    const bh = bhSolAmt * p.price;
    if (bh > bhPeak) bhPeak = bh;
    const bhd = (bhPeak - bh) / bhPeak * 100;
    if (bhd > bhDD) bhDD = bhd;
  }

  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    rets.push((equity[i].value - equity[i - 1].value) / equity[i - 1].value);
  }
  const meanR = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const varR  = rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / (rets.length || 1);
  const stdR  = Math.sqrt(varR);
  const sharpe = stdR > 0 ? ((meanR - 0.04 / 365) / stdR) * Math.sqrt(365) : 0;

  const winRate = totalSells > 0 ? (winCount / totalSells) * 100 : 0;
  const ddDelta = bhDD - stratDD;

  return { finalValue, stratReturn, bhReturn, alpha, sharpe, maxDD: stratDD, bhDD, ddDelta, trades: tradeCount, winRate };
}

// ── Single-split score ────────────────────────────────────────────────────────
function score(m: PeriodMetrics): number {
  return m.alpha * 0.45 + m.sharpe * 20 * 0.35 + m.ddDelta * 0.20;
}

// ── Helpers: resolve candle indices for a time range ────────────────────────
function validateMsBoundaries(name: string, trainMs: [number, number], valMs: [number, number]): void {
  if (!(trainMs[0] < trainMs[1])) throw new Error(`${name}: train period must have positive width (start < end)`);
  if (!(valMs[0] < valMs[1]))   throw new Error(`${name}: validation period must have positive width (start < end)`);
  if (!(trainMs[1] < valMs[0])) throw new Error(`${name}: train end (${new Date(trainMs[1]).toDateString()}) must precede val start (${new Date(valMs[0]).toDateString()}) — no shared boundary candle`);
}

interface CandleBounds {
  startIdx: number;
  endIdx: number;
}

function resolveCandleBounds(
  candles: Candle[],
  startMs: number,
  endMs: number,
): CandleBounds | null {
  const startIdx = candles.findIndex(c => c.timestamp >= startMs);
  let endIdx     = candles.findIndex(c => c.timestamp > endMs);
  if (startIdx < 0) return null;
  if (endIdx < 0) endIdx = candles.length;
  return { startIdx, endIdx };
}

function resolveBounds(
  candles4h: Candle[],
  candles3d: Candle[],
  rsiPeriod: number,
  trainMs: [number, number],
  valMs: [number, number],
  splitName: string,
  debugSplitC: boolean = false,
): { warmup: number; train4h: CandleBounds; val4h: CandleBounds; train3d: CandleBounds; val3d: CandleBounds } | null {
  const warmup  = rsiPeriod + 2;
  const train4h = resolveCandleBounds(candles4h, trainMs[0], trainMs[1]);
  const val4h   = resolveCandleBounds(candles4h, valMs[0], valMs[1]);
  const train3d = resolveCandleBounds(candles3d, trainMs[0], trainMs[1]);
  const val3d   = resolveCandleBounds(candles3d, valMs[0], valMs[1]);

  if (!train4h || !val4h || !train3d || !val3d) return null;
  if (train4h.endIdx - train4h.startIdx < warmup + 1) return null;
  if (train4h.endIdx <= train4h.startIdx || val4h.endIdx <= val4h.startIdx) return null;
  if (train3d.endIdx <= train3d.startIdx || val3d.endIdx <= val3d.startIdx) return null;

  if (debugSplitC) {
    console.log(`\n[Split C Debug]`);
    console.log(`  4h full range : ${new Date(candles4h[0].timestamp).toISOString()} → ${new Date(candles4h[candles4h.length - 1].timestamp).toISOString()}`);
    console.log(`  3d full range : ${new Date(candles3d[0].timestamp).toISOString()} → ${new Date(candles3d[candles3d.length - 1].timestamp).toISOString()}`);
    console.log(`  4h train slice: idx ${train4h.startIdx} → ${train4h.endIdx} (${new Date(candles4h[train4h.startIdx].timestamp).toISOString()} → ${new Date(candles4h[train4h.endIdx - 1].timestamp).toISOString()})`);
    console.log(`  4h val slice  : idx ${val4h.startIdx} → ${val4h.endIdx} (${new Date(candles4h[val4h.startIdx].timestamp).toISOString()} → ${new Date(candles4h[val4h.endIdx - 1].timestamp).toISOString()})`);
    console.log(`  3d train slice: idx ${train3d.startIdx} → ${train3d.endIdx} (${new Date(candles3d[train3d.startIdx].timestamp).toISOString()} → ${new Date(candles3d[train3d.endIdx - 1].timestamp).toISOString()})`);
    console.log(`  3d val slice  : idx ${val3d.startIdx} → ${val3d.endIdx} (${new Date(candles3d[val3d.startIdx].timestamp).toISOString()} → ${new Date(candles3d[val3d.endIdx - 1].timestamp).toISOString()})`);
  }

  return { warmup, train4h, val4h, train3d, val3d };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const endMs = Date.now();

  const mode: 'grid' | 'random' = RANDOM_N !== null ? 'random' : 'grid';
  const gridKeys = Object.keys(ACTIVE_GRID) as (keyof ParamSet)[];
  const fullGridSize = gridKeys.reduce((a, k) => a * ACTIVE_GRID[k].length, 1);
  const totalCombos = mode === 'random'
    ? RANDOM_N!
    : (MAX_COMBOS !== null ? Math.min(MAX_COMBOS, fullGridSize) : fullGridSize);

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         SOL Swing Bot — Parameter Optimizer           ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  if (walkForwardMode) {
    console.log(`Mode        : walk-forward (3 splits)`);
    console.log(`Top-K       : keep top ${TOP_K_SIZE} in memory`);
    console.log(`Split A     : Train 2022-03 → 2024-01 | Val 2024-01+1d → 2024-07`);
    console.log(`Split B     : Train 2022-03 → 2024-07 | Val 2024-07+1d → 2025-04`);
    console.log(`Split C     : Train 2022-03 → 2025-04 | Val 2025-04+1d → now`);
    console.log(`Scoring     : agg = 0.6×avg + 0.4×min splitScore | penalty ×0.7 if sharpe<-1 or DD worse by >10pp\n`);
  } else {
    console.log(`Mode        : ${mode === 'random' ? `random search (${totalCombos.toLocaleString()} samples)` : `grid (${fastMode ? 'fast' : 'full'}, ${totalCombos.toLocaleString()} combos)`}`);
    console.log(`Top-K       : keep top ${TOP_K_SIZE} in memory`);
    console.log(`In-sample   : ${new Date(START_MS).toDateString()} → ${new Date(SPLIT_MS).toDateString()}`);
    console.log(`Validation  : ${new Date(SPLIT_MS).toDateString()} → ${new Date(endMs).toDateString()}`);
    console.log(`Resume      : ${resumeMode ? 'yes (loading checkpoint)' : 'no'}\n`);
  }

  // ── Load checkpoint if resuming ─────────────────────────────────────────────
  let resumeFrom = 0;
  const topKSingle = new TopK<SingleSplitResult>(TOP_K_SIZE, r => r.score);
  const topKWF = new TopK<WalkForwardResult>(TOP_K_SIZE, r => r.aggregateScore);

  if (resumeMode) {
    const cp = loadCheckpoint();
    if (cp && cp.mode === mode && cp.fast === fastMode && cp.walkForward === walkForwardMode) {
      resumeFrom = cp.doneCount;
      if (cp.topResults) {
        if (walkForwardMode) {
          topKWF.restore(cp.topResults as WalkForwardResult[]);
        } else {
          topKSingle.restore(cp.topResults as SingleSplitResult[]);
        }
      }
      console.log(`Resuming from checkpoint: ${resumeFrom.toLocaleString()} sims done\n`);
    } else {
      console.log('Checkpoint not compatible with current settings — starting fresh.\n');
    }
  }

  // ── Fetch data ─────────────────────────────────────────────────────────────
  process.stdout.write('Fetching hourly OHLCV ');
  const hourly    = await fetchCCCandles('histohour', START_MS, endMs);
  const candles4h = aggregateTo4h(hourly);
  console.log(` ${hourly.length} hourly → ${candles4h.length} 4h candles`);

  process.stdout.write('Fetching daily OHLCV  ');
  const daily     = await fetchCCCandles('histoday', START_MS, endMs);
  const candles3d = aggregateTo3d(daily);
  console.log(` ${daily.length} daily → ${candles3d.length} 3d candles\n`);

  if (candles4h.length < 20 || candles3d.length < 5) {
    console.error('Not enough data.'); process.exit(1);
  }

  const rsiPeriod    = baseCfg.strategy.rsi.period;
  const smaPeriod    = baseCfg.strategy.sma.period;
  const rsiSeries4h  = calculateRSI(candles4h, rsiPeriod);
  const vwapSeries4h = calculateVWAP(candles4h, true);
  const smaSeries3d  = calculateSMA(candles3d, smaPeriod);

  // ── Walk-forward: validate all split bounds ─────────────────────────────────
  if (walkForwardMode) {
    for (const split of WALK_FORWARD_SPLITS) {
      validateMsBoundaries(split.name, split.trainMs, split.valMs);
      const b = resolveBounds(candles4h, candles3d, rsiPeriod, split.trainMs, split.valMs, split.name, split.name === 'Split C');
      if (!b) {
        const train4h = resolveCandleBounds(candles4h, split.trainMs[0], split.trainMs[1]);
        const val4h   = resolveCandleBounds(candles4h, split.valMs[0], split.valMs[1]);
        const train3d = resolveCandleBounds(candles3d, split.trainMs[0], split.trainMs[1]);
        const val3d   = resolveCandleBounds(candles3d, split.valMs[0], split.valMs[1]);
        const issues: string[] = [];
        if (!train4h || (train4h.endIdx - train4h.startIdx < rsiPeriod + 3)) issues.push('4h train');
        if (!val4h || (val4h.endIdx - val4h.startIdx < 1)) issues.push('4h val');
        if (!train3d || (train3d.endIdx - train3d.startIdx < 1)) issues.push('3d train');
        if (!val3d || (val3d.endIdx - val3d.startIdx < 1)) issues.push('3d val');
        console.error(`ERROR: insufficient data for ${split.name} — empty dataset(s): ${issues.join(', ')}`);
        console.error(`       Train: ${new Date(split.trainMs[0]).toDateString()} → ${new Date(split.trainMs[1]).toDateString()}`);
        console.error(`       Val  : ${new Date(split.valMs[0]).toDateString()} → ${new Date(split.valMs[1]).toDateString()}`);
        process.exit(1);
      }
      console.log(`${split.name}: 4h train ${b.train4h.endIdx - b.train4h.startIdx}, 4h val ${b.val4h.endIdx - b.val4h.startIdx}, 3d train ${b.train3d.endIdx - b.train3d.startIdx}, 3d val ${b.val3d.endIdx - b.val3d.startIdx}`);
    }
    console.log('');
  } else {
    const warmup     = rsiPeriod + 2;
    const splitIdx4h = candles4h.findIndex(c => c.timestamp >= SPLIT_MS);
    if (splitIdx4h < warmup + 1) { console.error('Split date too early.'); process.exit(1); }
    if (splitIdx4h >= candles4h.length - 1) { console.error('Split date too late.'); process.exit(1); }
    console.log(`In-sample candles    : ${(splitIdx4h - warmup).toLocaleString()}`);
    console.log(`Out-of-sample candles: ${(candles4h.length - splitIdx4h).toLocaleString()}\n`);
  }

  const combos = mode === 'random'
    ? randomCombinations(totalCombos, resumeFrom)
    : gridCombinations(resumeFrom);

  // ── Walk-forward main loop ──────────────────────────────────────────────────
  if (walkForwardMode) {
    console.log(`Running ${(totalCombos - resumeFrom).toLocaleString()} simulations (walk-forward)...`);

    let done = resumeFrom;
    const sweepStart = Date.now();

    for (const params of combos) {
      if (MAX_COMBOS !== null && done >= MAX_COMBOS) break;

      const splitResults: SplitSimResult[] = [];
      let allValid = true;

      for (const split of WALK_FORWARD_SPLITS) {
        const b = resolveBounds(candles4h, candles3d, rsiPeriod, split.trainMs, split.valMs, split.name, false);
        if (!b) { allValid = false; break; }

        const trainMetrics = simulate(params, candles4h, candles3d, rsiSeries4h, vwapSeries4h, smaSeries3d, b.train4h, b.train3d);
        const valMetrics   = simulate(params, candles4h, candles3d, rsiSeries4h, vwapSeries4h, smaSeries3d, b.val4h, b.val3d);
        const splitScore   = computeSplitScore(valMetrics);
        splitResults.push({ split: split.name, trainMetrics, valMetrics, splitScore });
      }

      if (!allValid) { done++; continue; }

      const { score: aggregateScore, penalized } = computeAggregateScore(splitResults);
      topKWF.add({ params, splits: splitResults, aggregateScore, penalized });
      done++;

      if (done % REPORT_EVERY === 0) {
        const elapsed     = (Date.now() - sweepStart) / 1000;
        const simsPerSec  = done / elapsed;
        const etaSec      = (totalCombos - done) / simsPerSec;
        const eta         = etaSec > 3600 ? `${(etaSec / 3600).toFixed(1)}h` : `${Math.round(etaSec / 60)}m`;
        const best        = topKWF.best;
        const bestStr     = best
          ? `score=${best.aggregateScore.toFixed(1)} penal=${best.penalized} sBuy=${best.params.strongBuyRsi} mBuy=${best.params.moderateBuyRsi} drift=${best.params.driftThresholdPct}`
          : '—';
        process.stdout.write(
          `\r  ${done.toLocaleString()}/${totalCombos.toLocaleString()} (${Math.round(done / totalCombos * 100)}%)`
          + ` | ${Math.round(simsPerSec)} sim/s | ETA ${eta} | best: ${bestStr}    `,
        );
      }

      if (done % CHECKPOINT_EVERY === 0) {
        process.stdout.write('\n');
        saveCheckpoint({ version: 2, mode, walkForward: true, fast: fastMode, startMs: START_MS, splitMs: SPLIT_MS, totalCombos, doneCount: done, topResults: topKWF.all, savedAt: Date.now() });
      }
    }

    process.stdout.write('\n\n');
    printWalkForwardResults(topKWF.all, gridKeys);

  } else {
    // ── Single-split main loop ─────────────────────────────────────────────────
    const warmup     = rsiPeriod + 2;
    const splitIdx4h = candles4h.findIndex(c => c.timestamp >= SPLIT_MS);
    const inSampleStart  = warmup;
    const inSampleEnd    = splitIdx4h;
    const outSampleStart = splitIdx4h;
    const outSampleEnd   = candles4h.length;

    const inBounds4h: CandleBounds = { startIdx: inSampleStart, endIdx: inSampleEnd };
    const outBounds4h: CandleBounds = { startIdx: outSampleStart, endIdx: outSampleEnd };
    const inStartMs  = candles4h[inSampleStart].timestamp;
    const inEndMs    = candles4h[inSampleEnd - 1].timestamp;
    const outStartMs = candles4h[outSampleStart].timestamp;
    const outEndMs   = candles4h[candles4h.length - 1].timestamp;
    const inBounds3d  = resolveCandleBounds(candles3d, inStartMs, inEndMs)!;
    const outBounds3d = resolveCandleBounds(candles3d, outStartMs, outEndMs)!;

    console.log(`Running ${(totalCombos - resumeFrom).toLocaleString()} in-sample simulations...`);

    let done = resumeFrom;
    const sweepStart = Date.now();

    for (const params of combos) {
      if (MAX_COMBOS !== null && done >= MAX_COMBOS) break;

      const m = simulate(params, candles4h, candles3d, rsiSeries4h, vwapSeries4h, smaSeries3d, inBounds4h, inBounds3d);
      topKSingle.add({ params, inSample: m, outSample: null, score: score(m) });
      done++;

      if (done % REPORT_EVERY === 0) {
        const elapsed     = (Date.now() - sweepStart) / 1000;
        const simsPerSec  = done / elapsed;
        const etaSec      = (totalCombos - done) / simsPerSec;
        const eta         = etaSec > 3600 ? `${(etaSec / 3600).toFixed(1)}h` : `${Math.round(etaSec / 60)}m`;
        const best        = topKSingle.best;
        const bestStr     = best
          ? `score=${best.score.toFixed(1)} α=${best.inSample.alpha.toFixed(1)}% sBuy=${best.params.strongBuyRsi} mBuy=${best.params.moderateBuyRsi} drift=${best.params.driftThresholdPct}`
          : '—';
        process.stdout.write(
          `\r  ${done.toLocaleString()}/${totalCombos.toLocaleString()} (${Math.round(done / totalCombos * 100)}%)`
          + ` | ${Math.round(simsPerSec)} sim/s | ETA ${eta} | best: ${bestStr}    `,
        );
      }

      if (done % CHECKPOINT_EVERY === 0) {
        process.stdout.write('\n');
        saveCheckpoint({ version: 2, mode, walkForward: false, fast: fastMode, startMs: START_MS, splitMs: SPLIT_MS, totalCombos, doneCount: done, topResults: topKSingle.all, savedAt: Date.now() });
      }
    }

    process.stdout.write('\n\n');

    // Phase 2: validate top-K on out-of-sample
    const finalResults = topKSingle.all;
    console.log(`Validating top ${finalResults.length} parameter sets on out-of-sample period...`);
    for (const r of finalResults) {
      r.outSample = simulate(r.params, candles4h, candles3d, rsiSeries4h, vwapSeries4h, smaSeries3d, outBounds4h, outBounds3d);
    }

    printSingleSplitResults(finalResults, gridKeys);
  }

  if (fs.existsSync(CHECKPOINT_FILE)) {
    fs.unlinkSync(CHECKPOINT_FILE);
  }
}

// ── Console output ───────────────────────────────────────────────────────────
function printSingleSplitResults(results: SingleSplitResult[], gridKeys: (keyof ParamSet)[]): void {
  const isYear  = new Date(START_MS).getFullYear() + '–' + new Date(SPLIT_MS).getFullYear();
  const osYear  = new Date(SPLIT_MS).getFullYear() + '–now';
  const fmt     = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

  console.log(`\n╔═════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║             TOP ${String(results.length).padEnd(3)} RESULTS (in-sample ranked)                     ║`);
  console.log(`╚═════════════════════════════════════════════════════════════════════════╝\n`);
  console.log(`        ─── IN-SAMPLE ${isYear} ───    ─── OUT-OF-SAMPLE ${osYear} ───    params →`);
  console.log(`Rank Score Alpha  Sharpe  MaxDD  Tr  WinR%    Alpha  Sharpe  MaxDD  Tr  WinR%    sBuy mBuy mSell sSell drift stop tsAct tsT bearCut bMult bDrft bRsi bVwap`);
  console.log('─'.repeat(195));

  for (let i = 0; i < results.length; i++) {
    const r  = results[i];
    const p  = r.params;
    const IS = r.inSample;
    const OS = r.outSample;
    console.log(
      `${String(i + 1).padStart(4)} ${r.score.toFixed(1).padStart(5)} ${fmt(IS.alpha).padStart(6)} ${IS.sharpe.toFixed(2).padStart(6)}  ${('-' + IS.maxDD.toFixed(1) + '%').padStart(6)} ${String(IS.trades).padStart(4)} ${IS.winRate.toFixed(0).padStart(4)}%`
      + (OS
        ? `    ${fmt(OS.alpha).padStart(6)} ${OS.sharpe.toFixed(2).padStart(6)}  ${('-' + OS.maxDD.toFixed(1) + '%').padStart(6)} ${String(OS.trades).padStart(4)} ${OS.winRate.toFixed(0).padStart(4)}%`
        : '    (not validated)                     ')
      + `    ${String(p.strongBuyRsi).padStart(4)} ${String(p.moderateBuyRsi).padStart(4)} ${String(p.moderateSellRsi).padStart(5)} ${String(p.strongSellRsi).padStart(5)}`
      + ` ${String(p.driftThresholdPct).padStart(5)} ${String(p.stopLossPct).padStart(4)} ${String(p.trailingStopActivationPct).padStart(5)} ${String(p.trailingStopPct).padStart(3)}`
      + ` ${String(p.bearishSolCutPct).padStart(7)} ${String(p.bearTargetMultiplier).padStart(5)} ${String(p.bearDriftOverridePct).padStart(5)} ${String(p.bearModerateBuyRsiAdjustment).padStart(4)} ${String(p.bearExtraVwapDiscountPct).padStart(5)}`,
    );
  }

  if (results[0]) {
    console.log(`\nIn-sample  B&H: return ${fmt(results[0].inSample.bhReturn)},  max drawdown -${results[0].inSample.bhDD.toFixed(1)}%`);
    if (results[0].outSample) {
      console.log(`Out-of-sample B&H: return ${fmt(results[0].outSample.bhReturn)},  max drawdown -${results[0].outSample.bhDD.toFixed(1)}%`);
    }
  }

  writeSingleSplitCSV(results, gridKeys);
}

function printWalkForwardResults(results: WalkForwardResult[], gridKeys: (keyof ParamSet)[]): void {
  const fmt = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

  console.log(`╔════════════════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║               TOP ${String(results.length).padEnd(3)} RESULTS (walk-forward, aggregate validation score)                ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════╝\n`);

  console.log('Split A: Train 2022-03 → 2024-01 | Val 2024-01+1d → 2024-07 (recovery phase)');
  console.log('Split B: Train 2022-03 → 2024-07 | Val 2024-07+1d → 2025-04 (explosive bull/volatile)');
  console.log('Split C: Train 2022-03 → 2025-04 | Val 2025-04+1d → now   (bearish breakdown)\n');

  console.log('        AggSc Pen ── Split A Val ── ── Split B Val ── ── Split C Val ──    params →');
  console.log('Rank Score      ?   Alpha Shrp   DD%  Tr  Alpha Shrp   DD%  Tr  Alpha Shrp   DD%  Tr    sBuy mBuy mSell sSell drift stop tsAct tsT bearCut bMult bDrft bRsi bVwap');
  console.log('─'.repeat(225));

  for (let i = 0; i < results.length; i++) {
    const r   = results[i];
    const p   = r.params;
    const [sa, sb, sc] = r.splits;

    const penalFlag = r.penalized ? '✓' : ' ';
    console.log(
      `${String(i + 1).padStart(4)} ${r.aggregateScore.toFixed(1).padStart(5)} ${penalFlag}   `
      + `${fmt(sa.valMetrics.alpha).padStart(5)} ${sa.valMetrics.sharpe.toFixed(1).padStart(5)} ${('-' + sa.valMetrics.maxDD.toFixed(1) + '%').padStart(5)} ${String(sa.valMetrics.trades).padStart(3)}  `
      + `${fmt(sb.valMetrics.alpha).padStart(5)} ${sb.valMetrics.sharpe.toFixed(1).padStart(5)} ${('-' + sb.valMetrics.maxDD.toFixed(1) + '%').padStart(5)} ${String(sb.valMetrics.trades).padStart(3)}  `
      + `${fmt(sc.valMetrics.alpha).padStart(5)} ${sc.valMetrics.sharpe.toFixed(1).padStart(5)} ${('-' + sc.valMetrics.maxDD.toFixed(1) + '%').padStart(5)} ${String(sc.valMetrics.trades).padStart(3)}  `
      + `   ${String(p.strongBuyRsi).padStart(4)} ${String(p.moderateBuyRsi).padStart(4)} ${String(p.moderateSellRsi).padStart(5)} ${String(p.strongSellRsi).padStart(5)}`
      + ` ${String(p.driftThresholdPct).padStart(5)} ${String(p.stopLossPct).padStart(4)} ${String(p.trailingStopActivationPct).padStart(5)} ${String(p.trailingStopPct).padStart(3)}`
      + ` ${String(p.bearishSolCutPct).padStart(7)} ${String(p.bearTargetMultiplier).padStart(5)} ${String(p.bearDriftOverridePct).padStart(5)} ${String(p.bearModerateBuyRsiAdjustment).padStart(4)} ${String(p.bearExtraVwapDiscountPct).padStart(5)}`,
    );
  }

  writeWalkForwardCSV(results, gridKeys);
}

// ── CSV output ────────────────────────────────────────────────────────────────
function writeSingleSplitCSV(results: SingleSplitResult[], gridKeys: (keyof ParamSet)[]): void {
  const outPath = path.join(__dirname, '../optimize_results.csv');
  const metricCols = (prefix: string) => [
    `${prefix}_finalValue`, `${prefix}_stratReturn`, `${prefix}_bhReturn`, `${prefix}_alpha`,
    `${prefix}_sharpe`, `${prefix}_maxDD`, `${prefix}_bhDD`, `${prefix}_ddDelta`,
    `${prefix}_trades`, `${prefix}_winRate`,
  ];
  const metricVals = (m: PeriodMetrics | null) => m
    ? [m.finalValue.toFixed(4), m.stratReturn.toFixed(3), m.bhReturn.toFixed(3), m.alpha.toFixed(3),
       m.sharpe.toFixed(4), m.maxDD.toFixed(3), m.bhDD.toFixed(3), m.ddDelta.toFixed(3), m.trades, m.winRate.toFixed(2)]
    : Array(10).fill('');

  const header = ['rank', 'score', ...metricCols('is'), ...metricCols('os'), ...gridKeys].join(',');
  const rows   = results.map((r, idx) => [
    idx + 1, r.score.toFixed(3),
    ...metricVals(r.inSample), ...metricVals(r.outSample),
    ...gridKeys.map(k => r.params[k]),
  ].join(','));

  fs.writeFileSync(outPath, [header, ...rows].join('\n'));
  console.log(`\nTop ${results.length} results written to: optimize_results.csv`);
  console.log('Columns: rank, score, is_* (in-sample), os_* (out-of-sample), params\n');
}

function writeWalkForwardCSV(results: WalkForwardResult[], gridKeys: (keyof ParamSet)[]): void {
  const outPath = path.join(__dirname, '../optimize_results.csv');

  const splitHeaders = (label: string) => [
    `train_${label}_alpha`, `train_${label}_sharpe`, `train_${label}_maxDD`, `train_${label}_trades`, `train_${label}_winRate`,
    `val_${label}_alpha`,   `val_${label}_sharpe`,   `val_${label}_maxDD`,   `val_${label}_trades`,   `val_${label}_winRate`,
    `splitScore_${label}`,
  ];

  const header = [
    'rank', 'aggregateScore', 'penalized',
    ...splitHeaders('A'), ...splitHeaders('B'), ...splitHeaders('C'),
    ...gridKeys,
  ].join(',');

  const rows = results.map((r, idx) => {
    const splitVals = (s: SplitSimResult, label: string) => [
      s.trainMetrics.alpha.toFixed(3), s.trainMetrics.sharpe.toFixed(4), s.trainMetrics.maxDD.toFixed(3), s.trainMetrics.trades, s.trainMetrics.winRate.toFixed(2),
      s.valMetrics.alpha.toFixed(3),   s.valMetrics.sharpe.toFixed(4),   s.valMetrics.maxDD.toFixed(3),   s.valMetrics.trades,   s.valMetrics.winRate.toFixed(2),
      s.splitScore.toFixed(3),
    ];
    return [
      idx + 1,
      r.aggregateScore.toFixed(3),
      r.penalized ? 1 : 0,
      ...splitVals(r.splits[0], 'A'),
      ...splitVals(r.splits[1], 'B'),
      ...splitVals(r.splits[2], 'C'),
      ...gridKeys.map(k => r.params[k]),
    ].join(',');
  });

  fs.writeFileSync(outPath, [header, ...rows].join('\n'));
  console.log(`\nTop ${results.length} results written to: optimize_results.csv`);
  console.log('Columns: rank, aggregateScore, penalized, train/val metrics per split (A/B/C), params\n');
}

main().catch(err => { console.error('\nOptimizer failed:', err.message); process.exit(1); });
