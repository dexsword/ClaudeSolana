import { evaluateStrategy, determineTrendBias, updateTrailingStop, buildInitialPosition } from '../strategy';
import { BotConfig, PositionState, RsiDirection } from '../types';

// ── Test fixture ─────────────────────────────────────────────────────────────

function makeCfg(overrides: Partial<BotConfig['strategy']> = {}): BotConfig {
  return {
    strategy: {
      rsi: { period: 14 },
      vwap: { resetPeriod: 'daily' },
      sma: { period: 50, neutralZonePct: 3, trendHysteresisPct: 1.5 },
      rebalance: {
        bootstrapRsiThreshold: 62,
        driftThresholdPct: 7,
        minTradeUSDC: 3,
        buyConfirmationCandles: 1,  // disable hysteresis in unit tests (tested in bot.ts)
        sellConfirmationCandles: 1,
        trendAdjustment: { bullishSolBoostPct: 10, bearishSolCutPct: 12 },
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
      cooldown: { candlesAfterExit: 3, candleDurationMinutes: 240 },
      ...overrides,
    },
    capital: { startingCapitalUSDC: 1000, minSolReserveForGas: 0.05 },
    timeframes: { executionTf: '4h', trendTf: '3d' },
    network: { useDevnet: true, rpcEndpoint: '' },
    notifications: { enabled: false, webhookUrl: '', type: 'discord' },
    scheduler: { cronExpression: '0 0,4,8,12,16,20 * * *', alignToCandle: true },
  };
}

// Convenience wrapper — rsiDirection defaults to 'flat' (neutral momentum)
function evalStrategy(
  price: number,
  rsi: number | null,
  vwap: number | null,
  sma: number | null,
  position: PositionState,
  cfg: BotConfig,
  rsiDirection: RsiDirection = 'flat',
) {
  return evaluateStrategy(price, rsi, vwap, sma, position, cfg, Date.now(), position.bootstrapDone ? 50 : 0, rsiDirection);
}

const emptyPosition: PositionState = buildInitialPosition();

const bootstrapped: PositionState = {
  bootstrapDone: true,
  solBalance: 5,
  averageEntryPrice: 100,
  highWaterMark: 100,
  trailingStopActive: false,
  trailingStopPrice: null,
  cooldownUntil: null,
  pendingZone: null,
  pendingZoneCount: 0,
  requireOversoldRecovery: false,
  lastTrendBias: 'neutral',
  lastExecutedCandleTs: null,
  lastSma3d: null,
};

// ── determineTrendBias ────────────────────────────────────────────────────────

describe('determineTrendBias', () => {
  const cfg = makeCfg();

  it('bullish when price > SMA by more than neutralZone', () => {
    expect(determineTrendBias(106, 100, cfg)).toBe('bullish');
  });

  it('bearish when price < SMA by more than neutralZone', () => {
    expect(determineTrendBias(94, 100, cfg)).toBe('bearish');
  });

  it('neutral when price is within ±3% of SMA', () => {
    expect(determineTrendBias(102, 100, cfg)).toBe('neutral');
    expect(determineTrendBias(98, 100, cfg)).toBe('neutral');
  });

  it('returns neutral when SMA is null', () => {
    expect(determineTrendBias(100, null, cfg)).toBe('neutral');
  });

  it('bullish just above boundary (3.1%)', () => {
    expect(determineTrendBias(103.1, 100, cfg)).toBe('bullish');
  });

  it('neutral at exact 3% boundary', () => {
    expect(determineTrendBias(103, 100, cfg)).toBe('neutral');
  });

  describe('hysteresis', () => {
    // neutralZonePct=3, trendHysteresisPct=1.5 → inner release threshold = 1.5%
    it('stays bearish when price recovers into hysteresis band (between -1.5% and -3%)', () => {
      expect(determineTrendBias(97, 100, cfg, 'bearish')).toBe('bearish'); // -3% exact: still bearish
      expect(determineTrendBias(97.5, 100, cfg, 'bearish')).toBe('bearish'); // -2.5%: in band
      expect(determineTrendBias(98.4, 100, cfg, 'bearish')).toBe('bearish'); // -1.6%: in band
    });

    it('exits bearish once price recovers past inner threshold (-1.5%)', () => {
      expect(determineTrendBias(98.6, 100, cfg, 'bearish')).toBe('neutral'); // -1.4%: past release
      expect(determineTrendBias(100, 100, cfg, 'bearish')).toBe('neutral');  // at SMA
    });

    it('stays bullish when price falls into hysteresis band (between +1.5% and +3%)', () => {
      expect(determineTrendBias(103, 100, cfg, 'bullish')).toBe('bullish');  // +3% exact: still bullish
      expect(determineTrendBias(102, 100, cfg, 'bullish')).toBe('bullish');  // +2%: in band
      expect(determineTrendBias(101.6, 100, cfg, 'bullish')).toBe('bullish'); // +1.6%: in band
    });

    it('exits bullish once price falls past inner threshold (+1.5%)', () => {
      expect(determineTrendBias(101.4, 100, cfg, 'bullish')).toBe('neutral'); // +1.4%: past release
      expect(determineTrendBias(100, 100, cfg, 'bullish')).toBe('neutral');   // at SMA
    });

    it('enters bearish from neutral when price crosses outer threshold', () => {
      expect(determineTrendBias(96.9, 100, cfg, 'neutral')).toBe('bearish'); // -3.1%: crossed
    });

    it('does not enter bearish from neutral within the outer threshold', () => {
      expect(determineTrendBias(97.5, 100, cfg, 'neutral')).toBe('neutral'); // -2.5%: not crossed
    });
  });
});

// ── Bootstrap phase ───────────────────────────────────────────────────────────

describe('evaluateStrategy — bootstrap', () => {
  const cfg = makeCfg();

  it('holds when RSI above bootstrapRsiThreshold', () => {
    const s = evalStrategy(100, 63, 100, 100, emptyPosition, cfg);
    expect(s.action).toBe('hold');
    expect(s.reason).toMatch(/waiting to bootstrap/i);
  });

  it('bootstraps when RSI drops below threshold', () => {
    const s = evalStrategy(100, 58, 100, 100, emptyPosition, cfg);
    expect(s.action).toBe('bootstrap');
    expect(s.targetSolPct).toBe(50);
  });

  it('holds when RSI null (no data)', () => {
    const s = evalStrategy(100, null, 100, 100, emptyPosition, cfg);
    expect(s.action).toBe('hold');
    expect(s.reason).toMatch(/rsi data/i);
  });
});

// ── Zone logic ────────────────────────────────────────────────────────────────

describe('evaluateStrategy — zone rebalancing (neutral trend)', () => {
  const cfg = makeCfg();
  const sma3d = 100; // price 0% from SMA → neutral trend

  it('hold when within drift threshold', () => {
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('hold');
    expect(s.zone).toBe('neutral');
  });

  it('rebalance_buy when under-allocated in neutral zone', () => {
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 30, 'flat');
    expect(s.action).toBe('rebalance_buy');
    expect(s.targetSolPct).toBe(50); // neutral target, no trend adj
  });

  it('rebalance_sell when over-allocated in neutral zone', () => {
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 70, 'flat');
    expect(s.action).toBe('rebalance_sell');
    expect(s.targetSolPct).toBe(50);
  });

  it('hold when drift is within threshold (5% under vs 7% threshold)', () => {
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 45, 'flat');
    expect(s.action).toBe('hold');
  });

  it('strong_buy zone: RSI < 28 AND price far below VWAP', () => {
    const vwap = 100 / (1 - 0.045); // 4.5% below VWAP
    const s = evaluateStrategy(100, 25, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('rebalance_buy');
    expect(s.zone).toBe('strong_buy');
    expect(s.targetSolPct).toBe(75);
  });

  it('moderate_buy zone: RSI < 40 AND price below VWAP by 2%+', () => {
    const vwap = 100 / (1 - 0.025);
    const s = evaluateStrategy(100, 35, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('rebalance_buy');
    expect(s.zone).toBe('moderate_buy');
    expect(s.targetSolPct).toBe(62);
  });

  it('moderate_sell zone: RSI > 62 AND price near VWAP', () => {
    const vwap = 99; // price ~1% above VWAP
    const s = evaluateStrategy(100, 65, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('rebalance_sell');
    expect(s.zone).toBe('moderate_sell');
    expect(s.targetSolPct).toBe(38);
  });

  it('moderate_sell NOT triggered when price crashed far below VWAP (RSI lagging)', () => {
    const vwap = 100 / (1 - 0.02); // price 2% below VWAP — exceeds floor
    const s = evaluateStrategy(100, 65, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('hold');
    expect(s.zone).toBe('neutral');
  });

  it('strong_sell zone: RSI > 72 AND price 2%+ above VWAP', () => {
    const vwap = 100 / (1 + 0.025);
    const s = evaluateStrategy(100, 75, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('rebalance_sell');
    expect(s.zone).toBe('strong_sell');
    expect(s.targetSolPct).toBe(25);
  });

  it('holds when RSI and VWAP null', () => {
    const s = evaluateStrategy(100, null, null, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('hold');
    expect(s.reason).toMatch(/insufficient/i);
  });
});

// ── Trend adjustment ──────────────────────────────────────────────────────────

describe('evaluateStrategy — trend-adjusted targets', () => {
  const cfg = makeCfg();

  it('bullish trend boosts neutral target by 10% (50 → 60)', () => {
    const sma3d = 90; // price 100 is +11% above SMA → bullish
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 30, 'flat');
    expect(s.action).toBe('rebalance_buy');
    expect(s.targetSolPct).toBe(60); // 50 + 10 = 60
  });

  it('bearish trend cuts neutral target by 12% (50 → 38)', () => {
    const sma3d = 115; // price 100 is -13% below SMA → bearish
    const s = evaluateStrategy(100, 55, 100, sma3d, bootstrapped, cfg, Date.now(), 55, 'flat');
    expect(s.action).toBe('rebalance_sell');
    expect(s.targetSolPct).toBe(38); // 50 - 12 = 38
  });

  it('bearish trend cuts moderate_buy target (62 → 50)', () => {
    const sma3d = 115; // bearish
    const vwap = 100 / (1 - 0.025); // 2.5% below VWAP — moderate_buy zone
    const s = evaluateStrategy(100, 35, vwap, sma3d, bootstrapped, cfg, Date.now(), 30, 'flat');
    expect(s.targetSolPct).toBe(50); // 62 - 12 = 50
  });

  it('bullish trend boosts moderate_sell target (38 → 48)', () => {
    const sma3d = 90; // bullish
    const vwap = 99; // price above VWAP — moderate_sell zone
    const s = evaluateStrategy(100, 65, vwap, sma3d, bootstrapped, cfg, Date.now(), 70, 'flat');
    expect(s.targetSolPct).toBe(48); // 38 + 10 = 48
  });

  it('target capped at 85% in bullish strong_buy', () => {
    const sma3d = 90; // bullish → +10
    const vwap = 100 / (1 - 0.045);
    const s = evaluateStrategy(100, 25, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.targetSolPct).toBe(85); // 75 + 10 = 85
  });

  it('target floored at 15% in bearish strong_sell', () => {
    const sma3d = 115; // bearish → -12
    const vwap = 100 / (1 + 0.025);
    const s = evaluateStrategy(100, 75, vwap, sma3d, bootstrapped, cfg, Date.now(), 50, 'flat');
    expect(s.targetSolPct).toBe(15); // max(15, 25 - 12) = 15
  });
});

// ── RSI direction filter ──────────────────────────────────────────────────────

describe('evaluateStrategy — RSI direction filter', () => {
  const cfg = makeCfg();
  const sma3d = 100;

  it('moderate_buy blocked when RSI is rising (possible bounce)', () => {
    const vwap = 100 / (1 - 0.025);
    const s = evaluateStrategy(100, 35, vwap, sma3d, bootstrapped, cfg, Date.now(), 30, 'rising');
    expect(s.action).toBe('hold');
    expect(s.reason).toMatch(/direction rising/i);
  });

  it('moderate_buy allowed when RSI is falling (confirmed dip)', () => {
    const vwap = 100 / (1 - 0.025);
    const s = evaluateStrategy(100, 35, vwap, sma3d, bootstrapped, cfg, Date.now(), 30, 'falling');
    expect(s.action).toBe('rebalance_buy');
    expect(s.zone).toBe('moderate_buy');
  });

  it('moderate_buy allowed when RSI is flat', () => {
    const vwap = 100 / (1 - 0.025);
    const s = evaluateStrategy(100, 35, vwap, sma3d, bootstrapped, cfg, Date.now(), 30, 'flat');
    expect(s.action).toBe('rebalance_buy');
  });

  it('strong_buy NOT filtered even when RSI is rising (extreme zone bypasses filter)', () => {
    const vwap = 100 / (1 - 0.045); // 4.5% below VWAP → strong_buy
    const s = evaluateStrategy(100, 25, vwap, sma3d, bootstrapped, cfg, Date.now(), 30, 'rising');
    expect(s.action).toBe('rebalance_buy');
    expect(s.zone).toBe('strong_buy');
  });

  it('sell signals are never filtered by RSI direction', () => {
    const vwap = 99; // moderate_sell zone
    const s = evaluateStrategy(100, 65, vwap, sma3d, bootstrapped, cfg, Date.now(), 70, 'falling');
    expect(s.action).toBe('rebalance_sell');
  });
});

// ── Emergency / risk exits ────────────────────────────────────────────────────

describe('evaluateStrategy — risk signals', () => {
  const cfg = makeCfg();
  const sma3d = 100;

  it('emergency_sell on stop loss (13% below avg entry)', () => {
    const avgEntry = 150;
    const price = avgEntry * (1 - 0.13);
    const pos: PositionState = { ...bootstrapped, averageEntryPrice: avgEntry, highWaterMark: avgEntry };
    const s = evaluateStrategy(price, 45, 155, sma3d, pos, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('emergency_sell');
    expect(s.zone).toBe('stop_loss');
    expect(s.targetSolPct).toBe(25);
    expect(s.reason).toMatch(/stop loss/i);
  });

  it('emergency_sell on trailing stop hit', () => {
    const pos: PositionState = {
      ...bootstrapped,
      averageEntryPrice: 100,
      highWaterMark: 150,
      trailingStopActive: true,
      trailingStopPrice: 140,
    };
    const s = evaluateStrategy(138, 45, 140, sma3d, pos, cfg, Date.now(), 50, 'flat');
    expect(s.action).toBe('emergency_sell');
    expect(s.zone).toBe('trailing_stop');
    expect(s.reason).toMatch(/trailing stop/i);
  });

  it('no stop loss when price is above threshold (12% drop, 13% required)', () => {
    const avgEntry = 150;
    const price = avgEntry * (1 - 0.12);
    const pos: PositionState = { ...bootstrapped, averageEntryPrice: avgEntry };
    const s = evaluateStrategy(price, 55, 135, sma3d, pos, cfg, Date.now(), 50, 'flat');
    expect(s.action).not.toBe('emergency_sell');
  });
});

// ── Cooldown ──────────────────────────────────────────────────────────────────

describe('evaluateStrategy — cooldown', () => {
  const cfg = makeCfg();

  it('holds during cooldown', () => {
    const pos: PositionState = { ...bootstrapped, cooldownUntil: Date.now() + 600_000 };
    const s = evalStrategy(100, 25, 110, 100, pos, cfg);
    expect(s.action).toBe('hold');
    expect(s.reason).toMatch(/cooldown/i);
  });

  it('resumes after cooldown expires', () => {
    const pos: PositionState = { ...bootstrapped, cooldownUntil: Date.now() - 60_000 };
    const vwap = 100 / (1 - 0.025);
    const s = evaluateStrategy(100, 35, vwap, 100, pos, cfg, Date.now(), 30, 'falling');
    expect(s.action).toBe('rebalance_buy');
  });
});

// ── Trailing stop mechanics ───────────────────────────────────────────────────

describe('updateTrailingStop', () => {
  const cfg = makeCfg();

  const base: PositionState = {
    ...bootstrapped,
    averageEntryPrice: 100,
    highWaterMark: 100,
  };

  it('does not activate below 10% profit', () => {
    const p = updateTrailingStop(base, 108, cfg);
    expect(p.trailingStopActive).toBe(false);
  });

  it('activates at 10% profit with 7% trail', () => {
    const p = updateTrailingStop(base, 110, cfg);
    expect(p.trailingStopActive).toBe(true);
    expect(p.trailingStopPrice).toBeCloseTo(110 * 0.93, 2);
  });

  it('ratchets stop upward as price makes new highs', () => {
    let p = updateTrailingStop(base, 110, cfg);
    p = updateTrailingStop(p, 120, cfg);
    expect(p.trailingStopPrice).toBeCloseTo(120 * 0.93, 2);
    expect(p.highWaterMark).toBeCloseTo(120, 4);
  });

  it('does not lower stop when price pulls back', () => {
    let p = updateTrailingStop(base, 120, cfg);
    const stopBefore = p.trailingStopPrice!;
    p = updateTrailingStop(p, 112, cfg);
    expect(p.trailingStopPrice).toBeCloseTo(stopBefore, 4);
  });

  it('does nothing when not bootstrapped', () => {
    const p = updateTrailingStop(emptyPosition, 120, cfg);
    expect(p.trailingStopActive).toBe(false);
  });
});
