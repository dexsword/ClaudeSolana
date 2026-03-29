import { Bot2Config, Bot2Signal, Bot2Position, Candle } from './typesBot2';

export interface ATRResult {
  atr: number;
  atrPercent: number;
}

export function calculateATR(candles: Candle[], period: number = 14): ATRResult | null {
  if (candles.length < period + 1) return null;

  const recentCandles = candles.slice(-period - 1);
  const trueRanges: number[] = [];

  for (let i = 0; i < recentCandles.length; i++) {
    const c = recentCandles[i];
    const prevClose = i === 0 ? c.close : recentCandles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose)
    );
    trueRanges.push(tr);
  }

  const atr = trueRanges.reduce((a, b) => a + b, 0) / period;
  const latestClose = candles[candles.length - 1].close;
  const atrPercent = (atr / latestClose) * 100;

  return { atr, atrPercent };
}

export function calculateRSIShort(candles: Candle[], period: number = 8): (number | null)[] {
  if (candles.length < period + 1) {
    return new Array(candles.length).fill(null);
  }

  const results: (number | null)[] = new Array(candles.length).fill(null);
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  for (let i = period; i < gains.length; i++) {
    if (i === period) {
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      results[i + 1] = 100 - (100 / (1 + rs));
    }

    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    results[i + 1] = 100 - (100 / (1 + rs));
  }

  return results;
}

export function calculateEMA(candles: Candle[], period: number): number | null {
  if (candles.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    ema = (candles[i].close - ema) * multiplier + ema;
  }

  return ema;
}

export function calculateVWAPSession(candles: Candle[]): number | null {
  if (candles.length < 1) return null;

  let totalPV = 0;
  let totalV = 0;

  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice * c.volume;
    totalV += c.volume;
  }

  return totalV > 0 ? totalPV / totalV : null;
}

export type Bot2Action = 'buy' | 'sell' | 'hold';

export interface Bot2SignalResult {
  action: Bot2Action;
  reason: string;
  price: number;
  rsi: number | null;
  vwap: number | null;
  atrPercent: number | null;
  emaTrend: number | null;
  deviationPct: number;
}

