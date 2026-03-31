import { Bot2Config, Bot2Position, Candle as Bot2Candle } from './typesBot2';
import { buildInitialBot2Position, updateBot2Position, calculateRSIShort } from './strategyBot2';
import { evaluateBot2Core } from './strategyBot2Core';

export interface BacktestCandle {
  timestamp: number; // Unix ms (candle start)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Bot2BacktestTrade {
  timestamp: number;
  action: 'buy' | 'sell';
  price: number;
  size: number;
  pnl: number;
}

export interface Bot2BacktestOptions {
  startingCapitalUSDC: number;
  slippagePct: number; // e.g. 0.002
  feePct: number;      // e.g. 0.0004
}

export interface Bot2BacktestMetrics {
  startingCapitalUSDC: number;
  finalValueUSDC: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  closedTrades: number;
  tradesPerYear: number;
  winRatePct: number;
  profitFactor: number;
  avgWinUSDC: number;
  avgLossUSDC: number;
  avgProfitPerTradeUSDC: number;
  totalPnlUSDC: number;
  netAfterCostsUSDC: number;
}

export interface Bot2BacktestResult {
  metrics: Bot2BacktestMetrics;
  trades: Bot2BacktestTrade[];
  endPosition: Bot2Position;
}

function computeMaxDrawdownPct(values: number[]): number {
  let peak = values[0] ?? 0;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

function parseTimeframeMinutesFromCandles(candles: BacktestCandle[]): number {
  if (candles.length < 2) return 15;
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 50); i++) {
    const d = candles[i].timestamp - candles[i - 1].timestamp;
    if (d > 0) diffs.push(d);
  }
  diffs.sort((a, b) => a - b);
  const medianMs = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 900_000;
  return Math.max(1, Math.round(medianMs / 60_000));
}

function computeSharpeFromEquity(equity: number[], periodsPerYear: number): number {
  if (equity.length < 3) return 0;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    const cur = equity[i];
    if (prev <= 0) continue;
    rets.push((cur - prev) / prev);
  }
  if (rets.length < 10) return 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(varr);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(periodsPerYear);
}

function parseTfMinutesFromCfg(cfg: Bot2Config): number {
  const tf = cfg.bot2.timeframe?.trim().toLowerCase() ?? '15m';
  const m = tf.match(/^([0-9]+)\s*([mhd])$/);
  if (!m) return 15;
  const n = parseInt(m[1], 10);
  const u = m[2];
  if (!Number.isFinite(n) || n <= 0) return 15;
  if (u === 'm') return n;
  if (u === 'h') return n * 60;
  return n * 1440;
}

function computeDailyEmaMapping(candles: BacktestCandle[], perDay: number, emaPeriodDays: number): {
  htfEma: (number | null)[];
  prevHtfEma: (number | null)[];
} {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const prevOut: (number | null)[] = new Array(candles.length).fill(null);
  if (perDay <= 0) return { htfEma: out, prevHtfEma: prevOut };

  const dayCloses: number[] = [];
  for (let i = 0; i + perDay <= candles.length; i += perDay) {
    const close = candles[i + perDay - 1].close;
    dayCloses.push(close);
  }
  const dayEma = computeEmaSeries(dayCloses, emaPeriodDays);

  for (let i = 0; i < candles.length; i++) {
    const dayIdx = Math.floor(i / perDay) - 1; // last completed day
    if (dayIdx >= 0 && dayIdx < dayEma.length) {
      out[i] = dayEma[dayIdx];
      prevOut[i] = dayIdx - 1 >= 0 ? dayEma[dayIdx - 1] : null;
    }
  }

  return { htfEma: out, prevHtfEma: prevOut };
}

function computeEmaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) ema += closes[i];
  ema /= period;
  out[period - 1] = ema;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * k + ema;
    out[i] = ema;
  }
  return out;
}

