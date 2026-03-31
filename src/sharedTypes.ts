export type RsiDirection = 'rising' | 'falling' | 'flat';

export type SolanaBotV1TickAction =
  | 'HOLD'
  | 'BUY'
  | 'SELL'
  | 'BOOTSTRAP_SELL'
  | 'HALT'
  | 'COOLDOWN'
  | 'SKIP_IMPACT';

export interface ChecklistLine {
  label: string;
  pass: boolean;
  detail: string;
}

export interface SolanaBotV1TickNotification {
  ts: number;
  timeframe: string;
  mode: string;
  action: SolanaBotV1TickAction;
  decisionReason: string;

  price: number;
  rsi: number | null;
  rsiDirection: RsiDirection;
  vwap: number | null;
  vwapDevPct: number | null;
  emaTrendPct: number | null;
  emaSlopePct: number | null;
  atrPct: number | null;

  requiredDevPct: number | null;
  profitTargetPct: number | null;
  stopLossPct: number | null;

  position: {
    inPosition: boolean;
    entryPrice: number | null;
    entryAssumed: boolean;
    unrealizedPct: number | null;
    holdMinutes: number | null;
    solPct: number;
    solBalance: number;
    usdcBalance: number;
    totalValueUSDC: number;
  };

  risk: {
    dayPnlPct: number;
    tradesToday: number;
    maxDailyTrades: number;
    impactSkipsToday: number;
    dailyHalt: boolean;
    cooldownRemainingMin: number | null;
  };

  checklist: {
    gates: ChecklistLine[];
    entry: ChecklistLine[];
    exit: ChecklistLine[];
  };
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
