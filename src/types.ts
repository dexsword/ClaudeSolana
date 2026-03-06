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

export type Tier = 1 | 2 | 3;

export interface TierState {
  tier1Filled: boolean;
  tier2Filled: boolean;
  tier3Filled: boolean;
  tier1EntryPrice: number | null;
  tier2EntryPrice: number | null;
  tier3EntryPrice: number | null;
  tier1Amount: number; // USDC spent
  tier2Amount: number;
  tier3Amount: number;
}

export interface PositionState {
  inPosition: boolean;
  solBalance: number;        // SOL held by bot
  averageEntryPrice: number;
  highWaterMark: number;     // highest price since entry (for trailing stop)
  trailingStopActive: boolean;
  trailingStopPrice: number | null;
  tiers: TierState;
  cooldownUntil: number | null; // Unix ms
  partialExitDone: boolean; // RSI>70 sell 50% done
}

export interface StrategySignal {
  action: 'buy_tier1' | 'buy_tier2' | 'buy_tier3' | 'sell_half' | 'sell_all' | 'hold';
  reason: string;
  price: number;
  rsi4h: number | null;
  vwap4h: number | null;
  sma3d: number | null;
  trendBias: TrendBias;
}

export interface TradeRecord {
  id?: number;
  timestamp: number;
  action: string;
  side: 'buy' | 'sell';
  solAmount: number;
  usdcAmount: number;
  price: number;
  tier: number | null;
  txSignature: string | null;
  dryRun: boolean;
  reason: string;
  rsi: number | null;
  vwap: number | null;
  sma: number | null;
  trendBias: string;
  pnl: number | null;
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
      tier1BuyThreshold: number;
      tier2BuyThreshold: number;
      tier3BuyThreshold: number;
      sellThreshold: number;
      extendedSellThreshold: number;
      bearishBuyThreshold: number;
      neutralBuyThreshold: number;
    };
    vwap: {
      tier1DeviationPct: number;
      tier2DeviationPct: number;
      tier3DeviationPct: number;
      sellAtVwap: boolean;
      bearishDeviationPct: number;
      resetPeriod: string;
    };
    sma: {
      period: number;
      neutralZonePct: number;
    };
    tiers: {
      tier1AllocationPct: number;
      tier2AllocationPct: number;
      tier3AllocationPct: number;
    };
    risk: {
      stopLossPct: number;
      trailingStopActivationPct: number;
      trailingStopPct: number;
      circuitBreakerDrawdownPct: number;
      maxSlippagePct: number;
    };
    cooldown: {
      candlesAfterExit: number;
      candleDurationMinutes: number;
    };
  };
  capital: {
    startingCapitalUSDC: number;
    minSolReserveForGas: number; // SOL — bot halts trading if gas buffer drops below this
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
