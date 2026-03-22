/**
 * Backtester for the SOL swing trading strategy.
 *
 * Uses CoinGecko public API for historical SOL-USD OHLCV data.
 * No geo-restrictions. Free tier works without an API key.
 *
 * Data sources:
 *   4h candles — /market_chart/range paginates hourly price data in 80-day windows,
 *                then aggregates to 4h. VWAP uses close as typical price (approximation)
 *                since market_chart only provides close prices, not OHLC.
 *   3d candles — /ohlc?days=max provides real daily OHLCV back to 2020, aggregated to 3d.
 *
 * Optional: set COINGECKO_DEMO_API_KEY env var for higher rate limits (30 req/min).
 * Get a free demo key at coingecko.com/en/developers/dashboard
 *
 * Imports and calls the exact same strategy/indicator functions used in
 * production — no reimplementation, no drift.
 *
 * Usage:
 *   npm run backtest
 *   COINGECKO_DEMO_API_KEY=xxx npm run backtest
 *   npx ts-node src/backtest.ts [--from=YYYY-MM-DD] [--slippage=0.2]
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Candle, BotConfig, PositionState, RsiDirection } from './types';
import { evaluateStrategy, updateTrailingStop, buildInitialPosition } from './strategy';
import { calculateRSI, calculateVWAP, calculateSMA } from './indicators';

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const fromArg  = args.find(a => a.startsWith('--from='))?.split('=')[1];
const slipArg  = args.find(a => a.startsWith('--slippage='))?.split('=')[1];

const START_MS = fromArg ? new Date(fromArg).getTime() : new Date('2021-11-01').getTime();
const SLIPPAGE  = slipArg ? parseFloat(slipArg) / 100 : 0.002; // default 0.2%

// ── Config ───────────────────────────────────────────────────────────────────
const cfg: BotConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config.json'), 'utf-8'),
);
const CAPITAL = cfg.capital.startingCapitalUSDC;

// ── CoinGecko data fetcher ────────────────────────────────────────────────────
// CoinGecko public API: no geo-restrictions.
// Free tier works without a key but is rate-limited (~10-30 req/min).
// Set COINGECKO_DEMO_API_KEY for higher limits (free from coingecko.com).
//
// /market_chart/range  → hourly price+volume for ranges 1-90 days
// /ohlc?days=max       → real daily OHLCV from SOL listing onwards
const CG_BASE   = 'https://api.coingecko.com/api/v3';
const CG_API_KEY = process.env.COINGECKO_DEMO_API_KEY ?? '';
// Without a key: ~10 req/min → use 7s delay. With a key: 30 req/min → 2s.
const CG_DELAY_MS = CG_API_KEY ? 2000 : 7000;

function cgHeaders(): Record<string, string> {
  return CG_API_KEY ? { 'x-cg-demo-api-key': CG_API_KEY } : {};
}

interface CoinGeckoMarketChart {
  prices:        [number, number][];   // [timestamp_ms, price]
  total_volumes: [number, number][];   // [timestamp_ms, volume_usd]
}

/**
 * Fetch hourly SOL-USD price data from CoinGecko in paginated 80-day windows.
 * market_chart/range only gives close price (no OHLC), so high=low=close.
 * VWAP will use close as typical price — a known approximation.
 */
