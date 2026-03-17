import { BotConfig, PositionState, RsiDirection, StrategySignal, TrendBias } from './types';

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

/**
 * Determine which allocation zone we're in based on RSI and VWAP deviation,
 * then apply a trend-bias adjustment to the SOL target.
 *
 * Trend adjustment shifts all targets up in bullish markets and down in bearish,
 * making the bot inherently more aggressive in uptrends and more defensive in downtrends.
 *
 * Zones are checked from most extreme to least extreme so strong signals take priority.
 */
function determineZone(
  rsi: number,
  vwapDevPct: number,
  trendBias: TrendBias,
  cfg: BotConfig,
): { targetSolPct: number; zone: string } {
  const r = cfg.strategy.rebalance;

  let targetSolPct: number;
  let zone: string;

  if (rsi < r.strongBuyRsi && vwapDevPct <= -r.strongBuyVwapPct) {
    targetSolPct = r.strongBuyTargetSolPct;
    zone = 'strong_buy';
  } else if (rsi > r.strongSellRsi && vwapDevPct >= r.strongSellVwapPct) {
    targetSolPct = r.strongSellTargetSolPct;
    zone = 'strong_sell';
  } else if (rsi < r.moderateBuyRsi && vwapDevPct <= -r.moderateBuyVwapPct) {
    targetSolPct = r.moderateBuyTargetSolPct;
    zone = 'moderate_buy';
  } else if (rsi > r.moderateSellRsi && vwapDevPct >= -r.moderateSellVwapFloorPct) {
    targetSolPct = r.moderateSellTargetSolPct;
    zone = 'moderate_sell';
  } else {
    targetSolPct = r.neutralTargetSolPct;
    zone = 'neutral';
  }

  // Trend adjustment: shift all targets based on macro trend.
  // Capped at 85% max (never all-in) and 15% min (never near-zero in case of error).
  const adj = r.trendAdjustment;
  if (trendBias === 'bullish') {
    targetSolPct = Math.min(85, targetSolPct + adj.bullishSolBoostPct);
  } else if (trendBias === 'bearish') {
    targetSolPct = Math.max(15, targetSolPct - adj.bearishSolCutPct);
  }

  // Round to nearest whole percent to keep math clean
  targetSolPct = Math.round(targetSolPct);

  return { targetSolPct, zone };
}

/**
 * Evaluate the current market state and return a trading signal.
 *
 * @param currentSolPct   Current SOL as % of total managed portfolio (0–100). Pass 0 pre-bootstrap.
 * @param rsiDirection    Whether RSI is rising, falling, or flat vs 2 candles ago.
 */
