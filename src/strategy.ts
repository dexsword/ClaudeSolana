import { BotConfig, PositionState, RegimePolicy, RsiDirection, StrategySignal, TrendBias } from './types';

export function determineTrendBias(
  price: number,
  sma3d: number | null,
  cfg: BotConfig,
  previousBias: TrendBias = 'neutral',
): TrendBias {
  if (sma3d === null) return 'neutral';

  const outerZone = cfg.strategy.sma.neutralZonePct / 100;
  const hysteresis = (cfg.strategy.sma.trendHysteresisPct ?? 0) / 100;
  // Inner threshold: how far price must recover before the bias releases back to neutral.
  // Must be strictly less than outerZone so the hysteresis band has width.
  const innerZone = Math.max(0, outerZone - hysteresis);

  const pctFromSma = (price - sma3d) / sma3d;

  if (previousBias === 'bearish') {
    // Stay bearish until price recovers past the inner (release) threshold
    if (pctFromSma > -innerZone) return 'neutral';
    return 'bearish';
  }

  if (previousBias === 'bullish') {
    // Stay bullish until price falls past the inner (release) threshold
    if (pctFromSma < innerZone) return 'neutral';
    return 'bullish';
  }

  // Was neutral: use outer thresholds to enter a bias
  if (pctFromSma > outerZone) return 'bullish';
  if (pctFromSma < -outerZone) return 'bearish';
  return 'neutral';
}

/**
 * Returns the regime-level trading policy for the current trend bias.
 * Bearish values are read from cfg.strategy.regime so they can be optimized
 * without touching this function. Bullish/neutral remain permissive.
 */
export function getRegimePolicy(trendBias: TrendBias, cfg: BotConfig): RegimePolicy {
  if (trendBias === 'bearish') {
    const reg = cfg.strategy.regime;
    return {
      buyEnabled:                   true,
      sellEnabled:                  true,
      targetMultiplier:             reg.bearTargetMultiplier,
      driftThresholdOverridePct:    reg.bearDriftOverridePct,
      moderateBuyRsiAdjustment:     reg.bearModerateBuyRsiAdjustment,
      requiredExtraVwapDiscountPct: reg.bearExtraVwapDiscountPct,
    };
  }
  // bullish and neutral: no adjustments — zone logic runs as-is
  return {
    buyEnabled:                   true,
    sellEnabled:                  true,
    targetMultiplier:             1.0,
    driftThresholdOverridePct:    undefined,
    moderateBuyRsiAdjustment:     0,
    requiredExtraVwapDiscountPct: 0,
  };
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
  const trendBias = determineTrendBias(price, sma3d, cfg, position.lastTrendBias ?? 'neutral');
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
  const { targetSolPct: rawTargetSolPct, zone } = determineZone(rsi4h, vwapDevPct, trendBias, cfg);

  // ── REGIME POLICY ──────────────────────────────────────────────────────────
  // Applied after zone determination — scales target exposure and tightens entry
  // criteria in bearish regimes without touching the zone classification itself.
  const policy = getRegimePolicy(trendBias, cfg);

  // Scale down target allocation in bearish regime (multiplicative, on top of bearishSolCutPct)
  const targetSolPct = Math.max(10, Math.min(85, Math.round(rawTargetSolPct * policy.targetMultiplier)));

  // Tighter drift threshold in bearish regime — react faster to deteriorating positions
  const threshold = policy.driftThresholdOverridePct ?? cfg.strategy.rebalance.driftThresholdPct;

  const drift = currentSolPct - targetSolPct;

  const zoneInfo = `Zone: ${zone} [trend: ${trendBias}, multiplier: ${policy.targetMultiplier}x] | RSI ${rsi4h.toFixed(1)} (${rsiDirection}), VWAP dev ${vwapDevPct.toFixed(1)}% | Target: ${targetSolPct}% SOL (raw: ${rawTargetSolPct}%), current: ${currentSolPct.toFixed(1)}%, drift threshold: ${threshold}%`;

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

  // Buy signals
  if (drift < -threshold) {
    // Regime gate: buys fully disabled (not used in current policy but respected if set)
    if (!policy.buyEnabled) {
      return {
        ...base,
        action: 'hold',
        reason: `${zoneInfo} — buys disabled in ${trendBias} regime`,
        zone,
        targetSolPct,
      };
    }

    // Bearish regime: apply stricter RSI and VWAP entry bars for moderate_buy.
    // Strong_buy (extreme oversold) bypasses the RSI gate — deep dips still trigger.
    // Both zones must clear the deeper VWAP discount bar.
    if (trendBias === 'bearish' && (zone === 'moderate_buy' || zone === 'strong_buy')) {
      const rsiCeiling = cfg.strategy.rebalance.moderateBuyRsi + policy.moderateBuyRsiAdjustment;
      const rsiTooHigh = zone === 'moderate_buy' && rsi4h > rsiCeiling;

      const vwapBar = cfg.strategy.rebalance.moderateBuyVwapPct + policy.requiredExtraVwapDiscountPct;
      const notDiscountedEnough = vwapDevPct > -vwapBar;

      if (rsiTooHigh || notDiscountedEnough) {
        const why = rsiTooHigh
          ? `RSI ${rsi4h.toFixed(1)} > bearish ceiling ${rsiCeiling}`
          : `VWAP dev ${vwapDevPct.toFixed(1)}% > required -${vwapBar}%`;
        return {
          ...base,
          action: 'hold',
          reason: `${zoneInfo} — bearish regime buy blocked: ${why}`,
          zone,
          targetSolPct,
        };
      }
    }

    // RSI direction filter for moderate_buy only (unchanged from original).
    // Rising RSI through moderate_buy may be a bounce — wait for it to stabilise.
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
    reason: `${zoneInfo} — within threshold (drift ${drift > 0 ? '+' : ''}${drift.toFixed(1)}%)`,
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
    lastTrendBias: 'neutral',
    lastExecutedCandleTs: null,
    lastSma3d: null,
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
      lastTrendBias: (raw.lastTrendBias as TrendBias | undefined) ?? 'neutral',
      lastExecutedCandleTs: (raw.lastExecutedCandleTs as number | null) ?? null,
      lastSma3d: (raw.lastSma3d as number | null) ?? null,
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
    lastTrendBias: 'neutral',
    lastExecutedCandleTs: null,
    lastSma3d: null,
  };
}