async function fetchCoinGeckoHourly(startMs: number, endMs: number): Promise<Candle[]> {
  const all: Candle[] = [];
  const windowMs  = 80 * 24 * 60 * 60 * 1000;  // 80-day windows → stays hourly
  let   windowEnd = endMs;

  // Page backwards from now to startMs
  while (windowEnd > startMs) {
    const windowStart = Math.max(windowEnd - windowMs, startMs);
    const fromSec = Math.floor(windowStart / 1000);
    const toSec   = Math.floor(windowEnd   / 1000);

    const { data } = await axios.get<CoinGeckoMarketChart>(
      `${CG_BASE}/coins/solana/market_chart/range`,
      {
        params:  { vs_currency: 'usd', from: fromSec, to: toSec },
        headers: cgHeaders(),
        timeout: 20000,
      },
    );

    for (let i = 0; i < data.prices.length; i++) {
      const [ts, price] = data.prices[i];
      const vol = data.total_volumes[i]?.[1] ?? 0;
      if (ts < startMs || ts > endMs) continue;
      all.push({ timestamp: ts, open: price, high: price, low: price, close: price, volume: vol });
    }

    process.stdout.write('.');
    windowEnd = windowStart - 1;
    if (windowEnd > startMs) await new Promise(r => setTimeout(r, CG_DELAY_MS));
  }

  // Sort chronologically (we fetched backwards)
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Fetch full daily OHLCV history from CoinGecko /ohlc endpoint.
 * This gives real open/high/low/close for proper VWAP on the 3d SMA candles.
 */
async function fetchCoinGeckoDailyOHLC(): Promise<Candle[]> {
  const { data } = await axios.get<number[][]>(
    `${CG_BASE}/coins/solana/ohlc`,
    {
      params:  { vs_currency: 'usd', days: 'max' },
      headers: cgHeaders(),
      timeout: 20000,
    },
  );
  // Response: [[timestamp_ms, open, high, low, close], ...]
  return data.map(([ts, o, h, l, c]) => ({
    timestamp: ts, open: o, high: h, low: l, close: c, volume: 0,
  }));
}

/** Aggregate hourly candles into 4h buckets aligned to UTC. */
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
    .filter(([, cs]) => cs.length >= 3)  // skip buckets missing >1 hour of data
    .map(([ts, cs]) => ({
      timestamp: ts,
      open:   cs[0].open,
      high:   Math.max(...cs.map(c => c.high)),
      low:    Math.min(...cs.map(c => c.low)),
      close:  cs[cs.length - 1].close,
      volume: cs.reduce((a, c) => a + c.volume, 0),
    }));
}

/** Aggregate daily candles into 3-day OHLCV candles (groups of 3). */
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

// ── Trade & equity types ──────────────────────────────────────────────────────
interface BacktestTrade {
  timestamp:  number;
  action:     string;
  side:       'buy' | 'sell';
  solAmount:  number;
  usdcAmount: number;
  price:      number;
  zone:       string;
  pnl:        number | null;   // USDC profit/loss on sell trades
  avgEntry:   number | null;   // average entry at time of sell
}

