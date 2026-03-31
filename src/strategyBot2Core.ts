import { Bot2Config, Bot2Position } from './typesBot2';

export type Bot2Action = 'buy' | 'sell' | 'hold';

export interface Bot2CoreInputs {
  price: number;
  nowMs: number;

  // Indicators (precomputed by caller)
  rsi: number | null;
  prevRsi: number | null;
  vwap: number | null;
  atrPercent: number | null;
  ema: number | null;
  prevEma: number | null;

  // Higher-timeframe regime inputs (optional)
  htfEma: number | null;
  prevHtfEma: number | null;
}

export interface Bot2CoreResult {
  action: Bot2Action;
  reason: string;
}

function rsiDir(rsi: number | null, prevRsi: number | null): 'rising' | 'falling' | 'flat' {
  if (rsi === null || prevRsi === null) return 'flat';
  if (rsi > prevRsi) return 'rising';
  if (rsi < prevRsi) return 'falling';
  return 'flat';
}

function pct(a: number, b: number): number {
  return b === 0 ? 0 : (a - b) / b * 100;
}

/**
 * Bot2 core decision logic.
 * Designed to be used by both live bot and backtests.
 */
export function evaluateBot2Core(inputs: Bot2CoreInputs, position: Bot2Position, cfg: Bot2Config): Bot2CoreResult {
  const s = cfg.bot2.strategy;
  const mode = s.mode ?? 'mean_reversion';
  const { price, nowMs, rsi, prevRsi, vwap, atrPercent, ema, prevEma, htfEma, prevHtfEma } = inputs;

  if (rsi === null || vwap === null) {
    return { action: 'hold', reason: 'Waiting for indicators' };
  }

  if (position.cooldownUntil && nowMs < position.cooldownUntil) {
    const remaining = Math.max(0, Math.round((position.cooldownUntil - nowMs) / 60000));
    return { action: 'hold', reason: `Cooldown: ${remaining}min` };
  }

  const deviationPct = pct(price, vwap);
  const dir = rsiDir(rsi, prevRsi);

  const requiredDevPct = ((): number => {
    if (!s.atr.volatilityScale || atrPercent === null) return s.entry.minDeviationPct;
    return Math.max(s.entry.minDeviationPct, atrPercent * 0.5);
  })();

  const profitTargetPct = ((): number => {
    if (!s.atr.volatilityScale || atrPercent === null) return s.exit.profitTargetPct;
    return Math.max(s.exit.profitTargetPct, atrPercent * 0.6);
  })();

  const stopLossPct = ((): number => {
    if (!s.atr.volatilityScale || atrPercent === null) return s.exit.stopLossPct;
    return Math.max(s.exit.stopLossPct, atrPercent * 1.2);
  })();

  // Trend filter gates entries, but never blocks exits.
  let allowEntry = true;
  let entryGateReason: string | null = null;
  let emaTrendPct: number | null = null;
  let emaSlopePct: number | null = null;

  if (s.trendFilter.enabled && ema !== null && prevEma !== null) {
    emaTrendPct = pct(price, ema);
    emaSlopePct = pct(ema, prevEma);

    if (!position.inPosition) {
      if (emaTrendPct < s.trendFilter.disableBelowPct) {
        allowEntry = false;
        entryGateReason = `Trend filter: ${emaTrendPct.toFixed(1)}% below EMA`;
      } else if (emaTrendPct > s.trendFilter.disableAbovePct) {
        allowEntry = false;
        entryGateReason = `Trend filter: ${emaTrendPct.toFixed(1)}% above EMA`;
      } else if (emaSlopePct < -0.05) {
        allowEntry = false;
        entryGateReason = `Trend filter: EMA slope ${emaSlopePct.toFixed(2)}%`;
      }
    }
  }

  // Regime-switch mode: simplest production-grade system.
  // Buy when above daily EMA, sell when below.
  if (mode === 'regime_switch') {
    const rf = s.regimeFilter;
    if (!rf?.enabled || htfEma === null) {
      return { action: 'hold', reason: 'Regime switch: waiting for HTF EMA' };
    }

    const trendPct = pct(price, htfEma);
    const slopeUp = prevHtfEma !== null ? (htfEma >= prevHtfEma) : true;
    const entryBuf = rf.entryBufferPct ?? 0;
    const exitBuf = rf.exitBufferPct ?? 0;

    if (!position.inPosition) {
      if (rf.requireAboveEma && trendPct < entryBuf) {
        return { action: 'hold', reason: `Regime: below EMA (${trendPct.toFixed(1)}%)` };
      }
      if (rf.requireEmaSlopeUp && !slopeUp) {
        return { action: 'hold', reason: 'Regime: EMA slope down' };
      }
      return { action: 'buy', reason: `Regime buy: ${trendPct.toFixed(1)}% above EMA` };
    }

    // in position
    if (rf.requireAboveEma && trendPct < -exitBuf) {
      return { action: 'sell', reason: `Regime sell: ${trendPct.toFixed(1)}% below EMA` };
    }

    return { action: 'hold', reason: `Regime hold: ${trendPct.toFixed(1)}% above EMA` };
  }

  if (position.inPosition && position.entryPrice && position.entryTime) {
    const pnlPct = pct(price, position.entryPrice);
    const holdMinutes = (nowMs - position.entryTime) / 60000;

    // Regime exit: if we drift deep below EMA, exit to avoid grinding drawdowns.
    if (s.trendFilter.enabled && emaTrendPct !== null && emaTrendPct < s.trendFilter.disableBelowPct) {
      return { action: 'sell', reason: `Regime exit: ${emaTrendPct.toFixed(1)}% below EMA` };
    }

    // Note: we do not force exits on regime flips; it only gates new entries.

    // Hard risk exits
    if (pnlPct <= -stopLossPct) {
      return { action: 'sell', reason: `Stop loss: ${pnlPct.toFixed(2)}%` };
    }
    if (position.trailingActive && position.trailingPrice && price <= position.trailingPrice) {
      return { action: 'sell', reason: 'Trailing stop hit' };
    }

    // Profit-taking (disabled in trend mode to allow big winners)
    if (mode !== 'trend') {
      if (pnlPct >= profitTargetPct) {
        return { action: 'sell', reason: `Profit target: ${pnlPct.toFixed(2)}%` };
      }
    }

    if (mode === 'trend') {
      // Trend exit: regime break (price below EMA).
      if (emaTrendPct !== null && emaTrendPct < 0) {
        return { action: 'sell', reason: `Trend exit: below EMA (${emaTrendPct.toFixed(1)}%)` };
      }
    } else {
      // MR / pullback exits
      // Only take the VWAP reversion exit once some profit is present;
      // otherwise let profit target / trailing do the work.
      const reversionOk = deviationPct >= -Math.max(0.1, s.entry.minDeviationPct * 0.25);
      if (reversionOk && pnlPct >= Math.max(0.4, profitTargetPct * 0.5)) {
        return { action: 'sell', reason: `Reversion: dev=${deviationPct.toFixed(2)}% at +${pnlPct.toFixed(2)}%` };
      }
      if (rsi > s.rsi.exitOverbought && dir === 'falling') {
        return { action: 'sell', reason: `RSI exit: ${rsi.toFixed(1)}` };
      }
    }

    // Time-based exit to avoid stagnation (not for trend mode)
    if (mode !== 'trend') {
      if (holdMinutes > s.exit.maxHoldMinutes && pnlPct > 0) {
        return { action: 'sell', reason: `Time exit: ${holdMinutes.toFixed(0)}min at +${pnlPct.toFixed(2)}%` };
      }
    }

    // Volatility exit: if ATR spikes and we haven't reverted, reduce churn by waiting.
    if (atrPercent !== null && atrPercent > 6.0) {
      return { action: 'hold', reason: `High vol: ATR ${atrPercent.toFixed(1)}%` };
    }

    return { action: 'hold', reason: `Holding: ${pnlPct.toFixed(2)}%` };
  }

  // Volatility gate: avoid entries in extreme volatility spikes.
  const volOk = atrPercent === null ? true : atrPercent <= 8.0;

  if (!allowEntry) {
    return { action: 'hold', reason: entryGateReason ?? 'Entry gated' };
  }

  const oversoldNow = rsi < s.rsi.oversold;
  const wasOversold = prevRsi !== null && prevRsi < s.rsi.oversold;
  const belowVwap = deviationPct <= -requiredDevPct;
  const aboveVwap = deviationPct >= 0;
  const bullishRegime = emaTrendPct === null ? true : emaTrendPct >= 0;
  const emaSlopeUp = emaSlopePct === null ? true : emaSlopePct >= 0;

  if (mode === 'trend') {
    // Trend-following:
    // - Enter when price is above EMA and EMA slope is up.
    // - Exit handled in-position on EMA break.
    if (bullishRegime && emaSlopeUp && volOk) {
      return { action: 'buy', reason: `Trend entry: EMA=${emaTrendPct?.toFixed(1) ?? 'n/a'}%` };
    }

    return { action: 'hold', reason: 'No entry signal' };
  }

  if (mode === 'trend_pullback') {
    // Buy dips in an uptrend.
    const recoveryOk = oversoldNow || (wasOversold && rsi >= s.rsi.exitOversold);
    if (bullishRegime && emaSlopeUp && belowVwap && recoveryOk && volOk) {
      return { action: 'buy', reason: `Pullback entry: RSI=${rsi.toFixed(1)} (${dir}), dev=${deviationPct.toFixed(2)}%` };
    }
    return { action: 'hold', reason: 'No entry signal' };
  }

  // mean_reversion
  const recoveryOk = oversoldNow || (wasOversold && rsi >= s.rsi.exitOversold);
  if (belowVwap && recoveryOk && volOk) {
    return { action: 'buy', reason: `MR entry: RSI=${rsi.toFixed(1)} (${dir}), dev=${deviationPct.toFixed(2)}%` };
  }

  return { action: 'hold', reason: 'No entry signal' };
}
