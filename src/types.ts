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

export interface PositionState {
  bootstrapDone: boolean;          // has the initial 50% SOL buy been executed?
  solBalance: number;              // SOL held by bot (excludes gas reserve)
  averageEntryPrice: number;       // weighted avg entry across all rebalance buys
  highWaterMark: number;           // highest price seen while holding SOL
  trailingStopActive: boolean;
  trailingStopPrice: number | null;
  cooldownUntil: number | null;    // Unix ms — brief pause after emergency_sell
}

export interface StrategySignal {
  action: 'bootstrap' | 'rebalance_buy' | 'rebalance_sell' | 'emergency_sell' | 'hold';
  reason: string;
  price: number;
  rsi4h: number | null;
  vwap4h: number | null;
  sma3d: number | null;
  trendBias: TrendBias;
  zone: string;         // which allocation zone we're in (e.g. 'moderate_sell')
  targetSolPct: number; // desired SOL % of managed portfolio (0-100)
}

export interface TradeRecord {
  id?: number;
  timestamp: number;
  action: string;
  side: 'buy' | 'sell';
  solAmount: number;
  usdcAmount: number;
  price: number;
  zone: string | null;      // replaced tier — which zone triggered this trade
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
    };
    vwap: {
      resetPeriod: string;
    };
    sma: {
      period: number;
      neutralZonePct: number;
    };
    rebalance: {
      bootstrapRsiThreshold: number;   // RSI must be below this to trigger initial 50% buy
      driftThresholdPct: number;       // min SOL% drift from target before rebalancing
      minTradeUSDC: number;            // min trade size in USDC to avoid fee drag
      // Zone thresholds (RSI + VWAP deviation %):
      strongBuyRsi: number;            // RSI below → strong buy zone
      strongBuyVwapPct: number;        // price must be this % below VWAP
      strongBuyTargetSolPct: number;   // target SOL% in strong buy
      moderateBuyRsi: number;
      moderateBuyVwapPct: number;
      moderateBuyTargetSolPct: number;
      neutralTargetSolPct: number;     // target SOL% in neutral zone (also bootstrap target)
      moderateSellRsi: number;         // RSI above → moderate sell zone
      moderateSellVwapFloorPct: number; // price must not be more than this % below VWAP
      moderateSellTargetSolPct: number;
      strongSellRsi: number;
      strongSellVwapPct: number;       // price must be this % above VWAP
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
      candlesAfterExit: number;
      candleDurationMinutes: number;
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
