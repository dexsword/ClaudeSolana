/**
 * Parameter optimizer for the SOL swing trading strategy.
 *
 * Fetches candle data ONCE, then sweeps a grid of parameter combinations
 * entirely in memory — no additional API calls during optimization.
 *
 * Grid size: 3^13 = 1 594 323 combinations (9 zone/risk axes + 4 regime axes).
 * Each simulation is ~2 ms, so the full sweep completes in ~50–60 minutes.
 *
 * Usage:
 *   CRYPTOCOMPARE_API_KEY=xxx npm run optimize
 *   CRYPTOCOMPARE_API_KEY=xxx npx ts-node src/optimize.ts [--from=YYYY-MM-DD]
 *
 * Output:
 *   optimize_results.csv  — all combinations ranked by composite score
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Candle, BotConfig, PositionState, RsiDirection } from './types';
import { evaluateStrategy, updateTrailingStop, buildInitialPosition } from './strategy';
import { calculateRSI, calculateVWAP, calculateSMA } from './indicators';

// ── CLI ───────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];
const START_MS = fromArg ? new Date(fromArg).getTime() : new Date('2022-03-01').getTime();
const CC_KEY   = process.env.CRYPTOCOMPARE_API_KEY ?? '';
if (!CC_KEY) {
  console.error('ERROR: CRYPTOCOMPARE_API_KEY is not set.');
  process.exit(1);
}

const SLIPPAGE = 0.002;   // fixed at 0.2% — not a tuning parameter

// ── Load base config ──────────────────────────────────────────────────────────
const baseCfg: BotConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'),
);
const CAPITAL = baseCfg.capital.startingCapitalUSDC;

// ── CryptoCompare fetcher (same as backtest.ts) ───────────────────────────────
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
// 3^13 = 1 594 323 would be too slow; we use 3 values per axis.
// Total: 3^9 (zone/risk) × 3^4 (regime) = 19 683 × 81 = 1 594 323 — still too large.
// Split into two phases or accept ~59k (3^9 × 3^1 per regime param sampled jointly).
// Practical choice: 3^9 base × 3^4 regime = we keep 3 vals each = 3^13 ≈ 1.6M is slow.
// Use 3 base zone params × 3 risk × 3^4 regime = same. Keep at 3^13 but fast loop.
// At ~2ms/sim this is ~53 min. Acceptable for "can run as long as it needs".
interface ParamSet {
  // Zone thresholds
  strongBuyRsi:              number;
  moderateBuyRsi:            number;
  moderateSellRsi:           number;
  strongSellRsi:             number;
  // Execution
  driftThresholdPct:         number;
  stopLossPct:               number;
  trailingStopActivationPct: number;
  trailingStopPct:           number;
  bearishSolCutPct:          number;
  // Bearish regime policy (formerly hardcoded in getRegimePolicy)
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
  // Regime policy axes
  bearTargetMultiplier:         [0.75, 0.80, 0.85],
  bearDriftOverridePct:         [5,    6,    7],
  bearModerateBuyRsiAdjustment: [-6,   -4,   -2],
  bearExtraVwapDiscountPct:     [1.0,  1.5,  2.0],
};

/** Enumerate all grid combinations. */
function* gridCombinations(): Generator<ParamSet> {
  const keys = Object.keys(GRID) as (keyof ParamSet)[];
  const vals  = keys.map(k => GRID[k]);
  const total = vals.reduce((a, v) => a * v.length, 1);

  for (let idx = 0; idx < total; idx++) {
    const combo: Partial<ParamSet> = {};
    let rem = idx;
    for (let d = keys.length - 1; d >= 0; d--) {
      combo[keys[d]] = vals[d][rem % vals[d].length];
      rem = Math.floor(rem / vals[d].length);
    }
    yield combo as ParamSet;
  }
}

// ── Simulation result ─────────────────────────────────────────────────────────
interface SimResult {
  params:      ParamSet;
  finalValue:  number;
  stratReturn: number;
  bhReturn:    number;
  alpha:       number;
  sharpe:      number;
  maxDD:       number;
  bhDD:        number;
  ddDelta:     number;   // bhDD - maxDD: positive = less drawdown than B&H
  trades:      number;
  winRate:     number;
  score:       number;   // composite ranking score
}

