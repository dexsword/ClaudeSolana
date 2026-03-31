export type TrendBias = 'bullish' | 'neutral' | 'bearish';
export type RsiDirection = 'rising' | 'falling' | 'flat';

export interface StrategySignal {
  action: 'bootstrap' | 'rebalance_buy' | 'rebalance_sell' | 'emergency_sell' | 'hold';
  reason: string;
  price: number;
  rsi4h: number | null;
  vwap4h: number | null;
  sma3d: number | null;
  trendBias: TrendBias;
  zone: string;
  targetSolPct: number;
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
  avgEntryAtSell: number | null;
}

export interface SwapResult {
  success: boolean;
  txSignature: string | null;
  inputAmount: number;
  outputAmount: number;
  price: number;
  error?: string;
}
