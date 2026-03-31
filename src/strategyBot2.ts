import { Bot2Config, Bot2Signal, Bot2Position, Candle } from './typesBot2';
import { evaluateBot2Core } from './strategyBot2Core';

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
  rsiDirection: 'rising' | 'falling' | 'flat';
}

export function evaluateBot2Strategy(
  price: number,
  candles: Candle[],
  position: Bot2Position,
  cfg: Bot2Config,
  nowMs: number,
): Bot2SignalResult {
  const s = cfg.bot2.strategy;

  const tf = cfg.bot2.timeframe?.trim().toLowerCase() ?? '15m';
  const tfMatch = tf.match(/^([0-9]+)\s*([mhd])$/);
  const tfMinutes = tfMatch
    ? (() => {
        const n = parseInt(tfMatch[1], 10);
        const unit = tfMatch[2];
        if (!Number.isFinite(n) || n <= 0) return 15;
        if (unit === 'm') return n;
        if (unit === 'h') return n * 60;
        return n * 1440;
      })()
    : 15;

  const rsiSeries = calculateRSIShort(candles, s.rsi.period);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const prevRsi = rsiSeries.length > 1 ? rsiSeries[rsiSeries.length - 2] : null;

  const rsiDirection: 'rising' | 'falling' | 'flat' = prevRsi === null || rsi === null
    ? 'flat'
    : rsi > prevRsi
      ? 'rising'
      : rsi < prevRsi
        ? 'falling'
        : 'flat';

  const atrResult = calculateATR(candles, s.atr.period);
  const atrPercent = atrResult?.atrPercent ?? null;

  // "session" VWAP is treated as a rolling 24h VWAP.
  const sessionCandles = Math.max(1, Math.round((24 * 60) / tfMinutes));
  const vwap = calculateVWAPSession(candles.slice(-sessionCandles));
  const ema = calculateEMA(candles, s.trendFilter.emaPeriod);

  // Higher-timeframe (1d) regime EMA computed from the same candle stream.
  // Assumes candles represent a fixed timeframe that divides 24h.

  const baseHours = tfMinutes / 60;
  const perDay = baseHours >= 1 ? Math.round(24 / baseHours) : 0;
  let htfEma: number | null = null;
  let prevHtfEma: number | null = null;
  if (perDay >= 1 && Number.isFinite(perDay) && perDay > 0) {
    const dayCandles: Candle[] = [];
    for (let i = 0; i + perDay <= candles.length; i += perDay) {
      const chunk = candles.slice(i, i + perDay);
      dayCandles.push({
        timestamp: chunk[0].timestamp,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, c) => sum + c.volume, 0),
      });
    }

    const p = cfg.bot2.strategy.regimeFilter?.emaPeriodDays ?? 50;
    htfEma = calculateEMA(dayCandles, p);
    if (dayCandles.length >= 2) {
      prevHtfEma = calculateEMA(dayCandles.slice(0, -1), p);
    }
  }

  const deviationPct = vwap ? ((price - vwap) / vwap) * 100 : 0;

  const base = {
    price,
    rsi,
    vwap,
    atrPercent,
    emaTrend: ema ? ((price - ema) / ema) * 100 : null,
    deviationPct,
    rsiDirection,
  };

  const core = evaluateBot2Core(
    {
      price,
      nowMs,
      rsi,
      prevRsi,
      vwap,
      atrPercent,
      ema,
      prevEma: candles.length >= 2 ? calculateEMA(candles.slice(0, -1), s.trendFilter.emaPeriod) : null,
      htfEma,
      prevHtfEma,
    },
    position,
    cfg,
  );

  return { action: core.action, reason: core.reason, ...base };
}

export function buildInitialBot2Position(): Bot2Position {
  return {
    inPosition: false,
    entryPrice: null,
    entryAssumed: false,
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
      entryAssumed: false,
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

    const mode = s.mode ?? 'mean_reversion';
    const activationPct = mode === 'trend'
      ? Math.max(6, s.exit.trailingActivationPct)
      : s.exit.trailingActivationPct;
    const trailPct = mode === 'trend'
      ? Math.max(3, s.exit.trailingStopPct)
      : s.exit.trailingStopPct;

    if (pnlPct >= activationPct && !trailingActive) {
      trailingActive = true;
      trailingPrice = price * (1 - trailPct / 100);
    }

    if (trailingActive && trailingPrice) {
      const newTrailing = price * (1 - trailPct / 100);
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
