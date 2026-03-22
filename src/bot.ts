import { BotConfig, PositionState, StrategySignal, TradeRecord } from './types';
import { fetchCandles, fetchSpotPrice } from './priceFeed';
import { getLatestIndicators } from './indicators';
import { evaluateStrategy, updateTrailingStop, buildInitialPosition, migratePosition } from './strategy';
import { TradeExecutor } from './executor';
import { WalletManager } from './walletManager';
import { TradeLogger } from './logger';
import { Notifier } from './notifications';

export class TradingBot {
  private cfg: BotConfig;
  private executor: TradeExecutor;
  private walletManager: WalletManager;
  private logger: TradeLogger;
  private notifier: Notifier;
  private dryRun: boolean;
  private position: PositionState;
  private portfolioHWM: number = 0;  // all-time high portfolio value — drives circuit breaker
  private circuitBreakerTripped: boolean = false;
  private lastBootstrapAttemptMs: number = 0;
  private static readonly BOOTSTRAP_RETRY_COOLDOWN_MS = 5 * 60 * 1000; // 5 min between retries

  private static tfToMs(tf: string): number {
    const map: Record<string, number> = {
      '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '3d': 259_200_000,
    };
    return map[tf] ?? 14_400_000; // default 4h
  }

  constructor(
    cfg: BotConfig,
    executor: TradeExecutor,
    walletManager: WalletManager,
    logger: TradeLogger,
    notifier: Notifier,
    dryRun: boolean,
  ) {
    this.cfg = cfg;
    this.executor = executor;
    this.walletManager = walletManager;
    this.logger = logger;
    this.notifier = notifier;
    this.dryRun = dryRun;

    // Load persisted position, migrating from any previous format automatically
    const rawPosition = this.logger.loadState<Record<string, unknown>>('position');
    this.position = rawPosition ? migratePosition(rawPosition) : buildInitialPosition();

    // Load portfolio high-water mark — falls back to configured starting capital
    // so the circuit breaker is calibrated correctly from day one
    this.portfolioHWM = this.logger.loadState<number>('portfolioHWM')
      ?? this.cfg.capital.startingCapitalUSDC;
  }

