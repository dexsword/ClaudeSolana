export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Bot2Config {
  bot2: {
    enabled: boolean;
    name: string;
    timeframe: string;
    strategy: {
      mode?: 'mean_reversion' | 'trend_pullback' | 'trend' | 'regime_switch';
      regimeFilter?: {
        enabled: boolean;
        emaPeriodDays: number;
        requireAboveEma: boolean;
        requireEmaSlopeUp: boolean;
        entryBufferPct?: number;
        exitBufferPct?: number;
      };
      rsi: {
        period: number;
        oversold: number;
        overbought: number;
        exitOversold: number;
        exitOverbought: number;
      };
      vwap: {
        anchor: string;
        deviationThresholdPct: number;
      };
      atr: {
        period: number;
        volatilityScale: boolean;
        maxPositionPct: number;
      };
      trendFilter: {
        enabled: boolean;
        emaPeriod: number;
        disableBelowPct: number;
        disableAbovePct: number;
      };
      entry: {
        minDeviationPct: number;
        confirmationCandles: number;
        maxRetries: number;
      };
      exit: {
        profitTargetPct: number;
        stopLossPct: number;
        trailingStopPct: number;
        trailingActivationPct: number;
        maxHoldMinutes: number;
      };
      position: {
        maxPositionPct: number;
        minTradeUSDC: number;
        pyramidingEnabled: boolean;
      };
      filters: {
        minVolumeUSD: number;
        minLiquidityPct: number;
      };
    };
    risk: {
      maxDailyTrades: number;
      maxDailyLossPct: number;
      cooldownMinutes: number;
      emergencyStopPct: number;
      maxQuotePriceImpactPct?: number;
    };
  };

  notifications?: {
    enabled: boolean;
    webhookUrl: string;
    type: 'discord' | 'telegram';
    botToken?: string;
  };

  scheduler?: {
    cronExpression: string;
  };
}

export interface Bot2Position {
  inPosition: boolean;
  entryPrice: number | null;
  entryAssumed?: boolean;
  entryTime: number | null;
  size: number;
  pnlPct: number;
  trailingActive: boolean;
  trailingPrice: number | null;
  cooldownUntil: number | null;
  tradesToday: number;
  lastTradeDate: string | null;
  peakValue: number;
  currentValue: number;
}

export interface Bot2Signal {
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  price: number;
  rsi: number | null;
  vwap: number | null;
  atrPercent: number | null;
  emaTrend: number | null;
  deviationPct: number;
}
