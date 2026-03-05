import { evaluateStrategy, determineTrendBias, updateTrailingStop, buildInitialPosition } from '../strategy';
import { BotConfig, PositionState } from '../types';

// ── Test fixture ─────────────────────────────────────────────────────────────

function makeCfg(overrides: Partial<BotConfig['strategy']> = {}): BotConfig {
  return {
    strategy: {
      rsi: {
        period: 14,
        tier1BuyThreshold: 30,
        tier2BuyThreshold: 25,
        tier3BuyThreshold: 20,
        sellThreshold: 70,
        extendedSellThreshold: 80,
        bearishBuyThreshold: 20,
        neutralBuyThreshold: 25,
      },
      vwap: {
        tier1DeviationPct: 2,
        tier2DeviationPct: 4,
        tier3DeviationPct: 6,
        sellAtVwap: true,
        bearishDeviationPct: 5,
        resetPeriod: 'daily',
      },
      sma: { period: 50, neutralZonePct: 3 },
      tiers: { tier1AllocationPct: 33, tier2AllocationPct: 33, tier3AllocationPct: 34 },
      risk: {
        stopLossPct: 8,
        trailingStopActivationPct: 10,
        trailingStopPct: 5,
        circuitBreakerDrawdownPct: 30,
        maxSlippagePct: 2,
      },
      cooldown: { candlesAfterExit: 2, candleDurationMinutes: 240 },
      ...overrides,
    },
    capital: { startingCapitalUSDC: 1000 },
    timeframes: { executionTf: '4h', trendTf: '3d' },
    network: { useDevnet: true, rpcEndpoint: '' },
    notifications: { enabled: false, webhookUrl: '', type: 'discord' },
    scheduler: { cronExpression: '0 0,4,8,12,16,20 * * *', alignToCandle: true },
  };
}

const emptyPosition: PositionState = buildInitialPosition();

// ── determineTrendBias ────────────────────────────────────────────────────────

describe('determineTrendBias', () => {
  const cfg = makeCfg();

  it('bullish when price > SMA by more than neutralZone', () => {
    expect(determineTrendBias(106, 100, cfg)).toBe('bullish'); // +6% > 3%
  });

  it('bearish when price < SMA by more than neutralZone', () => {
    expect(determineTrendBias(94, 100, cfg)).toBe('bearish'); // -6% < -3%
  });

  it('neutral when price is within ±3% of SMA', () => {
    expect(determineTrendBias(102, 100, cfg)).toBe('neutral'); // +2%
    expect(determineTrendBias(98, 100, cfg)).toBe('neutral');  // -2%
  });

  it('returns neutral when SMA is null', () => {
    expect(determineTrendBias(100, null, cfg)).toBe('neutral');
  });

  it('bullish just above boundary (3.1%)', () => {
    expect(determineTrendBias(103.1, 100, cfg)).toBe('bullish'); // > 3%
  });

  it('neutral at exact 3% boundary (not strictly greater)', () => {
    expect(determineTrendBias(103, 100, cfg)).toBe('neutral'); // == 3%, not > 3%
  });
});

// ── Tier buy signals ─────────────────────────────────────────────────────────

