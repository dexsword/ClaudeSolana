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

/**
 * Determine which allocation zone we are in based on RSI and VWAP deviation.
 * Returns the target SOL % and zone name.
 * Zones checked from most extreme to least extreme.
 */
function determineZone(
  rsi: number,
  vwapDevPct: number,
  cfg: BotConfig,
): { targetSolPct: number; zone: string } {
  const r = cfg.strategy.rebalance;

  // Strong buy: deeply oversold AND far below VWAP
  if (rsi < r.strongBuyRsi && vwapDevPct <= -r.strongBuyVwapPct) {
    return { targetSolPct: r.strongBuyTargetSolPct, zone: 'strong_buy' };
  }
  // Strong sell: overbought AND well above VWAP
  if (rsi > r.strongSellRsi && vwapDevPct >= r.strongSellVwapPct) {
    return { targetSolPct: r.strongSellTargetSolPct, zone: 'strong_sell' };
  }
  // Moderate buy: oversold AND below VWAP
  if (rsi < r.moderateBuyRsi && vwapDevPct <= -r.moderateBuyVwapPct) {
    return { targetSolPct: r.moderateBuyTargetSolPct, zone: 'moderate_buy' };
  }
  // Moderate sell: elevated RSI AND price not far below VWAP
  // (avoids selling during oversold dips where RSI is still high but price has dropped)
  if (rsi > r.moderateSellRsi && vwapDevPct >= -r.moderateSellVwapFloorPct) {
    return { targetSolPct: r.moderateSellTargetSolPct, zone: 'moderate_sell' };
  }

  return { targetSolPct: r.neutralTargetSolPct, zone: 'neutral' };
}

/**
 * Evaluate the current market state and return a trading signal.
 *
 * @param currentSolPct  Current SOL as % of total managed portfolio value (0-100).
 *                       Pass 0 when not yet bootstrapped.
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
): StrategySignal {
  const trendBias = determineTrendBias(price, sma3d, cfg);
  const base: Omit<StrategySignal, 'action' | 'reason' | 'zone' | 'targetSolPct'> = {
    price, rsi4h, vwap4h, sma3d, trendBias,
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
      reason: `Waiting to bootstrap — RSI ${rsi4h.toFixed(1)} above ${cfg.strategy.rebalance.bootstrapRsiThreshold} threshold`,
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
          reason: `Trailing stop: price $${price.toFixed(2)} ≤ trailing stop $${position.trailingStopPrice.toFixed(2)} (high water mark $${position.highWaterMark.toFixed(2)})`,
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
  const { targetSolPct, zone } = determineZone(rsi4h, vwapDevPct, cfg);
  const drift = currentSolPct - targetSolPct;
  const threshold = cfg.strategy.rebalance.driftThresholdPct;

  const zoneInfo = `Zone: ${zone} | RSI ${rsi4h.toFixed(1)}, VWAP dev ${vwapDevPct.toFixed(1)}% | Target: ${targetSolPct}% SOL, current: ${currentSolPct.toFixed(1)}%`;

  if (drift > threshold) {
    return {
      ...base,
      action: 'rebalance_sell',
      reason: `${zoneInfo} — over by ${drift.toFixed(1)}%`,
      zone,
      targetSolPct,
    };
  }

  if (drift < -threshold) {
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
 * Mutates position in place and returns updated position.
 */
export function updateTrailingStop(position: PositionState, price: number, cfg: BotConfig): PositionState {
  if (!position.bootstrapDone || position.solBalance === 0) return position;

  const avg = position.averageEntryPrice;
  if (avg <= 0) return position;

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

  // Ratchet trailing stop upward as price makes new highs
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
  };
}

/**
 * Migrate an old-format position (tier-based) to the new format if needed.
 * Safe to call on new-format positions too — returns them unchanged.
 */
export function migratePosition(raw: Record<string, unknown>): PositionState {
  // Already new format
  if (typeof raw.bootstrapDone === 'boolean') {
    return raw as unknown as PositionState;
  }
  // Old format — migrate
  return {
    bootstrapDone: Boolean(raw.inPosition),   // if was in position, treat as bootstrapped
    solBalance: (raw.solBalance as number) ?? 0,
    averageEntryPrice: (raw.averageEntryPrice as number) ?? 0,
    highWaterMark: (raw.highWaterMark as number) ?? 0,
    trailingStopActive: Boolean(raw.trailingStopActive),
    trailingStopPrice: (raw.trailingStopPrice as number | null) ?? null,
    cooldownUntil: (raw.cooldownUntil as number | null) ?? null,
  };
}
