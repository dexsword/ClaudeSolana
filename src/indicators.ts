import { Candle } from './types';

/**
 * Calculate RSI using Wilder's smoothing method.
 * Returns null if not enough data.
 */
export function calculateRSI(candles: Candle[], period: number = 14): (number | null)[] {
  const results: (number | null)[] = new Array(candles.length).fill(null);

  if (candles.length < period + 1) return results;

  // Compute per-candle gain/loss
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close;
    gains.push(Math.max(change, 0));
    losses.push(Math.abs(Math.min(change, 0)));
  }

  // Seed: simple average over first `period` changes
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  const rsiAt = (ag: number, al: number): number => {
    if (al === 0) return 100;
    const rs = ag / al;
    return 100 - 100 / (1 + rs);
  };

  results[period] = rsiAt(avgGain, avgLoss);

  // Wilder's smoothing for subsequent values
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    results[i + 1] = rsiAt(avgGain, avgLoss);
  }

  return results;
}

/**
 * Calculate VWAP over the provided candles.
 * Resets at midnight UTC daily (or rolling if candles span < 24h).
 * Returns the VWAP value for each candle.
 */
export function calculateVWAP(candles: Candle[], resetDaily: boolean = true): (number | null)[] {
  const results: (number | null)[] = [];
  let cumulativeTPV = 0; // typical_price * volume
  let cumulativeVol = 0;
  let currentDay: number | null = null;

  for (const candle of candles) {
    const day = Math.floor(candle.timestamp / 86400000); // UTC day

    if (resetDaily && currentDay !== null && day !== currentDay) {
      // New day — reset accumulators
      cumulativeTPV = 0;
      cumulativeVol = 0;
    }
    currentDay = day;

    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVol += candle.volume;

    results.push(cumulativeVol === 0 ? null : cumulativeTPV / cumulativeVol);
  }

  return results;
}

/**
 * Calculate a rolling SMA over `period` candles.
 * Returns null until enough data is available.
 */
export function calculateSMA(candles: Candle[], period: number = 50): (number | null)[] {
  const results: (number | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) {
      results.push(null);
    } else {
      const slice = candles.slice(i - period + 1, i + 1);
      const sum = slice.reduce((acc, c) => acc + c.close, 0);
      results.push(sum / period);
    }
  }

  return results;
}

/**
 * Get the latest RSI, VWAP, and SMA values from candle arrays.
 */
export function getLatestIndicators(
  candles4h: Candle[],
  candles3d: Candle[],
  rsiPeriod: number = 14,
  smaPeriod: number = 50,
): { rsi4h: number | null; vwap4h: number | null; sma3d: number | null } {
  const rsiSeries = calculateRSI(candles4h, rsiPeriod);
  const vwapSeries = calculateVWAP(candles4h);
  const smaSeries = calculateSMA(candles3d, smaPeriod);

  const last = <T>(arr: (T | null)[]): T | null => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] !== null) return arr[i] as T;
    }
    return null;
  };

  return {
    rsi4h: last(rsiSeries),
    vwap4h: last(vwapSeries),
    sma3d: last(smaSeries),
  };
}