export function evaluateStrategy(
  price: number,
  rsi4h: number | null,
  vwap4h: number | null,
  sma3d: number | null,
  position: PositionState,
  cfg: BotConfig,
  nowMs: number,
  currentSolPct: number,
  rsiDirection: RsiDirection,
): StrategySignal {
  const trendBias = determineTrendBias(price, sma3d, cfg);
  const base: Omit<StrategySignal, 'action' | 'reason' | 'zone' | 'targetSolPct'> = {
    price, rsi4h, vwap4h, sma3d, trendBias, rsiDirection,
  };

  // ── COOLDOWN CHECK ─────────────────────────────────────────────────────────
  if (position.cooldownUntil !== null && nowMs < position.cooldownUntil) {
    const remainingMin = Math.round((position.cooldownUntil - nowMs) / 60000);
    return {
      ...base,
      action: 'hold',
      reason: `Cooldown active — ${remainingMin} min remaining`,
      zone: 'cooldown',
      targetSolPct: cfg.strategy.rebalance.strongSellTargetSolPct,
    };
  }

  // ── BOOTSTRAP PHASE ────────────────────────────────────────────────────────
  // Bot starts all-USDC. Wait for a non-overbought RSI before buying initial 50%.
  if (!position.bootstrapDone) {
    if (rsi4h === null) {
      return {
        ...base, action: 'hold',
        reason: 'Waiting for RSI data before bootstrap',
        zone: 'bootstrap_wait',
        targetSolPct: 0,
      };
    }
    if (rsi4h < cfg.strategy.rebalance.bootstrapRsiThreshold) {
      return {
        ...base,
        action: 'bootstrap',
        reason: `Bootstrap: RSI ${rsi4h.toFixed(1)} < ${cfg.strategy.rebalance.bootstrapRsiThreshold} — buying initial ${cfg.strategy.rebalance.neutralTargetSolPct}% SOL allocation`,
        zone: 'bootstrap',
        targetSolPct: cfg.strategy.rebalance.neutralTargetSolPct,
      };
    }
    return {
      ...base, action: 'hold',
      reason: `Waiting to bootstrap — RSI ${rsi4h.toFixed(1)} above threshold ${cfg.strategy.rebalance.bootstrapRsiThreshold}`,
      zone: 'bootstrap_wait',
      targetSolPct: 0,
    };
  }

  // ── RISK CHECKS (evaluated before zone logic to protect capital) ───────────
  if (position.solBalance > 0 && position.averageEntryPrice > 0) {
    const avgEntry = position.averageEntryPrice;
    const minTarget = cfg.strategy.rebalance.strongSellTargetSolPct;

    // Stop loss: price fell too far below average entry
    const stopLossPrice = avgEntry * (1 - cfg.strategy.risk.stopLossPct / 100);
    if (price <= stopLossPrice) {
      return {
        ...base,
        action: 'emergency_sell',
        reason: `Stop loss: price $${price.toFixed(2)} ≤ stop $${stopLossPrice.toFixed(2)} (${cfg.strategy.risk.stopLossPct}% below avg entry $${avgEntry.toFixed(2)})`,
        zone: 'stop_loss',
        targetSolPct: minTarget,
      };
    }

    // Trailing stop: price pulled back from peak after reaching profit target
    if (position.trailingStopActive && position.trailingStopPrice !== null) {
      if (price <= position.trailingStopPrice) {
        return {
          ...base,
          action: 'emergency_sell',
          reason: `Trailing stop: price $${price.toFixed(2)} ≤ trailing stop $${position.trailingStopPrice.toFixed(2)} (HWM $${position.highWaterMark.toFixed(2)})`,
          zone: 'trailing_stop',
          targetSolPct: minTarget,
        };
      }
    }
  }

  // ── ZONE LOGIC ─────────────────────────────────────────────────────────────
  if (rsi4h === null || vwap4h === null) {
    return {
      ...base, action: 'hold',
      reason: 'Insufficient indicator data',
      zone: 'no_data',
      targetSolPct: cfg.strategy.rebalance.neutralTargetSolPct,
    };
  }

  const vwapDevPct = ((price - vwap4h) / vwap4h) * 100;
  const { targetSolPct, zone } = determineZone(rsi4h, vwapDevPct, trendBias, cfg);
  const drift = currentSolPct - targetSolPct;
  const threshold = cfg.strategy.rebalance.driftThresholdPct;

  const zoneInfo = `Zone: ${zone} [trend: ${trendBias}] | RSI ${rsi4h.toFixed(1)} (${rsiDirection}), VWAP dev ${vwapDevPct.toFixed(1)}% | Target: ${targetSolPct}% SOL, current: ${currentSolPct.toFixed(1)}%`;

  // Sell signals: execute without RSI direction filter (protecting gains is priority)
  if (drift > threshold) {
    return {
      ...base,
      action: 'rebalance_sell',
      reason: `${zoneInfo} — over by ${drift.toFixed(1)}%`,
      zone,
      targetSolPct,
    };
  }

  // Buy signals: apply RSI direction filter for moderate_buy only.
  // When RSI is rising through the moderate_buy zone (30→40) it may be bouncing,
  // not dipping. Wait for RSI to stop rising before buying the dip.
  // Strong_buy (RSI < 28) is extreme enough that direction doesn't matter — act immediately.
  if (drift < -threshold) {
    if (zone === 'moderate_buy' && rsiDirection === 'rising') {
      return {
        ...base,
        action: 'hold',
        reason: `${zoneInfo} — RSI direction rising through moderate_buy (possible bounce, not dip) — waiting for RSI to stabilise or fall`,
        zone,
        targetSolPct,
      };
    }
    return {
      ...base,
      action: 'rebalance_buy',
      reason: `${zoneInfo} — under by ${Math.abs(drift).toFixed(1)}%`,
      zone,
      targetSolPct,
    };
  }

  return {
    ...base,
    action: 'hold',
    reason: `${zoneInfo} — within ${threshold}% drift threshold (drift ${drift > 0 ? '+' : ''}${drift.toFixed(1)}%)`,
    zone,
    targetSolPct,
  };
}