export function evaluateBot2Strategy(
  price: number,
  candles: Candle[],
  position: Bot2Position,
  cfg: Bot2Config,
  nowMs: number,
): Bot2SignalResult {
  const s = cfg.bot2.strategy;

  const rsiSeries = calculateRSIShort(candles, s.rsi.period);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const prevRsi = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : null;

  const atrResult = calculateATR(candles, s.atr.period);
  const atrPercent = atrResult?.atrPercent ?? null;

  const vwap = calculateVWAPSession(candles.slice(-24));
  const ema = calculateEMA(candles, s.trendFilter.emaPeriod);

  const deviationPct = vwap ? ((price - vwap) / vwap) * 100 : 0;

  const base = {
    price,
    rsi,
    vwap,
    atrPercent,
    emaTrend: ema ? ((price - ema) / ema) * 100 : null,
    deviationPct,
  };

  if (rsi === null || vwap === null) {
    return { action: 'hold', reason: 'Waiting for indicators', ...base };
  }

  if (position.cooldownUntil && nowMs < position.cooldownUntil) {
    const remaining = Math.round((position.cooldownUntil - nowMs) / 60000);
    return { action: 'hold', reason: `Cooldown: ${remaining}min`, ...base };
  }

  const emaTrendPct = ema ? ((price - ema) / ema) * 100 : 0;
  if (s.trendFilter.enabled && ema) {
    if (emaTrendPct > s.trendFilter.disableAbovePct) {
      return { action: 'hold', reason: `Strong uptrend: ${emaTrendPct.toFixed(1)}% above EMA`, ...base };
    }
    if (emaTrendPct < s.trendFilter.disableBelowPct) {
      return { action: 'hold', reason: `Strong downtrend: ${emaTrendPct.toFixed(1)}% below EMA`, ...base };
    }
  }

  if (position.inPosition && position.entryPrice && position.entryTime) {
    const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    const holdMinutes = (nowMs - position.entryTime) / 60000;

    if (pnlPct >= s.exit.profitTargetPct) {
      return { action: 'sell', reason: `Profit target: ${pnlPct.toFixed(2)}%`, ...base };
    }

    if (pnlPct <= -s.exit.stopLossPct) {
      return { action: 'sell', reason: `Stop loss: ${pnlPct.toFixed(2)}%`, ...base };
    }

    if (position.trailingActive && position.trailingPrice && price <= position.trailingPrice) {
      return { action: 'sell', reason: `Trailing stop hit`, ...base };
    }

    if (holdMinutes > s.exit.maxHoldMinutes && pnlPct > 0) {
      return { action: 'sell', reason: `Time exit: ${holdMinutes.toFixed(0)}min at +${pnlPct.toFixed(1)}%`, ...base };
    }

    if (pnlPct >= s.exit.trailingActivationPct && !position.trailingActive) {
      const newTrailing = price * (1 - s.exit.trailingStopPct / 100);
      return { action: 'hold', reason: `Trailing at ${newTrailing.toFixed(2)}`, ...base };
    }

    if (rsi > s.rsi.exitOverbought && prevRsi && prevRsi < rsi) {
      return { action: 'sell', reason: `RSI overbought exit: ${rsi.toFixed(1)}`, ...base };
    }

    return { action: 'hold', reason: `Holding: ${pnlPct.toFixed(2)}%`, ...base };
  }

  const oversold = rsi < s.rsi.oversold;
  const deviationMet = Math.abs(deviationPct) >= s.entry.minDeviationPct;
  const belowVwap = deviationPct < -s.entry.minDeviationPct;

  if (oversold && deviationMet && belowVwap) {
    return { action: 'buy', reason: `Oversold: RSI=${rsi.toFixed(1)}, Dev=${deviationPct.toFixed(1)}%`, ...base };
  }

  return { action: 'hold', reason: 'No entry signal', ...base };
}

export function buildInitialBot2Position(): Bot2Position {
  return {
    inPosition: false,
    entryPrice: null,
    entryTime: null,
    size: 0,
    pnlPct: 0,
    trailingActive: false,
    trailingPrice: null,
    cooldownUntil: null,
    tradesToday: 0,
    lastTradeDate: null,
    peakValue: 0,
    currentValue: 0,
  };
}

export function updateBot2Position(
  position: Bot2Position,
  action: Bot2Action,
  price: number,
  size: number,
  cfg: Bot2Config,
  nowMs: number,
): Bot2Position {
  const today = new Date(nowMs).toDateString();

  if (action === 'buy') {
    return {
      ...position,
      inPosition: true,
      entryPrice: price,
      entryTime: nowMs,
      size,
      pnlPct: 0,
      trailingActive: false,
      trailingPrice: null,
    };
  }

  if (action === 'sell' && position.inPosition) {
    const newPosition = buildInitialBot2Position();
    newPosition.tradesToday = position.tradesToday + 1;
    newPosition.lastTradeDate = today;

    const cooldownMs = cfg.bot2.risk.cooldownMinutes * 60 * 1000;
    newPosition.cooldownUntil = nowMs + cooldownMs;

    return newPosition;
  }

  if (action === 'hold' && position.inPosition && position.entryPrice) {
    const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
    let trailingActive = position.trailingActive;
    let trailingPrice = position.trailingPrice;

    const s = cfg.bot2.strategy;
    if (pnlPct >= s.exit.trailingActivationPct && !trailingActive) {
      trailingActive = true;
      trailingPrice = price * (1 - s.exit.trailingStopPct / 100);
    }

    if (trailingActive && trailingPrice) {
      const newTrailing = price * (1 - s.exit.trailingStopPct / 100);
      if (newTrailing > trailingPrice) {
        trailingPrice = newTrailing;
      }
    }

    return {
      ...position,
      pnlPct,
      trailingActive,
      trailingPrice,
    };
  }

  return position;
}
