import { BotConfig, PositionState, StrategySignal, TrendBias } from './types';

export function determineTrendBias(
  price: number,
  sma3d: number | null,
  cfg: BotConfig,
): TrendBias {
  if (sma3d === null) return 'neutral';

  const neutralZone = cfg.strategy.sma.neutralZonePct / 100;
  const pctFromSma = (price - sma3d) / sma3d;

  if (pctFromSma > neutralZone) return 'bullish';
  if (pctFromSma < -neutralZone) return 'bearish';
  return 'neutral';
}

export function evaluateStrategy(
  price: number,
  rsi4h: number | null,
  vwap4h: number | null,
  sma3d: number | null,
  position: PositionState,
  cfg: BotConfig,
  nowMs: number,
): StrategySignal {
  const trendBias = determineTrendBias(price, sma3d, cfg);
  const rsi = cfg.strategy.rsi;
  const vwapCfg = cfg.strategy.vwap;

  const base: Omit<StrategySignal, 'action' | 'reason'> = {
    price,
    rsi4h,
    vwap4h,
    sma3d,
    trendBias,
  };

  // ── SELL SIGNALS (checked first to protect capital) ─────────────────────
  if (position.inPosition && position.solBalance > 0) {
    const avgEntry = position.averageEntryPrice;

    // Stop loss: price dropped 8%+ below average entry
    const stopLossPrice = avgEntry * (1 - cfg.strategy.risk.stopLossPct / 100);
    if (price <= stopLossPrice) {
      return {
        ...base,
        action: 'sell_all',
        reason: `Stop loss triggered: price ${price.toFixed(4)} <= stop ${stopLossPrice.toFixed(4)}`,
      };
    }

    // Trailing stop
    if (position.trailingStopActive && position.trailingStopPrice !== null) {
      if (price <= position.trailingStopPrice) {
        return {
          ...base,
          action: 'sell_all',
          reason: `Trailing stop triggered: price ${price.toFixed(4)} <= trailing stop ${position.trailingStopPrice.toFixed(4)}`,
        };
      }
    }

    // Extended take profit: RSI > 80 → sell all remaining
    if (rsi4h !== null && rsi4h > rsi.extendedSellThreshold) {
      return {
        ...base,
        action: 'sell_all',
        reason: `Extended take profit: RSI ${rsi4h.toFixed(1)} > ${rsi.extendedSellThreshold}`,
      };
    }

    // Take profit: RSI > 70 AND price >= VWAP → sell 50%
    if (
      !position.partialExitDone &&
      rsi4h !== null &&
      vwap4h !== null &&
      rsi4h > rsi.sellThreshold &&
      price >= vwap4h
    ) {
      return {
        ...base,
        action: 'sell_half',
        reason: `Take profit: RSI ${rsi4h.toFixed(1)} > ${rsi.sellThreshold} AND price >= VWAP ${vwap4h.toFixed(4)}`,
      };
    }
  }

  // ── COOLDOWN CHECK ───────────────────────────────────────────────────────
  if (position.cooldownUntil !== null && nowMs < position.cooldownUntil) {
    const remainingMin = Math.round((position.cooldownUntil - nowMs) / 60000);
    return {
      ...base,
      action: 'hold',
      reason: `Cooldown active — ${remainingMin} min remaining`,
    };
  }

  // ── BUY SIGNALS ──────────────────────────────────────────────────────────
  if (rsi4h === null || vwap4h === null) {
    return { ...base, action: 'hold', reason: 'Insufficient indicator data' };
  }

  // Compute price deviation from VWAP (negative = below VWAP)
  const vwapDeviationPct = ((price - vwap4h) / vwap4h) * 100;

  // Bearish bias: only buy if RSI < 20 AND price > 5% below VWAP
  if (trendBias === 'bearish') {
    if (
      rsi4h < rsi.bearishBuyThreshold &&
      vwapDeviationPct <= -vwapCfg.bearishDeviationPct
    ) {
      return checkTierEntry(price, rsi4h, vwapDeviationPct, vwap4h, position, cfg, base, trendBias);
    }
    return {
      ...base,
      action: 'hold',
      reason: `Bearish bias — RSI ${rsi4h.toFixed(1)}, VWAP dev ${vwapDeviationPct.toFixed(2)}% (need RSI<${rsi.bearishBuyThreshold} AND dev<-${vwapCfg.bearishDeviationPct}%)`,
    };
  }

  // Neutral bias: only buy if RSI < 25
  if (trendBias === 'neutral') {
    if (rsi4h >= rsi.neutralBuyThreshold) {
      return {
        ...base,
        action: 'hold',
        reason: `Neutral bias — RSI ${rsi4h.toFixed(1)} not below ${rsi.neutralBuyThreshold}`,
      };
    }
  }

  // Bullish (and neutral with RSI < 25): tier entry logic
  return checkTierEntry(price, rsi4h, vwapDeviationPct, vwap4h, position, cfg, base, trendBias);
}

