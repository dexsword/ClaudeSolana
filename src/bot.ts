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
  private circuitBreakerTripped: boolean = false;

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

    // Load persisted position state, migrating from old tier-based format if needed
    const rawPosition = this.logger.loadState<Record<string, unknown>>('position');
    this.position = rawPosition ? migratePosition(rawPosition) : buildInitialPosition();
  }

  async tick(): Promise<void> {
    const now = Date.now();
    console.log(`\n[Bot] ── Tick at ${new Date(now).toISOString()} ──`);

    if (this.circuitBreakerTripped) {
      console.warn('[Bot] Circuit breaker is active — all trading halted');
      await this.notifier.sendAlert('Circuit breaker active — trading halted');
      return;
    }

    // ── 1. Fetch market data ────────────────────────────────────────────────
    const birdeyeKey = process.env.BIRDEYE_API_KEY ?? '';
    const [candles4h, candles3d, spotPrice] = await Promise.all([
      fetchCandles('4h', 100, birdeyeKey),
      fetchCandles('3d', 60, birdeyeKey),
      fetchSpotPrice(),
    ]);

    console.log(`[Bot] Spot price: $${spotPrice.toFixed(4)} | 4h candles: ${candles4h.length} | 3d candles: ${candles3d.length}`);

    // ── 2. Compute indicators ───────────────────────────────────────────────
    const { rsi4h, vwap4h, sma3d } = getLatestIndicators(
      candles4h,
      candles3d,
      this.cfg.strategy.rsi.period,
      this.cfg.strategy.sma.period,
    );

    console.log(`[Bot] RSI(4h): ${rsi4h?.toFixed(2) ?? 'N/A'} | VWAP(4h): ${vwap4h?.toFixed(4) ?? 'N/A'} | SMA50(3d): ${sma3d?.toFixed(4) ?? 'N/A'}`);

    // ── 3. Update trailing stop ─────────────────────────────────────────────
    this.position = updateTrailingStop(this.position, spotPrice, this.cfg);

    // ── 4. Fetch balances & check circuit breaker ───────────────────────────
    const balances = await this.walletManager.getBalances(spotPrice);

    const simulated = this.dryRun && this.cfg.network.useDevnet;
    const availableUSDC = simulated
      ? this.cfg.capital.startingCapitalUSDC
      : balances.usdcBalance;

    console.log(`[Bot] Wallet — SOL: ${balances.solBalance.toFixed(4)} | USDC: ${balances.usdcBalance.toFixed(2)}${simulated ? ` (sim $${availableUSDC})` : ''} | Total: $${balances.totalValueUSDC.toFixed(2)}`);
    this.logger.saveState('balances', { ...balances, updatedAt: now });

    // Gas reserve check: gas buffer = total wallet SOL minus bot-managed position SOL
    const minGas = this.cfg.capital.minSolReserveForGas;
    const gasBuffer = balances.solBalance - this.position.solBalance;
    const lowGas = !simulated && gasBuffer < minGas;
    if (lowGas) {
      const msg = `⚠️ Low gas warning! Gas buffer ${gasBuffer.toFixed(4)} SOL < minimum ${minGas} SOL — new buys paused`;
      console.warn(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
    }

    if (!simulated && this.walletManager.isCircuitBreakerTripped(balances.totalValueUSDC, this.cfg)) {
      this.circuitBreakerTripped = true;
      const msg = `Circuit breaker triggered! Portfolio $${balances.totalValueUSDC.toFixed(2)} exceeds ${this.cfg.strategy.risk.circuitBreakerDrawdownPct}% drawdown`;
      console.error(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
      return;
    }

    // ── 5. Compute current allocation ──────────────────────────────────────
    const managedSolBalance = this.position.bootstrapDone ? this.position.solBalance : 0;
    const totalManagedUSDC = managedSolBalance * spotPrice + availableUSDC;
    const currentSolPct = this.walletManager.computeCurrentSolPct(
      managedSolBalance,
      availableUSDC,
      spotPrice,
    );

    console.log(`[Bot] Allocation — Managed SOL: ${managedSolBalance.toFixed(4)} | SOL%: ${currentSolPct.toFixed(1)}% | Total managed: $${totalManagedUSDC.toFixed(2)} | Bootstrap: ${this.position.bootstrapDone ? '✓' : '✗'}`);

    // ── 6. Evaluate strategy ────────────────────────────────────────────────
    const signal: StrategySignal = evaluateStrategy(
      spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      this.position,
      this.cfg,
      now,
      currentSolPct,
    );

    console.log(`[Bot] Signal: ${signal.action.toUpperCase()} (${signal.zone}) — ${signal.reason}`);
    this.logger.logSignal({
      timestamp: now,
      action: signal.action,
      reason: signal.reason,
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: signal.trendBias,
      executed: signal.action !== 'hold',
    });

    await this.notifier.sendSignalNotification(signal);

    // ── 7. Execute signal ───────────────────────────────────────────────────
    switch (signal.action) {
      case 'bootstrap': {
        if (lowGas) { console.warn('[Bot] Skipping bootstrap — gas reserve too low'); break; }
        // Buy neutral target % (50%) of available USDC
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

    // ── 8. Persist state ────────────────────────────────────────────────────
    this.logger.saveState('position', this.position);
  }

  /**
   * Buy SOL with USDC and update position.
   * @param isBootstrap  True on the initial 50% buy — sets bootstrapDone = true.
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
    };

    this.logger.logTrade(trade);
    await this.notifier.sendTradeNotification(trade, this.dryRun);
  }

  /**
   * Sell SOL to USDC and update position.
   * @param isEmergency  True for stop loss / trailing stop — sets a brief cooldown
   *                     and resets the trailing stop state.
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
        console.warn(`[Bot] Sell capped from ${solToSell.toFixed(4)} to ${maxSellable.toFixed(4)} SOL (gas reserve protection)`);
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
      return;
    }

    const pnl = this.calculatePnl(solToSell, result.outputAmount);
    const newSolBalance = Math.max(0, this.position.solBalance - solToSell);

    let updatedPosition: PositionState = {
      ...this.position,
      solBalance: newSolBalance,
    };

    if (isEmergency) {
      // Reset trailing stop and set brief cooldown so we don't immediately re-enter
      const cooldownMs = this.cfg.strategy.cooldown.candlesAfterExit
        * this.cfg.strategy.cooldown.candleDurationMinutes * 60 * 1000;
      updatedPosition = {
        ...updatedPosition,
        trailingStopActive: false,
        trailingStopPrice: null,
        highWaterMark: price,         // reset HWM to current price for fresh tracking
        cooldownUntil: Date.now() + cooldownMs,
      };
      console.log(`[Bot] Emergency exit — cooldown until ${new Date(Date.now() + cooldownMs).toISOString()}`);
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
    };

    this.logger.logTrade(trade);
    await this.notifier.sendTradeNotification(trade, this.dryRun);
  }

  private calculatePnl(solAmount: number, usdcReceived: number): number {
    if (this.position.averageEntryPrice <= 0) return 0;
    const costBasis = solAmount * this.position.averageEntryPrice;
    return usdcReceived - costBasis;
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

    const { rsi4h, vwap4h, sma3d } = getLatestIndicators(
      candles4h,
      candles3d,
      this.cfg.strategy.rsi.period,
      this.cfg.strategy.sma.period,
    );

    console.log(`[Bot] Spot: $${spotPrice.toFixed(4)} | RSI: ${rsi4h?.toFixed(2) ?? 'N/A'} | VWAP: ${vwap4h?.toFixed(4) ?? 'N/A'} | SMA50: ${sma3d?.toFixed(4) ?? 'N/A'}`);

    const availableUSDC = this.cfg.network.useDevnet
      ? this.cfg.capital.startingCapitalUSDC
      : (await this.walletManager.getBalances(spotPrice)).usdcBalance;

    const buySignal: StrategySignal = {
      action: 'bootstrap',
      reason: 'test-cycle forced bootstrap buy',
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: 'neutral',
      zone: 'test',
      targetSolPct: 50,
    };

    console.log('[Bot] Step 1/2 — forcing bootstrap buy (50% of USDC)...');
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
