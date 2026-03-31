import { evaluateSolanaBotV1CoreDetailed } from '../strategySolanaBotV1Core';
import type { SolanaBotV1Config, SolanaBotV1Position } from '../typesSolanaBotV1';

function makeCfg(overrides?: Partial<SolanaBotV1Config>): SolanaBotV1Config {
  const base: SolanaBotV1Config = {
    solanaBotV1: {
      enabled: true,
      name: 'test',
      timeframe: '1h',
      strategy: {
        mode: 'trend_pullback',
        regimeFilter: {
          enabled: false,
          emaPeriodDays: 200,
          requireAboveEma: true,
          requireEmaSlopeUp: false,
        },
        rsi: {
          period: 8,
          oversold: 35,
          overbought: 55,
          exitOversold: 40,
          exitOverbought: 65,
        },
        vwap: {
          anchor: 'session',
          deviationThresholdPct: 2,
        },
        atr: {
          period: 14,
          volatilityScale: false,
          maxPositionPct: 15,
        },
        trendFilter: {
          enabled: true,
          emaPeriod: 50,
          disableBelowPct: -4,
          disableAbovePct: 8,
        },
        entry: {
          minDeviationPct: 1.25,
          confirmationCandles: 1,
          maxRetries: 2,
        },
        exit: {
          profitTargetPct: 2,
          stopLossPct: 4,
          trailingStopPct: 1,
          trailingActivationPct: 1.5,
          maxHoldMinutes: 720,
        },
        position: {
          maxPositionPct: 80,
          minTradeUSDC: 5,
          pyramidingEnabled: false,
        },
        filters: {
          minVolumeUSD: 10_000,
          minLiquidityPct: 1,
        },
      },
      risk: {
        maxDailyTrades: 10,
        maxDailyLossPct: 5,
        cooldownMinutes: 5,
        emergencyStopPct: 10,
        maxQuotePriceImpactPct: 0.35,
      },
    },
  };

  return { ...base, ...(overrides ?? {}) };
}

function makePos(overrides?: Partial<SolanaBotV1Position>): SolanaBotV1Position {
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
    ...(overrides ?? {}),
  };
}

describe('evaluateSolanaBotV1CoreDetailed', () => {
  it('buys on pullback entry when all conditions pass', () => {
    const cfg = makeCfg();
    const pos = makePos({ inPosition: false });

    const res = evaluateSolanaBotV1CoreDetailed(
      {
        price: 98,
        nowMs: 1_700_000_000_000,
        rsi: 34,
        prevRsi: 36,
        vwap: 100,
        atrPercent: 2,
        ema: 97,
        prevEma: 96.9,
        htfEma: null,
        prevHtfEma: null,
      },
      pos,
      cfg,
    );

    expect(res.action).toBe('buy');
    expect(res.diagnostics.belowVwap).toBe(true);
    expect(res.diagnostics.recoveryOk).toBe(true);
  });

  it('holds if VWAP deviation is not deep enough', () => {
    const cfg = makeCfg();
    const pos = makePos({ inPosition: false });

    const res = evaluateSolanaBotV1CoreDetailed(
      {
        price: 99.5,
        nowMs: 1_700_000_000_000,
        rsi: 34,
        prevRsi: 36,
        vwap: 100,
        atrPercent: 2,
        ema: 98,
        prevEma: 97.9,
        htfEma: null,
        prevHtfEma: null,
      },
      pos,
      cfg,
    );

    expect(res.action).toBe('hold');
    expect(res.diagnostics.belowVwap).toBe(false);
  });

  it('sells on stop loss when pnl breaches threshold', () => {
    const cfg = makeCfg();
    const pos = makePos({
      inPosition: true,
      entryPrice: 100,
      entryTime: 1_700_000_000_000 - 60 * 60 * 1000,
      size: 1,
    });

    const res = evaluateSolanaBotV1CoreDetailed(
      {
        price: 95,
        nowMs: 1_700_000_000_000,
        rsi: 50,
        prevRsi: 51,
        vwap: 100,
        atrPercent: 2,
        // Keep price within the trend filter band so the stop-loss is the triggering exit.
        ema: 97,
        prevEma: 97,
        htfEma: null,
        prevHtfEma: null,
      },
      pos,
      cfg,
    );

    expect(res.action).toBe('sell');
    expect(res.diagnostics.stopLossHit).toBe(true);
  });

  it('sells on time exit when held too long and profitable', () => {
    const cfg = makeCfg();
    const pos = makePos({
      inPosition: true,
      entryPrice: 100,
      entryTime: 1_700_000_000_000 - 1_000 * 60 * 1000,
      size: 1,
    });

    const res = evaluateSolanaBotV1CoreDetailed(
      {
        price: 100.5,
        nowMs: 1_700_000_000_000,
        rsi: 50,
        prevRsi: 51,
        vwap: 100,
        atrPercent: 2,
        ema: 100,
        prevEma: 100,
        htfEma: null,
        prevHtfEma: null,
      },
      pos,
      cfg,
    );

    expect(res.action).toBe('sell');
    expect(res.diagnostics.timeExitHit).toBe(true);
  });
});
