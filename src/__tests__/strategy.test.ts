import { evaluateStrategy, determineTrendBias, updateTrailingStop, buildInitialPosition } from '../strategy';
import { BotConfig, PositionState } from '../types';

// ── Test fixture ─────────────────────────────────────────────────────────────

function makeCfg(overrides: Partial<BotConfig['strategy']> = {}): BotConfig {
  return {
    strategy: {
      rsi: { period: 14 },
      vwap: { resetPeriod: 'daily' },
      sma: { period: 50, neutralZonePct: 3 },
      rebalance: {
        bootstrapRsiThreshold: 62,
        driftThresholdPct: 7,
        minTradeUSDC: 3,
        strongBuyRsi: 28,
        strongBuyVwapPct: 4,
        strongBuyTargetSolPct: 75,
        moderateBuyRsi: 40,
        moderateBuyVwapPct: 2,
        moderateBuyTargetSolPct: 62,
        neutralTargetSolPct: 50,
        moderateSellRsi: 62,
        moderateSellVwapFloorPct: 1,
        moderateSellTargetSolPct: 38,
        strongSellRsi: 72,
        strongSellVwapPct: 2,
        strongSellTargetSolPct: 25,
      },
      risk: {
        stopLossPct: 13,
        trailingStopActivationPct: 10,
        trailingStopPct: 7,
        circuitBreakerDrawdownPct: 30,
        maxSlippagePct: 2,
      },
      cooldown: { candlesAfterExit: 1, candleDurationMinutes: 240 },
      ...overrides,
    },
    capital: { startingCapitalUSDC: 1000, minSolReserveForGas: 0.05 },
    timeframes: { executionTf: '4h', trendTf: '3d' },
    network: { useDevnet: true, rpcEndpoint: '' },
    notifications: { enabled: false, webhookUrl: '', type: 'discord' },
    scheduler: { cronExpression: '0 0,4,8,12,16,20 * * *', alignToCandle: true },
  };
}

const emptyPosition: PositionState = buildInitialPosition();