interface EquityPoint {
  ts:       number;
  value:    number;  // strategy portfolio value in USDC
  price:    number;  // SOL price
  solPct:   number;  // % of portfolio in SOL at this point
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runBacktest(): Promise<void> {
  const endMs = Date.now();

  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║           SOL Swing Bot — Backtester                  ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');
  console.log(`Capital  : $${CAPITAL} USDC`);
  console.log(`Slippage : ${(SLIPPAGE * 100).toFixed(2)}%`);
  console.log(`From     : ${new Date(START_MS).toDateString()}`);
  console.log(`To       : ${new Date().toDateString()}\n`);

  if (!CG_API_KEY) {
    console.log('Tip: set COINGECKO_DEMO_API_KEY env var for faster fetching (free at coingecko.com)\n');
  }

  // Fetch 4h candles: hourly data paginated backwards in 80-day windows → aggregate to 4h
  process.stdout.write(`Fetching hourly data from CoinGecko (${new Date(START_MS).getFullYear()}→now) `);
  const hourlyCandles = await fetchCoinGeckoHourly(START_MS, endMs);
  const candles4h = aggregateTo4h(hourlyCandles);
  console.log(` ${hourlyCandles.length} hourly → ${candles4h.length} 4h candles`);

  // Fetch 3d candles: full daily OHLCV history → aggregate to 3d (for SMA3d)
  process.stdout.write('Fetching daily OHLCV from CoinGecko (max)... ');
  await new Promise(r => setTimeout(r, CG_DELAY_MS));
  const dailyCandles = await fetchCoinGeckoDailyOHLC();
  const candles3d = aggregateTo3d(dailyCandles);
  console.log(`${dailyCandles.length} daily → ${candles3d.length} 3d candles\n`);

  if (candles4h.length < 20 || candles3d.length < 5) {
    console.error('Not enough data. Check connectivity to api.coingecko.com, or try again (rate limit).');
    process.exit(1);
  }

  // ── Precompute indicator series (O(n)) ─────────────────────────────────────
  const rsiPeriod = cfg.strategy.rsi.period;  // 14
  const smaPeriod = cfg.strategy.sma.period;  // 50

  const rsiSeries4h  = calculateRSI(candles4h, rsiPeriod);
  const vwapSeries4h = calculateVWAP(candles4h, true);
  const smaSeries3d  = calculateSMA(candles3d, smaPeriod);

  // Latest SMA3d at or before a given 4h candle timestamp (using a pointer for O(n) total)
  let sma3dPointer = 0;
  function advanceSma3dPointer(atTs: number): number | null {
    while (sma3dPointer + 1 < candles3d.length && candles3d[sma3dPointer + 1].timestamp <= atTs) {
      sma3dPointer++;
    }
    // Return latest non-null SMA3d at or before atTs
    for (let j = sma3dPointer; j >= 0; j--) {
      if (candles3d[j].timestamp <= atTs && smaSeries3d[j] !== null) return smaSeries3d[j];
    }
    return null;
  }

  // RSI direction at index i: compare current RSI to the one before it
  function getRsiDirection(i: number): RsiDirection {
    let current: number | null = null;
    let prev: number | null = null;
    let found = 0;
    for (let j = i; j >= 0 && found < 2; j--) {
      if (rsiSeries4h[j] !== null) {
        if (found === 0) current = rsiSeries4h[j] as number;
        else prev = rsiSeries4h[j] as number;
        found++;
      }
    }
    if (current !== null && prev !== null) {
      const delta = current - prev;
      if (delta > 1.0) return 'rising';
      if (delta < -1.0) return 'falling';
    }
    return 'flat';
  }

  // ── Simulation state ────────────────────────────────────────────────────────
  let usdcBalance = CAPITAL;
  let position: PositionState = buildInitialPosition();
  let pendingZone: string | null = null;
  let pendingZoneCount = 0;

  const trades: BacktestTrade[] = [];
  const equity: EquityPoint[]   = [];

  // Warmup: need rsiPeriod+1 closes for first RSI value, plus 1 more for direction
  const warmup = rsiPeriod + 2;

  console.log(`Running simulation (${candles4h.length - warmup} candles)...`);

  for (let i = warmup; i < candles4h.length; i++) {
    const candle = candles4h[i];
    const price  = candle.close;
    const nowMs  = candle.timestamp;

    // ── Indicators ────────────────────────────────────────────────────────────
    const rsi4h        = rsiSeries4h[i];
    const vwap4h       = vwapSeries4h[i];
    const sma3d        = advanceSma3dPointer(nowMs);
    const rsiDirection = getRsiDirection(i);

    // ── Update trailing stop (must happen before evaluateStrategy) ────────────
    position = updateTrailingStop(position, price, cfg);

    // ── Portfolio snapshot ────────────────────────────────────────────────────
    const solValueUSDC  = position.solBalance * price;
    const totalValueUSDC = solValueUSDC + usdcBalance;
    const currentSolPct  = totalValueUSDC > 0 ? (solValueUSDC / totalValueUSDC) * 100 : 0;

    // Record equity once per day (every 6 × 4h candles)
    if (i % 6 === 0) {
      equity.push({ ts: nowMs, value: totalValueUSDC, price, solPct: currentSolPct });
    }

    // ── Strategy signal ───────────────────────────────────────────────────────
    const signal = evaluateStrategy(
      price, rsi4h, vwap4h, sma3d,
      position, cfg, nowMs, currentSolPct, rsiDirection,
    );

    // Persist updated trend bias
    position = { ...position, lastTrendBias: signal.trendBias };

    // ── Zone hysteresis (mirrors bot.ts) ──────────────────────────────────────
    const isEmergency = signal.action === 'emergency_sell';
    const isBuy       = signal.action === 'bootstrap' || signal.action === 'rebalance_buy';
    const isSell      = signal.action === 'rebalance_sell';

    let shouldExecute = false;

    if (isEmergency) {
      shouldExecute  = true;
      pendingZone    = null;
      pendingZoneCount = 0;
    } else if (isBuy || isSell) {
      const required = isBuy
        ? cfg.strategy.rebalance.buyConfirmationCandles
        : cfg.strategy.rebalance.sellConfirmationCandles;

      if (pendingZone === signal.zone) {
        pendingZoneCount++;
      } else {
        pendingZone      = signal.zone;
        pendingZoneCount = 1;
      }
      shouldExecute = pendingZoneCount >= required;
    } else {
      // hold — reset zone memory
      pendingZone      = null;
      pendingZoneCount = 0;
    }

    // ── Recovery gate: after emergency exit only re-buy in oversold zones ─────
    if (shouldExecute && isBuy && position.requireOversoldRecovery) {
      const oversold = new Set(['strong_buy', 'moderate_buy', 'bootstrap']);
      if (!oversold.has(signal.zone)) shouldExecute = false;
    }

    if (!shouldExecute) continue;

    // ── Execute trade ─────────────────────────────────────────────────────────
    if (isBuy) {
      // How much USDC to spend to reach the target SOL %
      const targetSolValue  = (signal.targetSolPct / 100) * totalValueUSDC;
      const currentSolValue = position.solBalance * price;
      const usdcToSpend     = Math.min(Math.max(0, targetSolValue - currentSolValue), usdcBalance);

      if (usdcToSpend >= cfg.strategy.rebalance.minTradeUSDC) {
        const solReceived = (usdcToSpend * (1 - SLIPPAGE)) / price;
        const prevSol     = position.solBalance;
        const newAvgEntry = prevSol === 0
          ? price
          : (prevSol * position.averageEntryPrice + solReceived * price) / (prevSol + solReceived);

        usdcBalance -= usdcToSpend;
        position = {
          ...position,
          solBalance:          prevSol + solReceived,
          averageEntryPrice:   newAvgEntry,
          bootstrapDone:       true,
          highWaterMark:       Math.max(position.highWaterMark, price),
          requireOversoldRecovery: false,
        };

        trades.push({
          timestamp: nowMs, action: signal.action, side: 'buy',
          solAmount: solReceived, usdcAmount: usdcToSpend, price,
          zone: signal.zone, pnl: null, avgEntry: null,
        });

        pendingZone      = null;
        pendingZoneCount = 0;
      }

    } else if (isSell || isEmergency) {
      // How much SOL to sell to reach the target SOL %
      let solToSell: number;
      if (isEmergency) {
        solToSell = position.solBalance;
      } else {
        const targetSolValue  = (signal.targetSolPct / 100) * totalValueUSDC;
        const currentSolValue = position.solBalance * price;
        solToSell = Math.min(
          Math.max(0, (currentSolValue - targetSolValue) / price),
          position.solBalance,
        );
      }

      const minSol = cfg.strategy.rebalance.minTradeUSDC / price;
      if (solToSell >= minSol) {
        const usdcReceived = solToSell * price * (1 - SLIPPAGE);
        const pnl          = usdcReceived - (solToSell * position.averageEntryPrice);
        const remainingSol = position.solBalance - solToSell;

        trades.push({
          timestamp: nowMs, action: signal.action, side: 'sell',
          solAmount: solToSell, usdcAmount: usdcReceived, price,
          zone: signal.zone, pnl, avgEntry: position.averageEntryPrice,
        });

        usdcBalance += usdcReceived;

        if (isEmergency) {
          const cooldownMs = cfg.strategy.cooldown.candlesAfterExit
            * cfg.strategy.cooldown.candleDurationMinutes * 60000;
          position = {
            ...position,
            solBalance:          remainingSol,
            averageEntryPrice:   remainingSol > 0 ? position.averageEntryPrice : 0,
            trailingStopActive:  false,
            trailingStopPrice:   null,
            highWaterMark:       0,
            cooldownUntil:       nowMs + cooldownMs,
            requireOversoldRecovery: true,
          };
        } else {
          position = { ...position, solBalance: remainingSol };
        }

        pendingZone      = null;
        pendingZoneCount = 0;
      }
    }
  }

  // ── Compute metrics ───────────────────────────────────────────────────────
  const lastCandle  = candles4h[candles4h.length - 1];
  const firstCandle = candles4h[warmup];
  const lastPrice   = lastCandle.close;
  const firstPrice  = firstCandle.close;
  const totalDays   = (lastCandle.timestamp - firstCandle.timestamp) / 86400000;

  const finalValue = position.solBalance * lastPrice + usdcBalance;
  const bhValue    = (CAPITAL / firstPrice) * lastPrice;   // buy-and-hold SOL from day 1

  const stratReturn  = ((finalValue - CAPITAL) / CAPITAL) * 100;
  const bhReturn     = ((bhValue - CAPITAL) / CAPITAL) * 100;
  const stratAnnual  = (Math.pow(finalValue / CAPITAL, 365 / totalDays) - 1) * 100;
  const bhAnnual     = (Math.pow(bhValue    / CAPITAL, 365 / totalDays) - 1) * 100;

  // Max drawdown
  let stratDD = 0, bhDD = 0, stratPeak = CAPITAL;
  const bhSolAmount = CAPITAL / firstPrice;
  let bhPeak = CAPITAL;
  for (const p of equity) {
    if (p.value > stratPeak) stratPeak = p.value;
    const dd = (stratPeak - p.value) / stratPeak * 100;
    if (dd > stratDD) stratDD = dd;

    const bh = bhSolAmount * p.price;
    if (bh > bhPeak) bhPeak = bh;
    const bhd = (bhPeak - bh) / bhPeak * 100;
    if (bhd > bhDD) bhDD = bhd;
  }

  // Sharpe ratio (annualised from daily-sampled returns)
  const dailyReturns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    dailyReturns.push((equity[i].value - equity[i - 1].value) / equity[i - 1].value);
  }
  const meanR = dailyReturns.reduce((a, b) => a + b, 0) / (dailyReturns.length || 1);
  const varR  = dailyReturns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (dailyReturns.length || 1);
  const stdR  = Math.sqrt(varR);
  const rfDay = 0.04 / 365;
  const sharpe = stdR > 0 ? ((meanR - rfDay) / stdR) * Math.sqrt(365) : 0;