function checkTierEntry(
  price: number,
  rsi4h: number,
  vwapDeviationPct: number,
  vwap4h: number,
  position: PositionState,
  cfg: BotConfig,
  base: Omit<StrategySignal, 'action' | 'reason'>,
  trendBias: TrendBias,
): StrategySignal {
  const rsi = cfg.strategy.rsi;
  const vwapCfg = cfg.strategy.vwap;
  const tiers = position.tiers;

  // Tier 3: RSI < 20 AND dev <= -6%
  if (
    !tiers.tier3Filled &&
    tiers.tier2Filled && // must fill in order
    rsi4h < rsi.tier3BuyThreshold &&
    vwapDeviationPct <= -vwapCfg.tier3DeviationPct
  ) {
    return {
      ...base,
      action: 'buy_tier3',
      reason: `Tier 3 entry: RSI ${rsi4h.toFixed(1)} < ${rsi.tier3BuyThreshold}, VWAP dev ${vwapDeviationPct.toFixed(2)}%`,
    };
  }

  // Tier 2: RSI < 25 AND dev <= -4%
  if (
    !tiers.tier2Filled &&
    tiers.tier1Filled &&
    rsi4h < rsi.tier2BuyThreshold &&
    vwapDeviationPct <= -vwapCfg.tier2DeviationPct
  ) {
    return {
      ...base,
      action: 'buy_tier2',
      reason: `Tier 2 entry: RSI ${rsi4h.toFixed(1)} < ${rsi.tier2BuyThreshold}, VWAP dev ${vwapDeviationPct.toFixed(2)}%`,
    };
  }

  // Tier 1: RSI < 30 AND dev <= -2%
  if (
    !tiers.tier1Filled &&
    rsi4h < rsi.tier1BuyThreshold &&
    vwapDeviationPct <= -vwapCfg.tier1DeviationPct
  ) {
    return {
      ...base,
      action: 'buy_tier1',
      reason: `Tier 1 entry: RSI ${rsi4h.toFixed(1)} < ${rsi.tier1BuyThreshold}, VWAP dev ${vwapDeviationPct.toFixed(2)}%`,
    };
  }

  const filledCount = [tiers.tier1Filled, tiers.tier2Filled, tiers.tier3Filled].filter(Boolean).length;
  return {
    ...base,
    action: 'hold',
    reason: `Hold — RSI ${rsi4h.toFixed(1)}, VWAP dev ${vwapDeviationPct.toFixed(2)}%, tiers filled: ${filledCount}/3, bias: ${trendBias}`,
  };
}

/**
 * Update trailing stop and high-water mark given current price.
 * Mutates position in place and returns updated position.
 */
export function updateTrailingStop(position: PositionState, price: number, cfg: BotConfig): PositionState {
  if (!position.inPosition || position.solBalance === 0) return position;

  const avg = position.averageEntryPrice;
  const profitPct = ((price - avg) / avg) * 100;
  const activationPct = cfg.strategy.risk.trailingStopActivationPct;
  const trailPct = cfg.strategy.risk.trailingStopPct;

  // Update high-water mark
  if (price > position.highWaterMark) {
    position = { ...position, highWaterMark: price };
  }

  // Activate trailing stop once profit >= activationPct
  if (profitPct >= activationPct && !position.trailingStopActive) {
    const stopPrice = price * (1 - trailPct / 100);
    position = { ...position, trailingStopActive: true, trailingStopPrice: stopPrice };
  }

  // Ratchet trailing stop upward as price moves higher
  if (position.trailingStopActive && position.trailingStopPrice !== null) {
    const newStop = position.highWaterMark * (1 - trailPct / 100);
    if (newStop > position.trailingStopPrice) {
      position = { ...position, trailingStopPrice: newStop };
    }
  }

  return position;
}

export function buildInitialPosition(): PositionState {
  return {
    inPosition: false,
    solBalance: 0,
    averageEntryPrice: 0,
    highWaterMark: 0,
    trailingStopActive: false,
    trailingStopPrice: null,
    tiers: {
      tier1Filled: false,
      tier2Filled: false,
      tier3Filled: false,
      tier1EntryPrice: null,
      tier2EntryPrice: null,
      tier3EntryPrice: null,
      tier1Amount: 0,
      tier2Amount: 0,
      tier3Amount: 0,
    },
    cooldownUntil: null,
    partialExitDone: false,
  };
}
