export interface Candle {
  timestamp: number; // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorResult {
  rsi: number | null;
  vwap: number | null;
  sma50: number | null;
}

export type TrendBias = 'bullish' | 'neutral' | 'bearish';

/**
 * Regime-level trading policy derived from the current trend bias.
 * Applied on top of zone logic to modulate exposure and entry quality
 * without rewriting the core RSI/VWAP zone system.
 */
export type RegimePolicy = {
  buyEnabled: boolean;
  sellEnabled: boolean;
  /** Multiplicative scalar applied to zone targetSolPct after trend adjustment. */
  targetMultiplier: number;
  /** If set, overrides cfg.strategy.rebalance.driftThresholdPct for this regime. */
  driftThresholdOverridePct?: number;
  /** Added to moderateBuyRsi threshold — negative = require lower RSI to buy. */
  moderateBuyRsiAdjustment: number;
  /** Extra VWAP discount required below the configured moderateBuyVwapPct. */
  requiredExtraVwapDiscountPct: number;
};

export type RsiDirection = 'rising' | 'falling' | 'flat';

export interface PositionState {
  bootstrapDone: boolean;          // has the initial 50% SOL buy been executed?
  solBalance: number;              // SOL held by bot (excludes gas reserve)
  averageEntryPrice: number;       // weighted avg entry across all rebalance buys
  highWaterMark: number;           // highest price seen while holding SOL
  trailingStopActive: boolean;
  trailingStopPrice: number | null;
  cooldownUntil: number | null;    // Unix ms — pause after emergency_sell

  // Zone hysteresis: tracks how many consecutive candles the current zone has held
  pendingZone: string | null;
  pendingZoneCount: number;

  // After an emergency exit, require RSI to reach oversold before rebuilding
  requireOversoldRecovery: boolean;

  // Trend bias hysteresis: last confirmed trend so we don't flip on boundary noise
  lastTrendBias: TrendBias;

  // alignToCandle: timestamp (ms) of the last 4h candle the bot executed on
  lastExecutedCandleTs: number | null;
  // SMA value from last full execution — reused by intracandle check (avoids 3d candle refetch)
  lastSma3d: number | null;
}

export interface StrategySignal {
  action: 'bootstrap' | 'rebalance_buy' | 'rebalance_sell' | 'emergency_sell' | 'hold';
  reason: string;
  price: number;
  rsi4h: number | null;
  vwap4h: number | null;
  sma3d: number | null;
  trendBias: TrendBias;
  zone: string;            // allocation zone name (e.g. 'moderate_sell')
  targetSolPct: number;    // desired SOL % of managed portfolio (0–100)
  rsiDirection: RsiDirection;
}

export interface TradeRecord {
  id?: number;
  timestamp: number;
  action: string;
  side: 'buy' | 'sell';
  solAmount: number;
  usdcAmount: number;
  price: number;
  zone: string | null;
  txSignature: string | null;
  dryRun: boolean;
  reason: string;
  rsi: number | null;
  vwap: number | null;
  sma: number | null;
  trendBias: string;
  pnl: number | null;
  avgEntryAtSell: number | null;  // averageEntryPrice at moment of sell; null for buys
}

export interface SwapResult {
  success: boolean;
  txSignature: string | null;
  inputAmount: number;
  outputAmount: number;
  price: number;
  error?: string;
}

export interface BotConfig {
  strategy: {
    rsi: {
      period: number;
    };
    vwap: {
      resetPeriod: string;
    };
    sma: {
      period: number;
      neutralZonePct: number;
      trendHysteresisPct: number;  // how far price must recover before bias changes (< neutralZonePct)
    };
    rebalance: {
      bootstrapRsiThreshold: number;
      driftThresholdPct: number;
      minTradeUSDC: number;

      // Hysteresis: zone must hold this many consecutive candles before executing.
      // Buys and sells have separate counts — buys default to 1 (immediate) for
      // faster dip-catching; sells default to 2 for deliberate exits.
      buyConfirmationCandles: number;
      sellConfirmationCandles: number;

      // Trend adjustment: shifts all zone SOL targets based on SMA trend bias
      trendAdjustment: {
        bullishSolBoostPct: number;  // add this % to all targets in bullish trend
        bearishSolCutPct: number;    // subtract this % from all targets in bearish trend
      };

      // Zone thresholds
      strongBuyRsi: number;
      strongBuyVwapPct: number;
      strongBuyTargetSolPct: number;
      moderateBuyRsi: number;
      moderateBuyVwapPct: number;
      moderateBuyTargetSolPct: number;
      neutralTargetSolPct: number;
      moderateSellRsi: number;
      moderateSellVwapFloorPct: number;
      moderateSellTargetSolPct: number;
      strongSellRsi: number;
      strongSellVwapPct: number;
      strongSellTargetSolPct: number;
    };
    risk: {
      stopLossPct: number;
      trailingStopActivationPct: number;
      trailingStopPct: number;
      circuitBreakerDrawdownPct: number;
      maxSlippagePct: number;
    };
    cooldown: {
      candlesAfterExit: number;      // applies to emergency exits only
      candleDurationMinutes: number;
    };
    /** Bearish-regime policy values — read by getRegimePolicy() so they are optimizable. */
    regime: {
      bearTargetMultiplier:          number;  // scale all zone targets by this in bearish (e.g. 0.80)
      bearDriftOverridePct:          number;  // override drift threshold in bearish (e.g. 6)
      bearModerateBuyRsiAdjustment:  number;  // added to moderateBuyRsi; negative = stricter (e.g. -4)
      bearExtraVwapDiscountPct:      number;  // extra VWAP discount required in bearish (e.g. 1.5)
    };
  };
  capital: {
    startingCapitalUSDC: number;
    minSolReserveForGas: number;
  };
  timeframes: {
    executionTf: string;
    trendTf: string;
  };
  network: {
    useDevnet: boolean;
    rpcEndpoint: string;
  };
  notifications: {
    enabled: boolean;
    webhookUrl: string;
    type: string;
    botToken?: string;
  };
  scheduler: {
    cronExpression: string;
    alignToCandle: boolean;
  };
}