  // Trade statistics
  const sells     = trades.filter(t => t.side === 'sell');
  const wins      = sells.filter(t => (t.pnl ?? 0) > 0);
  const lossTrades = sells.filter(t => (t.pnl ?? 0) <= 0);
  const winRate   = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;
  const avgWin    = wins.length > 0      ? wins.reduce((a, t) => a + t.pnl!, 0) / wins.length : 0;
  const avgLoss   = lossTrades.length > 0 ? lossTrades.reduce((a, t) => a + t.pnl!, 0) / lossTrades.length : 0;
  const winLoss   = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : NaN;
  const totalPnl  = sells.reduce((a, t) => a + (t.pnl ?? 0), 0);

  // ── Print report ─────────────────────────────────────────────────────────
  const pct  = (n: number, d = 1) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}%`;
  const usd  = (n: number)        => `$${n.toFixed(2)}`;
  const pad  = (s: string, w: number) => s.padStart(w);

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║                   BACKTEST RESULTS                    ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  console.log(`Period       ${new Date(firstCandle.timestamp).toDateString()} → ${new Date(lastCandle.timestamp).toDateString()} (${Math.round(totalDays)}d)`);
  console.log(`SOL price    $${firstPrice.toFixed(2)} → $${lastPrice.toFixed(2)}\n`);

  const W = 14;
  console.log(`${''.padStart(20)}  ${'STRATEGY'.padStart(W)}  ${'BUY & HOLD'.padStart(W)}`);
  console.log(`${'─'.repeat(20)}  ${'─'.repeat(W)}  ${'─'.repeat(W)}`);
  console.log(`Final value           ${pad(usd(finalValue), W)}  ${pad(usd(bhValue), W)}`);
  console.log(`Total return          ${pad(pct(stratReturn), W)}  ${pad(pct(bhReturn), W)}`);
  console.log(`Annual return         ${pad(pct(stratAnnual), W)}  ${pad(pct(bhAnnual), W)}`);
  console.log(`Sharpe ratio          ${pad(sharpe.toFixed(2), W)}  ${'N/A'.padStart(W)}`);
  console.log(`Max drawdown          ${pad(pct(-stratDD), W)}  ${pad(pct(-bhDD), W)}`);

  const alpha       = stratReturn - bhReturn;
  const ddDelta     = bhDD - stratDD;
  console.log(`\nAlpha vs buy-and-hold`);
  console.log(`  Return delta   : ${pct(alpha)}  ${alpha >= 0 ? '✓ outperformed' : '✗ underperformed'}`);
  console.log(`  Drawdown delta : ${pct(ddDelta)} ${ddDelta >= 0 ? '(less drawdown)' : '(more drawdown)'}`);

  console.log(`\nTrade statistics`);
  console.log(`  Total trades   : ${trades.length} (${trades.filter(t => t.side === 'buy').length} buys, ${sells.length} sells)`);
  console.log(`  Win rate       : ${winRate.toFixed(1)}% (${wins.length}W / ${lossTrades.length}L)`);
  console.log(`  Avg win        : ${usd(avgWin)}`);
  console.log(`  Avg loss       : ${usd(avgLoss)}`);
  console.log(`  Win/loss ratio : ${isNaN(winLoss) ? 'N/A' : winLoss.toFixed(2)}`);
  console.log(`  Total realised : ${usd(totalPnl)}`);

  console.log(`\nFinal portfolio`);
  console.log(`  SOL  : ${position.solBalance.toFixed(4)} @ $${lastPrice.toFixed(2)} = ${usd(position.solBalance * lastPrice)}`);
  console.log(`  USDC : ${usd(usdcBalance)}`);
  console.log(`  Total: ${usd(finalValue)}\n`);

  // ── Write CSVs ────────────────────────────────────────────────────────────
  const outDir = path.join(__dirname, '..');

  const equityRows = ['timestamp,date,stratValue,bhValue,price,solPct'];
  for (const p of equity) {
    const bh = bhSolAmount * p.price;
    equityRows.push([
      p.ts,
      new Date(p.ts).toISOString().slice(0, 10),
      p.value.toFixed(4),
      bh.toFixed(4),
      p.price.toFixed(2),
      p.solPct.toFixed(1),
    ].join(','));
  }
  fs.writeFileSync(path.join(outDir, 'backtest_equity.csv'), equityRows.join('\n'));

  const tradeRows = ['timestamp,date,action,side,solAmount,usdcAmount,price,zone,pnl,avgEntry'];
  for (const t of trades) {
    tradeRows.push([
      t.timestamp,
      new Date(t.timestamp).toISOString().slice(0, 10),
      t.action,
      t.side,
      t.solAmount.toFixed(6),
      t.usdcAmount.toFixed(4),
      t.price.toFixed(2),
      t.zone,
      t.pnl?.toFixed(4) ?? '',
      t.avgEntry?.toFixed(4) ?? '',
    ].join(','));
  }
  fs.writeFileSync(path.join(outDir, 'backtest_trades.csv'), tradeRows.join('\n'));

  console.log('Output files written:');
  console.log('  backtest_equity.csv  — daily equity curve vs buy-and-hold');
  console.log('  backtest_trades.csv  — full trade log with per-trade P&L\n');
}

runBacktest().catch(err => {
  console.error('\nBacktest failed:', err.message);
  process.exit(1);
});