  async tick(): Promise<void> {
    const now = Date.now();
    console.log(`\n[Bot] ── Tick at ${new Date(now).toISOString()} ──`);

    if (this.circuitBreakerTripped) {
      console.warn('[Bot] Circuit breaker is active — all trading halted');
      await this.notifier.sendAlert('Circuit breaker active — trading halted');
      return;
    }

    // ── alignToCandle pre-check ─────────────────────────────────────────────
    // If enabled, only run the full strategy when a new 4h candle has closed
    // since the last execution. This prevents redundant ticks seeing identical
    // indicator data and makes zoneConfirmationCandles mean actual candle closes.
    if (this.cfg.scheduler.alignToCandle && this.position.lastExecutedCandleTs !== null) {
      const tfMs = TradingBot.tfToMs(this.cfg.timeframes.executionTf);
      const nextExpectedMs = this.position.lastExecutedCandleTs + tfMs;
      if (now < nextExpectedMs) {
        console.log(`[Bot] alignToCandle — no new ${this.cfg.timeframes.executionTf} candle expected until ${new Date(nextExpectedMs).toISOString()} — skipping`);
        return;
      }
    }

    // ── 1. Fetch market data ────────────────────────────────────────────────
    const birdeyeKey = process.env.BIRDEYE_API_KEY ?? '';
    const [candles4h, candles3d, spotPrice] = await Promise.all([
      fetchCandles('4h', 100, birdeyeKey),
      fetchCandles('3d', 60, birdeyeKey),
      fetchSpotPrice(),
    ]);

    console.log(`[Bot] Spot price: $${spotPrice.toFixed(4)} | 4h candles: ${candles4h.length} | 3d candles: ${candles3d.length}`);

    // ── 2. Compute indicators (includes RSI direction) ──────────────────────
    const { rsi4h, vwap4h, sma3d, rsiDirection } = getLatestIndicators(
      candles4h,
      candles3d,
      this.cfg.strategy.rsi.period,
      this.cfg.strategy.sma.period,
    );

    console.log(`[Bot] RSI(4h): ${rsi4h?.toFixed(2) ?? 'N/A'} (${rsiDirection}) | VWAP(4h): ${vwap4h?.toFixed(4) ?? 'N/A'} | SMA50(3d): ${sma3d?.toFixed(4) ?? 'N/A'}`);

    // ── 3. Update trailing stop ─────────────────────────────────────────────
    this.position = updateTrailingStop(this.position, spotPrice, this.cfg);

    // ── 4. Fetch balances & circuit breaker ────────────────────────────────
    const balances = await this.walletManager.getBalances(spotPrice);

    const simulated = this.dryRun && this.cfg.network.useDevnet;
    const availableUSDC = simulated
      ? this.cfg.capital.startingCapitalUSDC
      : balances.usdcBalance;

    // Update portfolio high-water mark — persists across restarts so the circuit
    // breaker always measures drawdown from the true peak, not a static config value.
    // Adding funds naturally raises the HWM on the next tick, recalibrating CB automatically.
    if (!simulated && balances.totalValueUSDC > this.portfolioHWM) {
      this.portfolioHWM = balances.totalValueUSDC;
      this.logger.saveState('portfolioHWM', this.portfolioHWM);
    }

    console.log(`[Bot] Wallet — SOL: ${balances.solBalance.toFixed(4)} | USDC: ${balances.usdcBalance.toFixed(2)}${simulated ? ` (sim $${availableUSDC})` : ''} | Total: $${balances.totalValueUSDC.toFixed(2)} | Peak: $${this.portfolioHWM.toFixed(2)}`);
    this.logger.saveState('balances', { ...balances, updatedAt: now });

    // ── 5. Position reconciliation ─────────────────────────────────────────
    // Compare what the bot thinks it holds against the actual wallet balance.
    // If discrepancy > 5% AND > 0.01 SOL, adjust downward to reality.
    // Only correct downward (tracked > actual) to avoid inflating position on gas top-ups.
    if (this.position.bootstrapDone && !simulated && this.position.solBalance > 0) {
      const maxManagedSol = Math.max(0, balances.solBalance - this.cfg.capital.minSolReserveForGas);
      const trackedSol = this.position.solBalance;
      const solDrift = trackedSol - maxManagedSol;

      if (solDrift > 0.01 && (solDrift / trackedSol) > 0.05) {
        const driftPct = (solDrift / trackedSol * 100).toFixed(1);
        const msg = `Position reconciled: tracked ${trackedSol.toFixed(4)} SOL, actual ${maxManagedSol.toFixed(4)} SOL (${driftPct}% drift) — adjusting`;
        console.warn(`[Bot] ${msg}`);
        await this.notifier.sendAlert(msg);
        this.position = { ...this.position, solBalance: maxManagedSol };
        this.logger.saveState('position', this.position);
      }
    }

    // Gas reserve check
    const minGas = this.cfg.capital.minSolReserveForGas;
    const gasBuffer = balances.solBalance - this.position.solBalance;
    const lowGas = !simulated && gasBuffer < minGas;
    if (lowGas) {
      const msg = `⚠️ Low gas warning! Gas buffer ${gasBuffer.toFixed(4)} SOL < minimum ${minGas} SOL — new buys paused`;
      console.warn(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
    }

    if (!simulated && this.walletManager.isCircuitBreakerTripped(balances.totalValueUSDC, this.portfolioHWM, this.cfg)) {
      this.circuitBreakerTripped = true;
      const msg = `Circuit breaker triggered! Portfolio $${balances.totalValueUSDC.toFixed(2)} exceeds ${this.cfg.strategy.risk.circuitBreakerDrawdownPct}% drawdown`;
      console.error(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
      return;
    }

    // ── 6. Compute current allocation ──────────────────────────────────────
    const managedSolBalance = this.position.bootstrapDone ? this.position.solBalance : 0;
    const totalManagedUSDC = managedSolBalance * spotPrice + availableUSDC;
    const currentSolPct = this.walletManager.computeCurrentSolPct(
      managedSolBalance,
      availableUSDC,
      spotPrice,
    );

    console.log(`[Bot] Allocation — SOL: ${managedSolBalance.toFixed(4)} (${currentSolPct.toFixed(1)}%) | Total managed: $${totalManagedUSDC.toFixed(2)} | Bootstrap: ${this.position.bootstrapDone ? '✓' : '✗'} | Recovery: ${this.position.requireOversoldRecovery ? '⚠️' : '✓'}`);

    // ── 7. Evaluate strategy ────────────────────────────────────────────────
    const signal: StrategySignal = evaluateStrategy(
      spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      this.position,
      this.cfg,
      now,
      currentSolPct,
      rsiDirection,
    );

    // ── 8. Apply stateful filters (zone hysteresis + recovery gate) ─────────
    // These are kept in bot.ts rather than strategy.ts to preserve strategy purity.
    let effectiveAction = signal.action;

    // Zone hysteresis: require zone to hold for N consecutive candles before executing.
    // Buys and sells have separate confirmation counts — buys use 1 (immediate entry
    // on dip signals) while sells use 2 (deliberate exit requiring a second candle).
    // Applied to rebalance signals only — bootstrap and emergency exits bypass this.
    if (effectiveAction === 'rebalance_buy' || effectiveAction === 'rebalance_sell') {
      const confirmNeeded = effectiveAction === 'rebalance_buy'
        ? this.cfg.strategy.rebalance.buyConfirmationCandles
        : this.cfg.strategy.rebalance.sellConfirmationCandles;
      if (confirmNeeded > 1) {
        const sameZone = signal.zone === this.position.pendingZone;
        const newCount = sameZone ? (this.position.pendingZoneCount ?? 0) + 1 : 1;
        this.position = { ...this.position, pendingZone: signal.zone, pendingZoneCount: newCount };

        if (newCount < confirmNeeded) {
          effectiveAction = 'hold';
          console.log(`[Bot] Zone hysteresis — ${signal.zone} (${newCount}/${confirmNeeded} candles confirmed)`);
        } else {
          console.log(`[Bot] Zone confirmed — ${signal.zone} (${newCount} candles) → proceeding`);
        }
      } else {
        // No confirmation needed — clear any stale pending state
        this.position = { ...this.position, pendingZone: null, pendingZoneCount: 0 };
      }
    } else if (effectiveAction === 'bootstrap' || effectiveAction === 'emergency_sell') {
      // Reset zone tracking on decisive actions so hysteresis starts fresh afterward
      this.position = { ...this.position, pendingZone: null, pendingZoneCount: 0 };
    } else if (effectiveAction === 'hold') {
      // If evaluateStrategy returned hold (small drift, cooldown, etc.) and the zone
      // differs from what we were tracking, reset the counter. This prevents a stale
      // count=1 from a previous zone signal firing immediately when that zone reappears.
      if (this.position.pendingZone !== null && signal.zone !== this.position.pendingZone) {
        this.position = { ...this.position, pendingZone: null, pendingZoneCount: 0 };
        console.log(`[Bot] Zone shifted to '${signal.zone}' — resetting confirmation counter`);
      }
    }

    // Oversold recovery gate: after an emergency exit, only allow re-buying when RSI
    // has reached genuinely oversold territory (moderate_buy or strong_buy zone).
    // This prevents buying back into a continuing dump on the first neutral candle.
    if (this.position.requireOversoldRecovery && effectiveAction === 'rebalance_buy') {
      if (signal.zone !== 'moderate_buy' && signal.zone !== 'strong_buy') {
        effectiveAction = 'hold';
        console.log(`[Bot] Recovery gate — zone '${signal.zone}' not oversold — waiting for moderate_buy or strong_buy`);
      } else {
        // Confirmed oversold entry — clear the gate
        this.position = { ...this.position, requireOversoldRecovery: false };
        console.log('[Bot] Recovery gate cleared — oversold zone confirmed, rebuilding position');
      }
    }

    // Persist the resolved trend bias so next tick uses it for hysteresis
    this.position = { ...this.position, lastTrendBias: signal.trendBias };

    console.log(`[Bot] Signal: ${signal.action.toUpperCase()} (${signal.zone}) → effective: ${effectiveAction.toUpperCase()} — ${signal.reason}`);
    this.logger.logSignal({
      timestamp: now,
      action: effectiveAction,
      reason: signal.reason,
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: signal.trendBias,
      executed: effectiveAction !== 'hold',
    });

    await this.notifier.sendSignalNotification(
      { ...signal, action: effectiveAction },
      this.position.bootstrapDone ? this.position.averageEntryPrice : null,
    );

    // ── 9. Execute signal ───────────────────────────────────────────────────
    switch (effectiveAction) {
      case 'bootstrap': {
        if (lowGas) { console.warn('[Bot] Skipping bootstrap — gas reserve too low'); break; }
        const now = Date.now();
        const msSinceLast = now - this.lastBootstrapAttemptMs;
        if (this.lastBootstrapAttemptMs > 0 && msSinceLast < TradingBot.BOOTSTRAP_RETRY_COOLDOWN_MS) {
          const waitSec = Math.ceil((TradingBot.BOOTSTRAP_RETRY_COOLDOWN_MS - msSinceLast) / 1000);
          console.warn(`[Bot] Bootstrap cooldown — retrying in ${waitSec}s`);
          break;
        }
        this.lastBootstrapAttemptMs = now;
        const usdcToSpend = availableUSDC * (signal.targetSolPct / 100);
        await this.executeRebalanceBuy(usdcToSpend, signal, spotPrice, true);
        break;
      }

      case 'rebalance_buy': {
        if (lowGas) { console.warn('[Bot] Skipping rebalance buy — gas reserve too low'); break; }
        const usdcToSpend = this.walletManager.computeRebalanceBuyAmount(
          currentSolPct,
          signal.targetSolPct,
          totalManagedUSDC,
          availableUSDC,
        );
        if (usdcToSpend < this.cfg.strategy.rebalance.minTradeUSDC) {
          console.log(`[Bot] Rebalance buy too small ($${usdcToSpend.toFixed(2)}) — skipping`);
          break;
        }
        await this.executeRebalanceBuy(usdcToSpend, signal, spotPrice, false);
        break;
      }

      case 'rebalance_sell': {
        const solToSell = this.walletManager.computeRebalanceSellAmount(
          currentSolPct,
          signal.targetSolPct,
          totalManagedUSDC,
          spotPrice,
          this.position.solBalance,
        );
        const minTradeSOL = spotPrice > 0 ? this.cfg.strategy.rebalance.minTradeUSDC / spotPrice : 0;
        if (solToSell < minTradeSOL) {
          console.log(`[Bot] Rebalance sell too small (${solToSell.toFixed(4)} SOL) — skipping`);
          break;
        }
        await this.executeRebalanceSell(solToSell, signal, spotPrice, balances.solBalance, false);
        break;
      }

      case 'emergency_sell': {
        const solToSell = this.walletManager.computeRebalanceSellAmount(
          currentSolPct,
          signal.targetSolPct,
          totalManagedUSDC,
          spotPrice,
          this.position.solBalance,
        );
        await this.executeRebalanceSell(solToSell, signal, spotPrice, balances.solBalance, true);
        break;
      }

      case 'hold':
      default:
        break;
    }

    // ── 10. Record candle timestamp and persist state ────────────────────────
    // Track which candle we just executed on so alignToCandle can skip redundant ticks.
    if (this.cfg.scheduler.alignToCandle && candles4h.length > 0) {
      this.position = {
        ...this.position,
        lastExecutedCandleTs: candles4h[candles4h.length - 1].timestamp,
      };
    }
    this.logger.saveState('position', this.position);
  }

  /**
   * Buy SOL with USDC and update position.
   * @param isBootstrap  True on the initial buy — sets bootstrapDone = true.
   */
  private async executeRebalanceBuy(
    usdcToSpend: number,
    signal: StrategySignal,
    price: number,
    isBootstrap: boolean,
  ): Promise<void> {
    if (usdcToSpend <= 0) {
      console.warn('[Bot] Rebalance buy — no USDC to spend');
      return;
    }

    const label = isBootstrap ? 'Bootstrap' : `Rebalance buy [${signal.zone}]`;
    console.log(`[Bot] ${label} — spending $${usdcToSpend.toFixed(2)} USDC (target ${signal.targetSolPct}% SOL)${this.dryRun ? ' [DRY RUN]' : ''}`);

    const result = await this.executor.buySol(usdcToSpend, this.dryRun, price);
    if (!result.success) {
      console.error(`[Bot] Buy failed: ${result.error}`);
      await this.notifier.sendAlert(`Buy failed: ${result.error}`);
      return;
    }

    const execPrice = result.price;
    const prevSol = this.position.solBalance;
    const newSol = prevSol + result.outputAmount;
    const newAvg = prevSol === 0
      ? execPrice
      : (prevSol * this.position.averageEntryPrice + result.outputAmount * execPrice) / newSol;

    this.position = {
      ...this.position,
      bootstrapDone: true,
      solBalance: newSol,
      averageEntryPrice: newAvg,
      highWaterMark: Math.max(this.position.highWaterMark, price),
    };
    this.logger.saveState('position', this.position);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      action: isBootstrap ? 'bootstrap' : 'rebalance_buy',
      side: 'buy',
      solAmount: result.outputAmount,
      usdcAmount: usdcToSpend,
      price,
      zone: signal.zone,
      txSignature: result.txSignature,
      dryRun: this.dryRun,
      reason: signal.reason,
      rsi: signal.rsi4h,
      vwap: signal.vwap4h,
      sma: signal.sma3d,
      trendBias: signal.trendBias,
      pnl: null,
      avgEntryAtSell: null,
    };

    this.logger.logTrade(trade);
    await this.notifier.sendTradeNotification(trade, this.dryRun);
  }

  /**
   * Sell SOL to USDC and update position.
   * @param isEmergency  True for stop loss / trailing stop — sets a cooldown,
   *                     resets trailing stop, and requires oversold recovery before re-buying.
   */
  private async executeRebalanceSell(
    solToSell: number,
    signal: StrategySignal,
    price: number,
    walletSolBalance: number,
    isEmergency: boolean,
  ): Promise<void> {
    if (solToSell <= 0) {
      console.warn('[Bot] Rebalance sell — no SOL to sell');
      return;
    }

    // Cap sell to leave gas reserve in wallet
    if (!this.dryRun) {
      const minGas = this.cfg.capital.minSolReserveForGas;
      const maxSellable = Math.max(0, walletSolBalance - minGas);
      if (solToSell > maxSellable) {
        console.warn(`[Bot] Sell capped from ${solToSell.toFixed(4)} to ${maxSellable.toFixed(4)} SOL (gas reserve)`);
        solToSell = maxSellable;
      }
    }
    if (solToSell <= 0) {
      console.warn('[Bot] Sell skipped — no SOL above gas reserve');
      return;
    }

    const label = isEmergency ? `Emergency sell [${signal.zone}]` : `Rebalance sell [${signal.zone}]`;
    console.log(`[Bot] ${label} — selling ${solToSell.toFixed(4)} SOL (target ${signal.targetSolPct}% SOL)${this.dryRun ? ' [DRY RUN]' : ''}`);

    const result = await this.executor.sellSol(solToSell, this.dryRun, price);
    if (!result.success) {
      console.error(`[Bot] Sell failed: ${result.error}`);
      await this.notifier.sendAlert(`Sell failed: ${result.error}`);
      return;
    }

    const pnl = this.calculatePnl(solToSell, result.outputAmount);
    const newSolBalance = Math.max(0, this.position.solBalance - solToSell);

    let updatedPosition: PositionState = {
      ...this.position,
      solBalance: newSolBalance,
    };

    if (isEmergency) {
      // Extended cooldown after emergency exit (3 candles = 12 hours)
      const cooldownMs = this.cfg.strategy.cooldown.candlesAfterExit
        * this.cfg.strategy.cooldown.candleDurationMinutes * 60 * 1000;
      updatedPosition = {
        ...updatedPosition,
        trailingStopActive: false,
        trailingStopPrice: null,
        highWaterMark: price,           // reset HWM — track from current price on rebuild
        cooldownUntil: Date.now() + cooldownMs,
        requireOversoldRecovery: true,  // only rebuild from genuine oversold signal
        pendingZone: null,              // reset hysteresis — start fresh on re-entry
        pendingZoneCount: 0,
      };
      const cooldownUntil = new Date(Date.now() + cooldownMs);
      console.log(`[Bot] Emergency exit — cooldown until ${cooldownUntil.toISOString()} | Recovery gate: active`);
    }

    this.position = updatedPosition;
    this.logger.saveState('position', this.position);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      action: isEmergency ? signal.zone : 'rebalance_sell',
      side: 'sell',
      solAmount: solToSell,
      usdcAmount: result.outputAmount,
      price,
      zone: signal.zone,
      txSignature: result.txSignature,
      dryRun: this.dryRun,
      reason: signal.reason,
      rsi: signal.rsi4h,
      vwap: signal.vwap4h,
      sma: signal.sma3d,
      trendBias: signal.trendBias,
      pnl,
      avgEntryAtSell: this.position.averageEntryPrice,
    };

    this.logger.logTrade(trade);
    await this.notifier.sendTradeNotification(trade, this.dryRun);
  }