const bootstrappedPosition: PositionState = {
  bootstrapDone: true,
  solBalance: 5,
  averageEntryPrice: 100,
  highWaterMark: 100,
  trailingStopActive: false,
  trailingStopPrice: null,
  cooldownUntil: null,
};

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
    expect(determineTrendBias(103.1, 100, cfg)).toBe('bullish');
  });

  it('neutral at exact 3% boundary (not strictly greater)', () => {
    expect(determineTrendBias(103, 100, cfg)).toBe('neutral');
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────

describe('evaluateStrategy — bootstrap phase', () => {
  const cfg = makeCfg();

  it('holds when RSI is above bootstrapRsiThreshold (62)', () => {
    const signal = evaluateStrategy(100, 63, 100, 100, emptyPosition, cfg, Date.now(), 0);
    expect(signal.action).toBe('hold');
    expect(signal.reason).toMatch(/waiting to bootstrap/i);
  });

  it('bootstraps when RSI drops below 62', () => {
    const signal = evaluateStrategy(100, 58, 100, 100, emptyPosition, cfg, Date.now(), 0);
    expect(signal.action).toBe('bootstrap');
    expect(signal.targetSolPct).toBe(50);
  });

  it('holds when RSI is null (no data yet)', () => {
    const signal = evaluateStrategy(100, null, 100, 100, emptyPosition, cfg, Date.now(), 0);
    expect(signal.action).toBe('hold');
    expect(signal.reason).toMatch(/rsi data/i);
  });

  it('skips zone logic until bootstrapped', () => {
    // Even with a clear strong_buy signal, should wait to bootstrap
    const vwap = 100 / (1 - 0.05); // 5% below VWAP
    const signal = evaluateStrategy(100, 20, vwap, 100, emptyPosition, cfg, Date.now(), 0);
    // Should bootstrap (RSI < 62) not zone-rebalance
    expect(signal.action).toBe('bootstrap');
  });
});

// ── Zone rebalancing ──────────────────────────────────────────────────────────

describe('evaluateStrategy — zone rebalancing (bootstrapped)', () => {
  const cfg = makeCfg();
  const sma3d = 100;

  it('hold when within drift threshold (neutral zone, balanced)', () => {
    // RSI=55 (neutral zone, target 50%), currentSolPct=50% — no drift
    const signal = evaluateStrategy(100, 55, 100, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('hold');
    expect(signal.zone).toBe('neutral');
  });

  it('rebalance_buy when under-allocated in neutral zone', () => {
    // neutral zone target 50%, currently at 30% (under by 20%)
    const signal = evaluateStrategy(100, 55, 100, sma3d, bootstrappedPosition, cfg, Date.now(), 30);
    expect(signal.action).toBe('rebalance_buy');
    expect(signal.targetSolPct).toBe(50);
  });

  it('rebalance_sell when over-allocated in neutral zone', () => {
    // neutral zone target 50%, currently at 70% (over by 20%)
    const signal = evaluateStrategy(100, 55, 100, sma3d, bootstrappedPosition, cfg, Date.now(), 70);
    expect(signal.action).toBe('rebalance_sell');
    expect(signal.targetSolPct).toBe(50);
  });

  it('hold when drift is within 7% threshold', () => {
    // neutral zone target 50%, currently at 55% (only 5% over — below 7% threshold)
    const signal = evaluateStrategy(100, 55, 100, sma3d, bootstrappedPosition, cfg, Date.now(), 55);
    expect(signal.action).toBe('hold');
  });

  it('strong_buy zone: RSI < 28 AND price far below VWAP', () => {
    const vwap = 100 / (1 - 0.045); // ~4.5% below VWAP
    const signal = evaluateStrategy(100, 25, vwap, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('rebalance_buy');
    expect(signal.zone).toBe('strong_buy');
    expect(signal.targetSolPct).toBe(75);
  });

  it('moderate_buy zone: RSI < 40 AND price below VWAP by 2%+', () => {
    const vwap = 100 / (1 - 0.025); // ~2.5% below VWAP
    const signal = evaluateStrategy(100, 35, vwap, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('rebalance_buy');
    expect(signal.zone).toBe('moderate_buy');
    expect(signal.targetSolPct).toBe(62);
  });

  it('moderate_sell zone: RSI > 62 AND price near or above VWAP', () => {
    const vwap = 99; // price ~1% above VWAP — passes floor
    const signal = evaluateStrategy(100, 65, vwap, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('rebalance_sell');
    expect(signal.zone).toBe('moderate_sell');
    expect(signal.targetSolPct).toBe(38);
  });

  it('moderate_sell NOT triggered when price too far below VWAP (RSI high but price crashed)', () => {
    // RSI still 65 (lagging) but price is 2% below VWAP — do not sell
    const vwap = 100 / (1 - 0.02); // price 2% below VWAP — exceeds floor of -1%
    const signal = evaluateStrategy(100, 65, vwap, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('hold');
    expect(signal.zone).toBe('neutral');
  });

  it('strong_sell zone: RSI > 72 AND price 2%+ above VWAP', () => {
    const vwap = 100 / (1 + 0.025); // price ~2.5% above VWAP
    const signal = evaluateStrategy(100, 75, vwap, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('rebalance_sell');
    expect(signal.zone).toBe('strong_sell');
    expect(signal.targetSolPct).toBe(25);
  });

  it('holds when RSI/VWAP null', () => {
    const signal = evaluateStrategy(100, null, null, sma3d, bootstrappedPosition, cfg, Date.now(), 50);
    expect(signal.action).toBe('hold');
    expect(signal.reason).toMatch(/insufficient/i);
  });
});

// ── Risk signals ──────────────────────────────────────────────────────────────

describe('evaluateStrategy — risk / emergency exits', () => {
  const cfg = makeCfg();
  const sma3d = 100;

  it('emergency_sell on stop loss (13% below avg entry)', () => {
    const avgEntry = 150;
    const price = avgEntry * (1 - 0.13); // exactly at stop
    const pos: PositionState = { ...bootstrappedPosition, averageEntryPrice: avgEntry, highWaterMark: avgEntry };
    const signal = evaluateStrategy(price, 45, 155, sma3d, pos, cfg, Date.now(), 50);
    expect(signal.action).toBe('emergency_sell');
    expect(signal.zone).toBe('stop_loss');
    expect(signal.targetSolPct).toBe(25); // reduce to minimum, not zero
    expect(signal.reason).toMatch(/stop loss/i);
  });

  it('emergency_sell on trailing stop', () => {
    const pos: PositionState = {
      ...bootstrappedPosition,
      averageEntryPrice: 100,
      highWaterMark: 150,
      trailingStopActive: true,
      trailingStopPrice: 140,
    };
    const price = 138; // below trailing stop
    const signal = evaluateStrategy(price, 45, 140, sma3d, pos, cfg, Date.now(), 50);
    expect(signal.action).toBe('emergency_sell');
    expect(signal.zone).toBe('trailing_stop');
    expect(signal.reason).toMatch(/trailing stop/i);
  });

  it('no stop loss when price is just above threshold', () => {
    const avgEntry = 150;
    const price = avgEntry * (1 - 0.12); // only 12% below — above 13% stop
    const pos: PositionState = { ...bootstrappedPosition, averageEntryPrice: avgEntry };
    const signal = evaluateStrategy(price, 55, 135, sma3d, pos, cfg, Date.now(), 50);
    expect(signal.action).not.toBe('emergency_sell');
  });
});

// ── Cooldown ──────────────────────────────────────────────────────────────────

describe('evaluateStrategy — cooldown', () => {
  const cfg = makeCfg();

  it('holds during cooldown regardless of signals', () => {
    const futureMs = Date.now() + 10 * 60 * 1000;
    const pos: PositionState = { ...bootstrappedPosition, cooldownUntil: futureMs };
    const signal = evaluateStrategy(100, 25, 110, 100, pos, cfg, Date.now(), 50);
    expect(signal.action).toBe('hold');
    expect(signal.reason).toMatch(/cooldown/i);
  });

  it('resumes normal operation after cooldown expires', () => {
    const pastMs = Date.now() - 60000;
    const pos: PositionState = { ...bootstrappedPosition, cooldownUntil: pastMs };
    // RSI < 40 and price 2.5% below VWAP → moderate_buy
    const vwap = 100 / (1 - 0.025);
    const signal = evaluateStrategy(100, 35, vwap, 100, pos, cfg, Date.now(), 30);
    expect(signal.action).toBe('rebalance_buy');
  });
});

// ── Trailing stop mechanics ───────────────────────────────────────────────────

describe('updateTrailingStop', () => {
  const cfg = makeCfg();

  const basePos: PositionState = {
    ...bootstrappedPosition,
    averageEntryPrice: 100,
    highWaterMark: 100,
  };

  it('does not activate trailing stop below 10% profit', () => {
    const updated = updateTrailingStop(basePos, 108, cfg); // +8%
    expect(updated.trailingStopActive).toBe(false);
    expect(updated.trailingStopPrice).toBeNull();
  });

  it('activates trailing stop at exactly 10% profit', () => {
    const updated = updateTrailingStop(basePos, 110, cfg); // +10%
    expect(updated.trailingStopActive).toBe(true);
    // stop = 110 * (1 - 0.07) = 102.3
    expect(updated.trailingStopPrice).toBeCloseTo(102.3, 1);
  });

  it('ratchets stop upward as price makes new highs', () => {
    let pos = updateTrailingStop(basePos, 110, cfg); // activate
    pos = updateTrailingStop(pos, 120, cfg);          // new high
    // stop = 120 * 0.93 = 111.6
    expect(pos.trailingStopPrice).toBeCloseTo(111.6, 1);
    expect(pos.highWaterMark).toBeCloseTo(120, 4);
  });

  it('does not lower stop when price pulls back', () => {
    let pos = updateTrailingStop(basePos, 120, cfg);
    const stopBefore = pos.trailingStopPrice!;
    pos = updateTrailingStop(pos, 112, cfg); // price drops
    expect(pos.trailingStopPrice).toBeCloseTo(stopBefore, 4);
  });

  it('does nothing when not bootstrapped', () => {
    const pos = updateTrailingStop(emptyPosition, 120, cfg);
    expect(pos.trailingStopActive).toBe(false);
  });
});
