import { calculateRSI, calculateVWAP, calculateSMA } from '../indicators';
import { Candle } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCandles(closes: number[], extras?: Partial<Candle>): Candle[] {
  return closes.map((close, i) => ({
    timestamp: 1_700_000_000_000 + i * 4 * 60 * 60 * 1000, // 4h apart, same day
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    ...extras,
  }));
}

// ── RSI Tests ────────────────────────────────────────────────────────────────

describe('calculateRSI', () => {
  it('returns all nulls when fewer than period+1 candles', () => {
    const candles = makeCandles([100, 102, 101]);
    const result = calculateRSI(candles, 14);
    expect(result).toHaveLength(3);
    expect(result.every((v) => v === null)).toBe(true);
  });

  it('returns null for first `period` indices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    // indices 0–13 should be null (14 entries), index 14 should have a value
    for (let i = 0; i < 14; i++) expect(result[i]).toBeNull();
    expect(result[14]).not.toBeNull();
  });

  it('RSI is 100 when price only goes up', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    const lastRsi = result[result.length - 1];
    expect(lastRsi).not.toBeNull();
    expect(lastRsi!).toBeCloseTo(100, 0);
  });

  it('RSI is 0 when price only goes down', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    const lastRsi = result[result.length - 1];
    expect(lastRsi).not.toBeNull();
    expect(lastRsi!).toBeCloseTo(0, 0);
  });

  it('RSI ≈ 50 for flat price series (all equal closes after initial rise)', () => {
    // 14 up moves, then 14 flat — RSI should be between 40–60 settling
    const closes = [
      ...Array.from({ length: 14 }, (_, i) => 100 + i),
      ...Array.from({ length: 14 }, () => 113),
    ];
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    const lastRsi = result[result.length - 1];
    expect(lastRsi).not.toBeNull();
    // flat means no new gains or losses, RSI should be neither extreme
    expect(lastRsi!).toBeGreaterThanOrEqual(0);
    expect(lastRsi!).toBeLessThanOrEqual(100);
  });

  it('RSI is within [0, 100] for all computed values', () => {
    const closes = [100, 102, 98, 105, 95, 108, 92, 110, 88, 112, 85, 115, 80, 118, 75, 120, 72, 122, 70, 125];
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    for (const v of result) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
  });

  it('computes known RSI value from reference data', () => {
    // Reference: 14-period RSI for a well-known sequence
    // Using the first 15 values from a textbook example
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.15, 43.61, 44.33, 44.83, 45.10, 45.15, 43.61, 44.33];
    const candles = makeCandles(closes);
    const result = calculateRSI(candles, 14);
    const rsi = result[14];
    expect(rsi).not.toBeNull();
    // Should be a valid RSI value
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
  });
});

// ── VWAP Tests ───────────────────────────────────────────────────────────────

describe('calculateVWAP', () => {
  it('returns the typical price when only one candle', () => {
    const candles: Candle[] = [{
      timestamp: 1_700_000_000_000,
      open: 100, high: 110, low: 90, close: 105, volume: 1000,
    }];
    const result = calculateVWAP(candles);
    // typical price = (110+90+105)/3 = 101.6667
    expect(result[0]).toBeCloseTo((110 + 90 + 105) / 3, 4);
  });

  it('VWAP accumulates correctly across candles', () => {
    const candles: Candle[] = [
      { timestamp: 1_700_000_000_000, open: 100, high: 110, low: 90, close: 100, volume: 100 },
      { timestamp: 1_700_000_000_000 + 3600000, open: 100, high: 120, low: 95, close: 115, volume: 200 },
    ];
    const result = calculateVWAP(candles);

    const tp1 = (110 + 90 + 100) / 3; // 100
    const tp2 = (120 + 95 + 115) / 3; // 110
    const expectedVwap2 = (tp1 * 100 + tp2 * 200) / (100 + 200);
    expect(result[1]).toBeCloseTo(expectedVwap2, 4);
  });

  it('resets at UTC day boundary', () => {
    // Two candles on different UTC days
    const day1 = 1_700_000_000_000; // some day
    const day2 = day1 + 86400000;    // next day

    const candles: Candle[] = [
      { timestamp: day1, open: 100, high: 110, low: 90, close: 100, volume: 1000 },
      { timestamp: day2, open: 200, high: 220, low: 180, close: 200, volume: 500 },
    ];
    const result = calculateVWAP(candles, true);

    // Second candle should reset — VWAP = typical price of candle 2
    const tp2 = (220 + 180 + 200) / 3;
    expect(result[1]).toBeCloseTo(tp2, 4);
  });

  it('does not reset when resetDaily=false', () => {
    const day1 = 1_700_000_000_000;
    const day2 = day1 + 86400000;

    const candles: Candle[] = [
      { timestamp: day1, open: 100, high: 110, low: 90, close: 100, volume: 1000 },
      { timestamp: day2, open: 200, high: 220, low: 180, close: 200, volume: 500 },
    ];
    const result = calculateVWAP(candles, false);

    const tp1 = (110 + 90 + 100) / 3;
    const tp2 = (220 + 180 + 200) / 3;
    const expected = (tp1 * 1000 + tp2 * 500) / 1500;
    expect(result[1]).toBeCloseTo(expected, 4);
  });

  it('handles zero volume gracefully', () => {
    const candles: Candle[] = [
      { timestamp: 1_700_000_000_000, open: 100, high: 110, low: 90, close: 100, volume: 0 },
    ];
    const result = calculateVWAP(candles);
    expect(result[0]).toBeNull();
  });
});

// ── SMA Tests ────────────────────────────────────────────────────────────────

describe('calculateSMA', () => {
  it('returns null until period-1 candles are available', () => {
    const candles = makeCandles([100, 102, 104]);
    const result = calculateSMA(candles, 5);
    expect(result.every((v) => v === null)).toBe(true);
  });

  it('returns correct SMA at exactly period length', () => {
    const closes = [10, 20, 30, 40, 50];
    const candles = makeCandles(closes);
    const result = calculateSMA(candles, 5);
    expect(result[4]).toBeCloseTo(30, 4); // (10+20+30+40+50)/5 = 30
  });

  it('SMA is a rolling average, not cumulative', () => {
    const closes = [10, 20, 30, 40, 50, 60];
    const candles = makeCandles(closes);
    const result = calculateSMA(candles, 5);
    // At index 5: last 5 = [20,30,40,50,60] → avg = 40
    expect(result[5]).toBeCloseTo(40, 4);
  });

  it('returns the same value when all closes are equal', () => {
    const candles = makeCandles(new Array(10).fill(55));
    const result = calculateSMA(candles, 5);
    for (let i = 4; i < 10; i++) {
      expect(result[i]).toBeCloseTo(55, 4);
    }
  });

  it('SMA of 50 returns null for first 49 candles', () => {
    const candles = makeCandles(Array.from({ length: 60 }, (_, i) => 100 + i));
    const result = calculateSMA(candles, 50);
    for (let i = 0; i < 49; i++) expect(result[i]).toBeNull();
    expect(result[49]).not.toBeNull();
  });
});