// ── Core simulation (no I/O, pure computation) ────────────────────────────────
function simulate(
  params: ParamSet,
  candles4h: Candle[],
  candles3d: Candle[],
  rsiSeries4h:  (number | null)[],
  vwapSeries4h: (number | null)[],
  smaSeries3d:  (number | null)[],
  rsiPeriod: number,
): Omit<SimResult, 'params' | 'score'> {

  // Build a config override from params
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
  // Regime policy — overrides the config defaults so getRegimePolicy() picks them up
  cfg.strategy.regime.bearTargetMultiplier         = params.bearTargetMultiplier;
  cfg.strategy.regime.bearDriftOverridePct         = params.bearDriftOverridePct;
  cfg.strategy.regime.bearModerateBuyRsiAdjustment = params.bearModerateBuyRsiAdjustment;
  cfg.strategy.regime.bearExtraVwapDiscountPct     = params.bearExtraVwapDiscountPct;

  // Precomputed SMA3d pointer (reset per run)
  let sma3dPtr = 0;
  function getSma3d(atTs: number): number | null {
    while (sma3dPtr + 1 < candles3d.length && candles3d[sma3dPtr + 1].timestamp <= atTs) sma3dPtr++;
    for (let j = sma3dPtr; j >= 0; j--) {
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

  const warmup = rsiPeriod + 2;
  const equity: { value: number; price: number }[] = [];
  let   tradeCount = 0;
  let   winCount   = 0;
  let   totalSells = 0;

  for (let i = warmup; i < candles4h.length; i++) {
    const candle = candles4h[i];
    const price  = candle.close;
    const nowMs  = candle.timestamp;

    const rsi4h        = rsiSeries4h[i];
    const vwap4h       = vwapSeries4h[i];
    const sma3d        = getSma3d(nowMs);
    const rsiDirection = getRsiDir(i);

    position = updateTrailingStop(position, price, cfg);

    const solValue   = position.solBalance * price;
    const totalValue = solValue + usdcBalance;
    const solPct     = totalValue > 0 ? (solValue / totalValue) * 100 : 0;

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
      const targetSolValue  = (signal.targetSolPct / 100) * totalValue;
      const usdcToSpend     = Math.min(Math.max(0, targetSolValue - solValue), usdcBalance);
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

  // ── Metrics ────────────────────────────────────────────────────────────────
  const firstCandle = candles4h[warmup];
  const lastCandle  = candles4h[candles4h.length - 1];
  const firstPrice  = firstCandle.close;
  const lastPrice   = lastCandle.close;
  const totalDays   = (lastCandle.timestamp - firstCandle.timestamp) / 86400000;

  const finalValue   = position.solBalance * lastPrice + usdcBalance;
  const bhValue      = (CAPITAL / firstPrice) * lastPrice;
  const stratReturn  = ((finalValue - CAPITAL) / CAPITAL) * 100;
  const bhReturn     = ((bhValue   - CAPITAL) / CAPITAL) * 100;
  const alpha        = stratReturn - bhReturn;

  // Max drawdown
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

  // Sharpe (annualised from ~daily samples)
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

// ── Composite score ───────────────────────────────────────────────────────────
// Weights reflect: alpha beats all, then Sharpe, then drawdown protection.
// Sharpe multiplied by 20 to put it on a similar scale to pct values.
function score(r: Omit<SimResult, 'params' | 'score'>): number {
  return r.alpha * 0.45 + r.sharpe * 20 * 0.35 + r.ddDelta * 0.20;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const endMs = Date.now();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         SOL Swing Bot — Parameter Optimizer           ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const gridKeys = Object.keys(GRID) as (keyof ParamSet)[];
  const totalCombos = gridKeys.reduce((a, k) => a * GRID[k].length, 1);
  console.log(`Grid : ${gridKeys.map(k => `${k}[${GRID[k].length}]`).join(', ')}`);
  console.log(`Combos: ${totalCombos.toLocaleString()}`);
  console.log(`From  : ${new Date(START_MS).toDateString()}\n`);

  // ── Fetch data once ─────────────────────────────────────────────────────────
  process.stdout.write('Fetching hourly OHLCV ');
  const hourly = await fetchCCCandles('histohour', START_MS, endMs);
  const candles4h = aggregateTo4h(hourly);
  console.log(` ${hourly.length} hourly → ${candles4h.length} 4h candles`);

  process.stdout.write('Fetching daily OHLCV  ');
  const daily = await fetchCCCandles('histoday', START_MS, endMs);
  const candles3d = aggregateTo3d(daily);
  console.log(` ${daily.length} daily → ${candles3d.length} 3d candles\n`);

  if (candles4h.length < 20 || candles3d.length < 5) {
    console.error('Not enough data.'); process.exit(1);
  }

  // ── Precompute indicators (shared across all runs) ──────────────────────────
  const rsiPeriod   = baseCfg.strategy.rsi.period;
  const smaPeriod   = baseCfg.strategy.sma.period;
  const rsiSeries4h  = calculateRSI(candles4h, rsiPeriod);
  const vwapSeries4h = calculateVWAP(candles4h, true);
  const smaSeries3d  = calculateSMA(candles3d, smaPeriod);

  // ── Grid sweep ──────────────────────────────────────────────────────────────
  console.log(`Running ${totalCombos.toLocaleString()} simulations...`);
  const results: SimResult[] = [];
  let done = 0;
  const reportEvery = Math.floor(totalCombos / 20);

  for (const params of gridCombinations()) {
    const r = simulate(params, candles4h, candles3d, rsiSeries4h, vwapSeries4h, smaSeries3d, rsiPeriod);
    results.push({ params, ...r, score: score(r) });
    done++;
    if (done % reportEvery === 0) {
      process.stdout.write(`  ${Math.round(done / totalCombos * 100)}% (${done.toLocaleString()}/${totalCombos.toLocaleString()})\n`);
    }
  }

  results.sort((a, b) => b.score - a.score);

  // ── Print top 20 ────────────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║                    TOP 20 RESULTS                     ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const bhReturn = results[0]?.bhReturn ?? 0;
  const bhDD     = results[0]?.bhDD ?? 0;

  console.log(
    'Rank  Score   Alpha   Sharpe  MaxDD   Trades  WinR%'
    + '  sBuyRSI mBuyRSI mSellRSI sSellRSI drift  stop  tsAct tsTrail bearCut'
    + '  bMult bDrift bRsiAdj bVwap',
  );
  console.log('─'.repeat(165));

  for (let i = 0; i < Math.min(20, results.length); i++) {
    const r = results[i];
    const p = r.params;
    console.log(
      `${String(i + 1).padStart(4)}  `
      + `${r.score.toFixed(1).padStart(6)}  `
      + `${(r.alpha >= 0 ? '+' : '') + r.alpha.toFixed(1) + '%'}`.padStart(7) + '  '
      + `${r.sharpe.toFixed(2).padStart(6)}  `
      + `${('-' + r.maxDD.toFixed(1) + '%').padStart(7)}  `
      + `${String(r.trades).padStart(6)}  `
      + `${r.winRate.toFixed(0).padStart(5)}%`
      + `  ${String(p.strongBuyRsi).padStart(7)}`
      + ` ${String(p.moderateBuyRsi).padStart(7)}`
      + ` ${String(p.moderateSellRsi).padStart(8)}`
      + ` ${String(p.strongSellRsi).padStart(8)}`
      + ` ${String(p.driftThresholdPct).padStart(5)}`
      + ` ${String(p.stopLossPct).padStart(5)}`
      + ` ${String(p.trailingStopActivationPct).padStart(6)}`
      + ` ${String(p.trailingStopPct).padStart(7)}`
      + ` ${String(p.bearishSolCutPct).padStart(7)}`
      + `  ${String(p.bearTargetMultiplier).padStart(5)}`
      + ` ${String(p.bearDriftOverridePct).padStart(6)}`
      + ` ${String(p.bearModerateBuyRsiAdjustment).padStart(7)}`
      + ` ${String(p.bearExtraVwapDiscountPct).padStart(5)}`,
    );
  }

  console.log(`\nBuy & Hold reference: return ${bhReturn >= 0 ? '+' : ''}${bhReturn.toFixed(1)}%,  max drawdown -${bhDD.toFixed(1)}%`);

  // ── Write CSV ───────────────────────────────────────────────────────────────
  const outPath = path.join(__dirname, '../optimize_results.csv');
  const header = [
    'rank', 'score', 'finalValue', 'stratReturn', 'bhReturn', 'alpha',
    'sharpe', 'maxDD', 'bhDD', 'ddDelta', 'trades', 'winRate',
    ...gridKeys,
  ].join(',');

  const rows = results.map((r, idx) => [
    idx + 1,
    r.score.toFixed(3),
    r.finalValue.toFixed(4),
    r.stratReturn.toFixed(3),
    r.bhReturn.toFixed(3),
    r.alpha.toFixed(3),
    r.sharpe.toFixed(4),
    r.maxDD.toFixed(3),
    r.bhDD.toFixed(3),
    r.ddDelta.toFixed(3),
    r.trades,
    r.winRate.toFixed(2),
    ...gridKeys.map(k => r.params[k]),
  ].join(','));

  fs.writeFileSync(outPath, [header, ...rows].join('\n'));
  console.log(`\nFull results written to: optimize_results.csv  (${results.length} rows)`);
  console.log('\n💡 Open the CSV in any spreadsheet app to explore the full results.\n');
}

main().catch(err => { console.error('\nOptimizer failed:', err.message); process.exit(1); });