function computeRollingVwapSeries(candles: BacktestCandle[], windowCandles: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  const w = Math.max(1, windowCandles);

  let sumPV = 0;
  let sumV = 0;
  const pvQueue: number[] = [];
  const vQueue: number[] = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    const pv = typical * c.volume;
    const v = c.volume;
    pvQueue.push(pv);
    vQueue.push(v);
    sumPV += pv;
    sumV += v;

    if (pvQueue.length > w) {
      sumPV -= pvQueue.shift() ?? 0;
      sumV -= vQueue.shift() ?? 0;
    }

    if (sumV > 0) out[i] = sumPV / sumV;
  }

  return out;
}

function computeAtrPercentSeries(candles: BacktestCandle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1 || period <= 0) return out;

  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const range = c.high - c.low;
    const trVal = Math.max(range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
    tr[i] = trVal;
  }

  // Wilder smoothing
  let atr = 0;
  for (let i = 1; i <= period; i++) atr += tr[i];
  atr /= period;
  out[period] = (atr / candles[period].close) * 100;

  for (let i = period + 1; i < candles.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = (atr / candles[i].close) * 100;
  }

  return out;
}

/**
 * Conservative backtest:
 * - Signal computed on candle close
 * - Execution at NEXT candle open
 * - Slippage and fees always adverse
 */