/**
 * Update trailing stop and high-water mark given current price.
 */
export function updateTrailingStop(position: PositionState, price: number, cfg: BotConfig): PositionState {
  if (!position.bootstrapDone || position.solBalance === 0) return position;

  const avg = position.averageEntryPrice;
  if (avg <= 0) return position;

  const profitPct = ((price - avg) / avg) * 100;
  const activationPct = cfg.strategy.risk.trailingStopActivationPct;
  const trailPct = cfg.strategy.risk.trailingStopPct;

  if (price > position.highWaterMark) {
    position = { ...position, highWaterMark: price };
  }

  if (profitPct >= activationPct && !position.trailingStopActive) {
    const stopPrice = price * (1 - trailPct / 100);
    position = { ...position, trailingStopActive: true, trailingStopPrice: stopPrice };
  }

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
    bootstrapDone: false,
    solBalance: 0,
    averageEntryPrice: 0,
    highWaterMark: 0,
    trailingStopActive: false,
    trailingStopPrice: null,
    cooldownUntil: null,
    pendingZone: null,
    pendingZoneCount: 0,
    requireOversoldRecovery: false,
  };
}

/**
 * Migrate any persisted position state to the current format.
 * Handles both the original tier-based format and intermediate formats
 * that may be missing newer fields.
 */
export function migratePosition(raw: Record<string, unknown>): PositionState {
  // Both new and intermediate formats have bootstrapDone
  if (typeof raw.bootstrapDone === 'boolean') {
    return {
      bootstrapDone: raw.bootstrapDone,
      solBalance: (raw.solBalance as number) ?? 0,
      averageEntryPrice: (raw.averageEntryPrice as number) ?? 0,
      highWaterMark: (raw.highWaterMark as number) ?? 0,
      trailingStopActive: Boolean(raw.trailingStopActive),
      trailingStopPrice: (raw.trailingStopPrice as number | null) ?? null,
      cooldownUntil: (raw.cooldownUntil as number | null) ?? null,
      // New fields — default safely if absent (first run after upgrade)
      pendingZone: (raw.pendingZone as string | null) ?? null,
      pendingZoneCount: (raw.pendingZoneCount as number) ?? 0,
      requireOversoldRecovery: Boolean(raw.requireOversoldRecovery ?? false),
    };
  }
  // Original tier-based format — full migration
  return {
    bootstrapDone: Boolean(raw.inPosition),
    solBalance: (raw.solBalance as number) ?? 0,
    averageEntryPrice: (raw.averageEntryPrice as number) ?? 0,
    highWaterMark: (raw.highWaterMark as number) ?? 0,
    trailingStopActive: Boolean(raw.trailingStopActive),
    trailingStopPrice: (raw.trailingStopPrice as number | null) ?? null,
    cooldownUntil: (raw.cooldownUntil as number | null) ?? null,
    pendingZone: null,
    pendingZoneCount: 0,
    requireOversoldRecovery: false,
  };
}
