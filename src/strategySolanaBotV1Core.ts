import { SolanaBotV1Config, SolanaBotV1Position } from './typesSolanaBotV1';

export type SolanaBotV1Action = 'buy' | 'sell' | 'hold';

export interface SolanaBotV1CoreInputs {
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

export interface SolanaBotV1CoreResult {
  action: SolanaBotV1Action;
  reason: string;
}

export interface SolanaBotV1CoreDiagnostics {
  mode: NonNullable<SolanaBotV1Config['solanaBotV1']['strategy']['mode']>;
  deviationPct: number;
  requiredDevPct: number;
  profitTargetPct: number;
  stopLossPct: number;
  rsiDirection: 'rising' | 'falling' | 'flat';
  emaTrendPct: number | null;
  emaSlopePct: number | null;
  allowEntry: boolean;
  entryGateReason: string | null;
  volOk: boolean;
  oversoldNow: boolean;
  wasOversold: boolean;
  recoveryOk: boolean;
  belowVwap: boolean;
  bullishRegime: boolean;
  emaSlopeUp: boolean;
  cooldownRemainingMin: number | null;

  // In-position (when entry price/time present)
  pnlPct: number | null;
  holdMinutes: number | null;
  stopLossHit: boolean;
  profitTargetHit: boolean;
  trailingStopHit: boolean;
  rsiExitHit: boolean;
  reversionExitHit: boolean;
  timeExitHit: boolean;
  regimeExitHit: boolean;
}

export interface SolanaBotV1CoreDetailedResult extends SolanaBotV1CoreResult {
  diagnostics: SolanaBotV1CoreDiagnostics;
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
 * SolanaBotV1 core decision logic.
 * Designed to be used by both live bot and backtests.
 */
export function evaluateSolanaBotV1CoreDetailed(
  inputs: SolanaBotV1CoreInputs,
  position: SolanaBotV1Position,
  cfg: SolanaBotV1Config,
): SolanaBotV1CoreDetailedResult {
  const s = cfg.solanaBotV1.strategy;
  const mode = s.mode ?? 'mean_reversion';
  const { price, nowMs, rsi, prevRsi, vwap, atrPercent, ema, prevEma, htfEma, prevHtfEma } = inputs;

  if (rsi === null || vwap === null) {
    return {
      action: 'hold',
      reason: 'Waiting for indicators',
      diagnostics: {
        mode,
        deviationPct: 0,
        requiredDevPct: s.entry.minDeviationPct,
        profitTargetPct: s.exit.profitTargetPct,
        stopLossPct: s.exit.stopLossPct,
        rsiDirection: 'flat',
        emaTrendPct: null,
        emaSlopePct: null,
        allowEntry: true,
        entryGateReason: null,
        volOk: atrPercent === null ? true : atrPercent <= 8.0,
        oversoldNow: false,
        wasOversold: false,
        recoveryOk: false,
        belowVwap: false,
        bullishRegime: true,
        emaSlopeUp: true,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  if (position.cooldownUntil && nowMs < position.cooldownUntil) {
    const remaining = Math.max(0, Math.round((position.cooldownUntil - nowMs) / 60000));
    const deviationPct = pct(price, vwap);
    const dir = rsiDir(rsi, prevRsi);
    return {
      action: 'hold',
      reason: `Cooldown: ${remaining}min`,
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct: s.entry.minDeviationPct,
        profitTargetPct: s.exit.profitTargetPct,
        stopLossPct: s.exit.stopLossPct,
        rsiDirection: dir,
        emaTrendPct: ema !== null ? pct(price, ema) : null,
        emaSlopePct: ema !== null && prevEma !== null ? pct(ema, prevEma) : null,
        allowEntry: false,
        entryGateReason: 'Cooldown',
        volOk: atrPercent === null ? true : atrPercent <= 8.0,
        oversoldNow: rsi < s.rsi.oversold,
        wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
        recoveryOk: false,
        belowVwap: false,
        bullishRegime: true,
        emaSlopeUp: true,
        cooldownRemainingMin: remaining,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
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
      return {
        action: 'hold',
        reason: 'Regime switch: waiting for HTF EMA',
        diagnostics: {
          mode,
          deviationPct,
          requiredDevPct,
          profitTargetPct,
          stopLossPct,
          rsiDirection: dir,
          emaTrendPct,
          emaSlopePct,
          allowEntry: false,
          entryGateReason: 'Regime switch: waiting for HTF EMA',
          volOk: atrPercent === null ? true : atrPercent <= 8.0,
          oversoldNow: rsi < s.rsi.oversold,
          wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
          recoveryOk: false,
          belowVwap: deviationPct <= -requiredDevPct,
          bullishRegime: true,
          emaSlopeUp: true,
          cooldownRemainingMin: null,
          pnlPct: null,
          holdMinutes: null,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }

    const trendPct = pct(price, htfEma);
    const slopeUp = prevHtfEma !== null ? (htfEma >= prevHtfEma) : true;
    const entryBuf = rf.entryBufferPct ?? 0;
    const exitBuf = rf.exitBufferPct ?? 0;

    if (!position.inPosition) {
      if (rf.requireAboveEma && trendPct < entryBuf) {
        return {
          action: 'hold',
          reason: `Regime: below EMA (${trendPct.toFixed(1)}%)`,
          diagnostics: {
            mode,
            deviationPct,
            requiredDevPct,
            profitTargetPct,
            stopLossPct,
            rsiDirection: dir,
            emaTrendPct,
            emaSlopePct,
            allowEntry: false,
            entryGateReason: `Regime below EMA (${trendPct.toFixed(1)}%)`,
            volOk: atrPercent === null ? true : atrPercent <= 8.0,
            oversoldNow: rsi < s.rsi.oversold,
            wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
            recoveryOk: false,
            belowVwap: deviationPct <= -requiredDevPct,
            bullishRegime: trendPct >= 0,
            emaSlopeUp: slopeUp,
            cooldownRemainingMin: null,
            pnlPct: null,
            holdMinutes: null,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: false,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
      if (rf.requireEmaSlopeUp && !slopeUp) {
        return {
          action: 'hold',
          reason: 'Regime: EMA slope down',
          diagnostics: {
            mode,
            deviationPct,
            requiredDevPct,
            profitTargetPct,
            stopLossPct,
            rsiDirection: dir,
            emaTrendPct,
            emaSlopePct,
            allowEntry: false,
            entryGateReason: 'Regime EMA slope down',
            volOk: atrPercent === null ? true : atrPercent <= 8.0,
            oversoldNow: rsi < s.rsi.oversold,
            wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
            recoveryOk: false,
            belowVwap: deviationPct <= -requiredDevPct,
            bullishRegime: trendPct >= 0,
            emaSlopeUp: slopeUp,
            cooldownRemainingMin: null,
            pnlPct: null,
            holdMinutes: null,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: false,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
      return {
        action: 'buy',
        reason: `Regime buy: ${trendPct.toFixed(1)}% above EMA`,
        diagnostics: {
          mode,
          deviationPct,
          requiredDevPct,
          profitTargetPct,
          stopLossPct,
          rsiDirection: dir,
          emaTrendPct,
          emaSlopePct,
          allowEntry: true,
          entryGateReason: null,
          volOk: atrPercent === null ? true : atrPercent <= 8.0,
          oversoldNow: rsi < s.rsi.oversold,
          wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
          recoveryOk: false,
          belowVwap: deviationPct <= -requiredDevPct,
          bullishRegime: trendPct >= 0,
          emaSlopeUp: slopeUp,
          cooldownRemainingMin: null,
          pnlPct: null,
          holdMinutes: null,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }

    // in position
    if (rf.requireAboveEma && trendPct < -exitBuf) {
      return {
        action: 'sell',
        reason: `Regime sell: ${trendPct.toFixed(1)}% below EMA`,
        diagnostics: {
          mode,
          deviationPct,
          requiredDevPct,
          profitTargetPct,
          stopLossPct,
          rsiDirection: dir,
          emaTrendPct,
          emaSlopePct,
          allowEntry: true,
          entryGateReason: null,
          volOk: atrPercent === null ? true : atrPercent <= 8.0,
          oversoldNow: rsi < s.rsi.oversold,
          wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
          recoveryOk: false,
          belowVwap: deviationPct <= -requiredDevPct,
          bullishRegime: trendPct >= 0,
          emaSlopeUp: slopeUp,
          cooldownRemainingMin: null,
          pnlPct: null,
          holdMinutes: null,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: true,
        },
      };
    }

    return {
      action: 'hold',
      reason: `Regime hold: ${trendPct.toFixed(1)}% above EMA`,
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct,
        profitTargetPct,
        stopLossPct,
        rsiDirection: dir,
        emaTrendPct,
        emaSlopePct,
        allowEntry: false,
        entryGateReason: null,
        volOk: atrPercent === null ? true : atrPercent <= 8.0,
        oversoldNow: rsi < s.rsi.oversold,
        wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
        recoveryOk: false,
        belowVwap: deviationPct <= -requiredDevPct,
        bullishRegime: trendPct >= 0,
        emaSlopeUp: slopeUp,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  if (position.inPosition && position.entryPrice && position.entryTime) {
    const pnlPct = pct(price, position.entryPrice);
    const holdMinutes = (nowMs - position.entryTime) / 60000;

    const inPosDiagnosticsBase = {
      mode,
      deviationPct,
      requiredDevPct,
      profitTargetPct,
      stopLossPct,
      rsiDirection: dir,
      emaTrendPct,
      emaSlopePct,
      allowEntry,
      entryGateReason,
      volOk: atrPercent === null ? true : atrPercent <= 8.0,
      oversoldNow: rsi < s.rsi.oversold,
      wasOversold: prevRsi !== null && prevRsi < s.rsi.oversold,
      recoveryOk: false,
      belowVwap: deviationPct <= -requiredDevPct,
      bullishRegime: emaTrendPct === null ? true : emaTrendPct >= 0,
      emaSlopeUp: emaSlopePct === null ? true : emaSlopePct >= 0,
      cooldownRemainingMin: null,
      pnlPct,
      holdMinutes,
    };

    // Regime exit: if we drift deep below EMA, exit to avoid grinding drawdowns.
    if (s.trendFilter.enabled && emaTrendPct !== null && emaTrendPct < s.trendFilter.disableBelowPct) {
      return {
        action: 'sell',
        reason: `Regime exit: ${emaTrendPct.toFixed(1)}% below EMA`,
        diagnostics: {
          ...inPosDiagnosticsBase,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: true,
        },
      };
    }

    // Note: we do not force exits on regime flips; it only gates new entries.

    // Hard risk exits
    if (pnlPct <= -stopLossPct) {
      return {
        action: 'sell',
        reason: `Stop loss: ${pnlPct.toFixed(2)}%`,
        diagnostics: {
          ...inPosDiagnosticsBase,
          stopLossHit: true,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }
    if (position.trailingActive && position.trailingPrice && price <= position.trailingPrice) {
      return {
        action: 'sell',
        reason: 'Trailing stop hit',
        diagnostics: {
          ...inPosDiagnosticsBase,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: true,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }

    // Profit-taking (disabled in trend mode to allow big winners)
    if (mode !== 'trend') {
      if (pnlPct >= profitTargetPct) {
        return {
          action: 'sell',
          reason: `Profit target: ${pnlPct.toFixed(2)}%`,
          diagnostics: {
            ...inPosDiagnosticsBase,
            stopLossHit: false,
            profitTargetHit: true,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: false,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
    }

    if (mode === 'trend') {
      // Trend exit: regime break (price below EMA).
      if (emaTrendPct !== null && emaTrendPct < 0) {
        return {
          action: 'sell',
          reason: `Trend exit: below EMA (${emaTrendPct.toFixed(1)}%)`,
          diagnostics: {
            ...inPosDiagnosticsBase,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: false,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
    } else {
      // MR / pullback exits
      // Only take the VWAP reversion exit once some profit is present;
      // otherwise let profit target / trailing do the work.
      const reversionOk = deviationPct >= -Math.max(0.1, s.entry.minDeviationPct * 0.25);
      if (reversionOk && pnlPct >= Math.max(0.4, profitTargetPct * 0.5)) {
        return {
          action: 'sell',
          reason: `Reversion: dev=${deviationPct.toFixed(2)}% at +${pnlPct.toFixed(2)}%`,
          diagnostics: {
            ...inPosDiagnosticsBase,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: true,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
      if (rsi > s.rsi.exitOverbought && dir === 'falling') {
        return {
          action: 'sell',
          reason: `RSI exit: ${rsi.toFixed(1)}`,
          diagnostics: {
            ...inPosDiagnosticsBase,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: true,
            reversionExitHit: false,
            timeExitHit: false,
            regimeExitHit: false,
          },
        };
      }
    }

    // Time-based exit to avoid stagnation (not for trend mode)
    if (mode !== 'trend') {
      if (holdMinutes > s.exit.maxHoldMinutes && pnlPct > 0) {
        return {
          action: 'sell',
          reason: `Time exit: ${holdMinutes.toFixed(0)}min at +${pnlPct.toFixed(2)}%`,
          diagnostics: {
            ...inPosDiagnosticsBase,
            stopLossHit: false,
            profitTargetHit: false,
            trailingStopHit: false,
            rsiExitHit: false,
            reversionExitHit: false,
            timeExitHit: true,
            regimeExitHit: false,
          },
        };
      }
    }

    // Volatility exit: if ATR spikes and we haven't reverted, reduce churn by waiting.
    if (atrPercent !== null && atrPercent > 6.0) {
      return {
        action: 'hold',
        reason: `High vol: ATR ${atrPercent.toFixed(1)}%`,
        diagnostics: {
          ...inPosDiagnosticsBase,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }

    return {
      action: 'hold',
      reason: `Holding: ${pnlPct.toFixed(2)}%`,
      diagnostics: {
        ...inPosDiagnosticsBase,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  // Volatility gate: avoid entries in extreme volatility spikes.
  const volOk = atrPercent === null ? true : atrPercent <= 8.0;

  const oversoldNow = rsi < s.rsi.oversold;
  const wasOversold = prevRsi !== null && prevRsi < s.rsi.oversold;
  const belowVwap = deviationPct <= -requiredDevPct;
  const bullishRegime = emaTrendPct === null ? true : emaTrendPct >= 0;
  const emaSlopeUp = emaSlopePct === null ? true : emaSlopePct >= 0;

  if (!allowEntry) {
    const recoveryOkLocal = oversoldNow || (wasOversold && rsi >= s.rsi.exitOversold);
    return {
      action: 'hold',
      reason: entryGateReason ?? 'Entry gated',
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct,
        profitTargetPct,
        stopLossPct,
        rsiDirection: dir,
        emaTrendPct,
        emaSlopePct,
        allowEntry,
        entryGateReason,
        volOk,
        oversoldNow,
        wasOversold,
        recoveryOk: recoveryOkLocal,
        belowVwap,
        bullishRegime,
        emaSlopeUp,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  if (mode === 'trend') {
    // Trend-following:
    // - Enter when price is above EMA and EMA slope is up.
    // - Exit handled in-position on EMA break.
    if (bullishRegime && emaSlopeUp && volOk) {
      return {
        action: 'buy',
        reason: `Trend entry: EMA=${emaTrendPct?.toFixed(1) ?? 'n/a'}%`,
        diagnostics: {
          mode,
          deviationPct,
          requiredDevPct,
          profitTargetPct,
          stopLossPct,
          rsiDirection: dir,
          emaTrendPct,
          emaSlopePct,
          allowEntry,
          entryGateReason,
          volOk,
          oversoldNow,
          wasOversold,
          recoveryOk: false,
          belowVwap,
          bullishRegime,
          emaSlopeUp,
          cooldownRemainingMin: null,
          pnlPct: null,
          holdMinutes: null,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }

    return {
      action: 'hold',
      reason: 'No entry signal',
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct,
        profitTargetPct,
        stopLossPct,
        rsiDirection: dir,
        emaTrendPct,
        emaSlopePct,
        allowEntry,
        entryGateReason,
        volOk,
        oversoldNow,
        wasOversold,
        recoveryOk: false,
        belowVwap,
        bullishRegime,
        emaSlopeUp,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  if (mode === 'trend_pullback') {
    // Buy dips in an uptrend.
    const recoveryOk = oversoldNow || (wasOversold && rsi >= s.rsi.exitOversold);
    if (bullishRegime && emaSlopeUp && belowVwap && recoveryOk && volOk) {
      return {
        action: 'buy',
        reason: `Pullback entry: RSI=${rsi.toFixed(1)} (${dir}), dev=${deviationPct.toFixed(2)}%`,
        diagnostics: {
          mode,
          deviationPct,
          requiredDevPct,
          profitTargetPct,
          stopLossPct,
          rsiDirection: dir,
          emaTrendPct,
          emaSlopePct,
          allowEntry,
          entryGateReason,
          volOk,
          oversoldNow,
          wasOversold,
          recoveryOk,
          belowVwap,
          bullishRegime,
          emaSlopeUp,
          cooldownRemainingMin: null,
          pnlPct: null,
          holdMinutes: null,
          stopLossHit: false,
          profitTargetHit: false,
          trailingStopHit: false,
          rsiExitHit: false,
          reversionExitHit: false,
          timeExitHit: false,
          regimeExitHit: false,
        },
      };
    }
    return {
      action: 'hold',
      reason: 'No entry signal',
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct,
        profitTargetPct,
        stopLossPct,
        rsiDirection: dir,
        emaTrendPct,
        emaSlopePct,
        allowEntry,
        entryGateReason,
        volOk,
        oversoldNow,
        wasOversold,
        recoveryOk,
        belowVwap,
        bullishRegime,
        emaSlopeUp,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  // mean_reversion
  const recoveryOk = oversoldNow || (wasOversold && rsi >= s.rsi.exitOversold);
  if (belowVwap && recoveryOk && volOk) {
    return {
      action: 'buy',
      reason: `MR entry: RSI=${rsi.toFixed(1)} (${dir}), dev=${deviationPct.toFixed(2)}%`,
      diagnostics: {
        mode,
        deviationPct,
        requiredDevPct,
        profitTargetPct,
        stopLossPct,
        rsiDirection: dir,
        emaTrendPct,
        emaSlopePct,
        allowEntry,
        entryGateReason,
        volOk,
        oversoldNow,
        wasOversold,
        recoveryOk,
        belowVwap,
        bullishRegime,
        emaSlopeUp,
        cooldownRemainingMin: null,
        pnlPct: null,
        holdMinutes: null,
        stopLossHit: false,
        profitTargetHit: false,
        trailingStopHit: false,
        rsiExitHit: false,
        reversionExitHit: false,
        timeExitHit: false,
        regimeExitHit: false,
      },
    };
  }

  return {
    action: 'hold',
    reason: 'No entry signal',
    diagnostics: {
      mode,
      deviationPct,
      requiredDevPct,
      profitTargetPct,
      stopLossPct,
      rsiDirection: dir,
      emaTrendPct,
      emaSlopePct,
      allowEntry,
      entryGateReason,
      volOk,
      oversoldNow,
      wasOversold,
      recoveryOk,
      belowVwap,
      bullishRegime,
      emaSlopeUp,
      cooldownRemainingMin: null,
      pnlPct: null,
      holdMinutes: null,
      stopLossHit: false,
      profitTargetHit: false,
      trailingStopHit: false,
      rsiExitHit: false,
      reversionExitHit: false,
      timeExitHit: false,
      regimeExitHit: false,
    },
  };
}

export function evaluateSolanaBotV1Core(
  inputs: SolanaBotV1CoreInputs,
  position: SolanaBotV1Position,
  cfg: SolanaBotV1Config,
): SolanaBotV1CoreResult {
  const res = evaluateSolanaBotV1CoreDetailed(inputs, position, cfg);
  return { action: res.action, reason: res.reason };
}