describe('evaluateStrategy — buy signals (bullish)', () => {
  const cfg = makeCfg();
  const sma3d = 100;
  const price = 110; // > SMA → bullish

  it('tier1 buy: RSI < 30 and price 2%+ below VWAP', () => {
    const vwap = price / (1 - 0.025); // ~2.5% below vwap
    const signal = evaluateStrategy(price, 28, vwap, sma3d, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('buy_tier1');
  });

  it('tier2 buy: RSI < 25 and price 4%+ below VWAP (tier1 already filled)', () => {
    const vwap = price / (1 - 0.045); // ~4.5% below vwap
    const pos: PositionState = {
      ...emptyPosition,
      inPosition: true,
      solBalance: 1,
      averageEntryPrice: price,
      tiers: { ...emptyPosition.tiers, tier1Filled: true, tier1Amount: 330, tier1EntryPrice: price },
    };
    const signal = evaluateStrategy(price, 23, vwap, sma3d, pos, cfg, Date.now());
    expect(signal.action).toBe('buy_tier2');
  });

  it('tier3 buy: RSI < 20 and price 6%+ below VWAP (tiers 1&2 filled)', () => {
    const vwap = price / (1 - 0.065);
    const pos: PositionState = {
      ...emptyPosition,
      inPosition: true,
      solBalance: 2,
      averageEntryPrice: price,
      tiers: {
        ...emptyPosition.tiers,
        tier1Filled: true,
        tier2Filled: true,
        tier1Amount: 330,
        tier2Amount: 330,
        tier1EntryPrice: price,
        tier2EntryPrice: price,
      },
    };
    const signal = evaluateStrategy(price, 18, vwap, sma3d, pos, cfg, Date.now());
    expect(signal.action).toBe('buy_tier3');
  });

  it('hold when RSI meets threshold but VWAP deviation is insufficient', () => {
    const vwap = price / (1 - 0.01); // only 1% below — not enough for tier1
    const signal = evaluateStrategy(price, 28, vwap, sma3d, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('hold');
  });

  it('hold when tier1 not filled but trying tier2 conditions', () => {
    const vwap = price / (1 - 0.05);
    // tier1 NOT filled, but RSI meets tier2 — must fill in order
    const signal = evaluateStrategy(price, 23, vwap, sma3d, emptyPosition, cfg, Date.now());
    // Should trigger tier1, not tier2
    expect(signal.action).toBe('buy_tier1');
  });
});

// ── Sell signals ─────────────────────────────────────────────────────────────

describe('evaluateStrategy — sell signals', () => {
  const cfg = makeCfg();
  const sma3d = 100;
  const avgEntry = 150;

  const posInPosition: PositionState = {
    ...emptyPosition,
    inPosition: true,
    solBalance: 5,
    averageEntryPrice: avgEntry,
    highWaterMark: avgEntry,
    tiers: {
      tier1Filled: true,
      tier2Filled: true,
      tier3Filled: true,
      tier1EntryPrice: avgEntry,
      tier2EntryPrice: avgEntry,
      tier3EntryPrice: avgEntry,
      tier1Amount: 330,
      tier2Amount: 330,
      tier3Amount: 340,
    },
  };

  it('stop loss: price 8% below average entry', () => {
    const price = avgEntry * (1 - 0.08); // exactly at stop
    const signal = evaluateStrategy(price, 45, 155, sma3d, posInPosition, cfg, Date.now());
    expect(signal.action).toBe('sell_all');
    expect(signal.reason).toMatch(/stop loss/i);
  });

  it('take profit sell_half: RSI > 70 and price >= VWAP', () => {
    const price = 165;
    const vwap = 160; // price > vwap ✓
    const signal = evaluateStrategy(price, 72, vwap, sma3d, posInPosition, cfg, Date.now());
    expect(signal.action).toBe('sell_half');
  });

  it('take profit sell_all: RSI > 80', () => {
    const price = 175;
    const signal = evaluateStrategy(price, 82, 170, sma3d, posInPosition, cfg, Date.now());
    expect(signal.action).toBe('sell_all');
  });

  it('no sell_half if partialExitDone=true', () => {
    const price = 165;
    const vwap = 160;
    const pos = { ...posInPosition, partialExitDone: true };
    const signal = evaluateStrategy(price, 72, vwap, sma3d, pos, cfg, Date.now());
    // Should not sell_half again; RSI is not above 80 so holds
    expect(signal.action).toBe('hold');
  });

  it('trailing stop triggers when above stop loss level', () => {
    // avgEntry=150, stopLossPct=8% → stop loss at 138
    // set price=142 (above stop loss) but below trailing stop price of 145
    const price = 142;
    const pos: PositionState = {
      ...posInPosition,
      trailingStopActive: true,
      trailingStopPrice: 145,
    };
    const signal = evaluateStrategy(price, 45, 140, sma3d, pos, cfg, Date.now());
    expect(signal.action).toBe('sell_all');
    expect(signal.reason).toMatch(/trailing stop/i);
  });
});

// ── Cooldown ──────────────────────────────────────────────────────────────────

describe('evaluateStrategy — cooldown', () => {
  const cfg = makeCfg();

  it('holds during cooldown', () => {
    const futureMs = Date.now() + 10 * 60 * 1000; // 10 min in future
    const pos: PositionState = { ...emptyPosition, cooldownUntil: futureMs };
    const signal = evaluateStrategy(100, 25, 110, 100, pos, cfg, Date.now());
    expect(signal.action).toBe('hold');
    expect(signal.reason).toMatch(/cooldown/i);
  });

  it('allows entry after cooldown expires', () => {
    const pastMs = Date.now() - 60000; // 1 minute ago
    const pos: PositionState = { ...emptyPosition, cooldownUntil: pastMs };
    const price = 110;
    const sma = 100; // price > SMA by 10% → bullish bias
    const vwap = price / (1 - 0.025); // price 2.5% below VWAP → tier1 eligible
    const signal = evaluateStrategy(price, 28, vwap, sma, pos, cfg, Date.now());
    expect(signal.action).toBe('buy_tier1');
  });
});

// ── Bearish & neutral bias ────────────────────────────────────────────────────

describe('evaluateStrategy — trend bias filters', () => {
  const cfg = makeCfg();

  it('bearish bias: blocks entry unless RSI < 20 AND dev < -5%', () => {
    const price = 90; // below SMA 100 by 10% → bearish
    const sma = 100;
    const vwap = 95; // price is -5.26% below vwap — passes
    // RSI = 22 — too high for bearish threshold
    const signal = evaluateStrategy(price, 22, vwap, sma, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('hold');
  });

  it('bearish bias: allows entry when RSI < 20 AND dev < -5%', () => {
    const price = 90;
    const sma = 100;
    const vwap = price / (1 - 0.055); // price 5.5% below vwap
    const signal = evaluateStrategy(price, 18, vwap, sma, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('buy_tier1');
  });

  it('neutral bias: blocks when RSI >= 25', () => {
    const price = 102; // within ±3% of SMA 100 → neutral
    const sma = 100;
    const vwap = price / (1 - 0.025);
    const signal = evaluateStrategy(price, 27, vwap, sma, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('hold');
  });

  it('neutral bias: allows tier1 when RSI < 25', () => {
    const price = 102;
    const sma = 100;
    const vwap = price / (1 - 0.025);
    const signal = evaluateStrategy(price, 23, vwap, sma, emptyPosition, cfg, Date.now());
    expect(signal.action).toBe('buy_tier1');
  });
});

// ── Trailing stop mechanics ───────────────────────────────────────────────────

describe('updateTrailingStop', () => {
  const cfg = makeCfg();

  const basePos: PositionState = {
    ...emptyPosition,
    inPosition: true,
    solBalance: 5,
    averageEntryPrice: 100,
    highWaterMark: 100,
  };

  it('does not activate trailing stop below 10% profit', () => {
    const updated = updateTrailingStop(basePos, 108, cfg); // +8%
    expect(updated.trailingStopActive).toBe(false);
    expect(updated.trailingStopPrice).toBeNull();
  });

  it('activates trailing stop at 10% profit', () => {
    const updated = updateTrailingStop(basePos, 110, cfg); // +10%
    expect(updated.trailingStopActive).toBe(true);
    // stop = 110 * (1 - 0.05) = 104.5
    expect(updated.trailingStopPrice).toBeCloseTo(104.5, 4);
  });

  it('ratchets stop upward as price rises', () => {
    let pos = updateTrailingStop(basePos, 110, cfg); // activate at 110
    pos = updateTrailingStop(pos, 120, cfg); // new high
    // stop = 120 * 0.95 = 114
    expect(pos.trailingStopPrice).toBeCloseTo(114, 4);
    expect(pos.highWaterMark).toBeCloseTo(120, 4);
  });

  it('does not lower stop when price drops', () => {
    let pos = updateTrailingStop(basePos, 120, cfg); // activate and set stop at 114
    const stopBefore = pos.trailingStopPrice!;
    pos = updateTrailingStop(pos, 112, cfg); // price drops
    // Stop should not move below 114
    expect(pos.trailingStopPrice).toBeCloseTo(stopBefore, 4);
  });
});