export function runBot2Backtest(candles: BacktestCandle[], cfg: Bot2Config, opts: Bot2BacktestOptions): Bot2BacktestResult {
  const warmup = 120;
  const { startingCapitalUSDC, slippagePct, feePct } = opts;

  let usdc = startingCapitalUSDC;
  let position = buildInitialBot2Position();
  const trades: Bot2BacktestTrade[] = [];
  const equityCurve: number[] = [];

  const positionPct = Math.max(0, Math.min(1, cfg.bot2.strategy.position.maxPositionPct / 100));

  const tfMinutesCfg = parseTfMinutesFromCfg(cfg);
  const sessionCandles = Math.max(1, Math.round((24 * 60) / tfMinutesCfg));

  const baseHours = tfMinutesCfg / 60;
  const perDay = baseHours >= 1 ? Math.round(24 / baseHours) : 0;
  const rfDays = cfg.bot2.strategy.regimeFilter?.emaPeriodDays ?? 50;
  const htfMap = computeDailyEmaMapping(candles, perDay, rfDays);

  const closes = candles.map((c) => c.close);
  const rsiSeries = calculateRSIShort(candles as unknown as Bot2Candle[], cfg.bot2.strategy.rsi.period);
  const emaSeries = cfg.bot2.strategy.trendFilter.enabled
    ? computeEmaSeries(closes, cfg.bot2.strategy.trendFilter.emaPeriod)
    : new Array(candles.length).fill(null);
  const vwapSeries = computeRollingVwapSeries(candles, sessionCandles);
  const atrSeries = computeAtrPercentSeries(candles, cfg.bot2.strategy.atr.period);

  for (let i = warmup; i < candles.length - 1; i++) {
    const c = candles[i];
    const next = candles[i + 1];
    const price = c.close;

    // Mark-to-market equity at close
    equityCurve.push(usdc + (position.inPosition ? position.size * price : 0));

    const rsi = rsiSeries[i];
    const prevRsi = i > 0 ? rsiSeries[i - 1] : null;
    const vwap = vwapSeries[i];
    const ema = emaSeries[i];
    const prevEma = i > 0 ? emaSeries[i - 1] : null;
    const atrPercent = atrSeries[i];

    const htfEma = htfMap.htfEma[i];
    const prevHtfEma = htfMap.prevHtfEma[i];

    if (rsi === null || vwap === null) {
      if (position.inPosition) {
        position = updateBot2Position(position, 'hold', price, position.size, cfg, c.timestamp);
      }
      continue;
    }

    if (position.cooldownUntil && c.timestamp < position.cooldownUntil) {
      if (position.inPosition) {
        position = updateBot2Position(position, 'hold', price, position.size, cfg, c.timestamp);
      }
      continue;
    }

    const deviationPct = ((price - vwap) / vwap) * 100;

    const core = evaluateBot2Core(
      { price, nowMs: c.timestamp, rsi, prevRsi, vwap, atrPercent, ema, prevEma, htfEma, prevHtfEma },
      position,
      cfg,
    );

    const action = core.action;

    if (action === 'buy' && !position.inPosition) {
      const tradeUsdc = Math.min(usdc * positionPct, usdc);
      if (tradeUsdc < cfg.bot2.strategy.position.minTradeUSDC) continue;

      // Buy worse: slippage increases effective price; fee reduces output.
      const fillPx = next.open * (1 + slippagePct);
      const effectivePx = fillPx * (1 + feePct);
      const size = tradeUsdc / effectivePx;
      usdc -= tradeUsdc;

      position = updateBot2Position(position, 'buy', effectivePx, size, cfg, next.timestamp);
      trades.push({ timestamp: next.timestamp, action: 'buy', price: effectivePx, size, pnl: 0 });
    } else if (action === 'sell' && position.inPosition && position.entryPrice) {
      const size = position.size;
      if (size <= 0) continue;

      // Sell worse: slippage reduces price; fee reduces proceeds.
      const fillPx = next.open * (1 - slippagePct);
      const proceedsPx = fillPx * (1 - feePct);
      const proceeds = size * proceedsPx;
      const costBasis = size * position.entryPrice;
      const pnl = proceeds - costBasis;

      usdc += proceeds;
      position = updateBot2Position(position, 'sell', proceedsPx, size, cfg, next.timestamp);
      trades.push({ timestamp: next.timestamp, action: 'sell', price: proceedsPx, size, pnl });
    } else if (position.inPosition) {
      // Update trailing etc.
      position = updateBot2Position(position, 'hold', price, position.size, cfg, c.timestamp);
    }
  }

  const last = candles[candles.length - 1];
  const finalValue = usdc + (position.inPosition ? position.size * last.close : 0);
  const totalReturnPct = ((finalValue - startingCapitalUSDC) / startingCapitalUSDC) * 100;

  const startTs = candles[warmup]?.timestamp ?? candles[0]?.timestamp ?? 0;
  const endTs = last.timestamp;
  const years = startTs > 0 && endTs > startTs
    ? (endTs - startTs) / (365 * 24 * 60 * 60 * 1000)
    : 0;
  const annualizedReturnPct = years > 0
    ? (((finalValue / startingCapitalUSDC) ** (1 / years)) - 1) * 100
    : 0;

  const sells = trades.filter((t) => t.action === 'sell');
  const wins = sells.filter((t) => t.pnl > 0);
  const losses = sells.filter((t) => t.pnl <= 0);
  const totalWin = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLoss = losses.reduce((s, t) => s + Math.abs(t.pnl), 0);

  const winRatePct = sells.length > 0 ? (wins.length / sells.length) * 100 : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
  const avgWinUSDC = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLossUSDC = losses.length > 0 ? totalLoss / losses.length : 0;
  const totalPnlUSDC = sells.reduce((s, t) => s + t.pnl, 0);
  const avgProfitPerTradeUSDC = sells.length > 0 ? totalPnlUSDC / sells.length : 0;

  const tfMinutes = parseTimeframeMinutesFromCandles(candles);
  const periodsPerYear = (365 * 24 * 60) / tfMinutes;
  const sharpe = computeSharpeFromEquity(equityCurve, periodsPerYear);
  const tradesPerYear = years > 0 ? sells.length / years : 0;
  const netAfterCostsUSDC = finalValue - startingCapitalUSDC;

  // Add final point for drawdown
  equityCurve.push(finalValue);
  const maxDrawdownPct = computeMaxDrawdownPct(equityCurve);

  return {
    metrics: {
      startingCapitalUSDC,
      finalValueUSDC: finalValue,
      totalReturnPct,
      annualizedReturnPct,
      sharpe,
      maxDrawdownPct,
      closedTrades: sells.length,
      tradesPerYear,
      winRatePct,
      profitFactor,
      avgWinUSDC,
      avgLossUSDC,
      avgProfitPerTradeUSDC,
      totalPnlUSDC,
      netAfterCostsUSDC,
    },
    trades,
    endPosition: position,
  };
}