  private calculatePnl(solAmount: number, usdcReceived: number): number {
    if (this.position.averageEntryPrice <= 0) return 0;
    return usdcReceived - (solAmount * this.position.averageEntryPrice);
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    console.log('[Bot] Circuit breaker manually reset');
  }

  /**
   * Force a bootstrap → sell cycle using live quotes.
   * Only callable when dryRun=true.
   */
  async runTestCycle(): Promise<void> {
    if (!this.dryRun) {
      console.error('[Bot] runTestCycle refused — only allowed in dry-run mode');
      return;
    }

    console.log('\n[Bot] ══ TEST CYCLE START ══');

    const birdeyeKey = process.env.BIRDEYE_API_KEY ?? '';
    const [candles4h, candles3d, spotPrice] = await Promise.all([
      fetchCandles('4h', 100, birdeyeKey),
      fetchCandles('3d', 60, birdeyeKey),
      fetchSpotPrice(),
    ]);

    const { rsi4h, vwap4h, sma3d, rsiDirection } = getLatestIndicators(
      candles4h,
      candles3d,
      this.cfg.strategy.rsi.period,
      this.cfg.strategy.sma.period,
    );

    console.log(`[Bot] Spot: $${spotPrice.toFixed(4)} | RSI: ${rsi4h?.toFixed(2) ?? 'N/A'} (${rsiDirection}) | VWAP: ${vwap4h?.toFixed(4) ?? 'N/A'}`);

    const availableUSDC = this.cfg.network.useDevnet
      ? this.cfg.capital.startingCapitalUSDC
      : (await this.walletManager.getBalances(spotPrice)).usdcBalance;

    const buySignal: StrategySignal = {
      action: 'bootstrap',
      reason: 'test-cycle forced bootstrap',
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: 'neutral',
      zone: 'test',
      targetSolPct: 50,
      rsiDirection,
    };

    console.log('[Bot] Step 1/2 — forcing bootstrap buy (50%)...');
    await this.executeRebalanceBuy(availableUSDC * 0.5, buySignal, spotPrice, true);

    const sellSignal: StrategySignal = {
      action: 'rebalance_sell',
      reason: 'test-cycle forced sell',
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: 'neutral',
      zone: 'test',
      targetSolPct: 0,
      rsiDirection,
    };

    console.log('[Bot] Step 2/2 — forcing full rebalance sell...');
    await this.executeRebalanceSell(
      this.position.solBalance,
      sellSignal,
      spotPrice,
      this.position.solBalance + this.cfg.capital.minSolReserveForGas,
      false,
    );

    console.log('[Bot] ══ TEST CYCLE COMPLETE ══\n');
  }
}
