import { BotConfig, PositionState, StrategySignal, TradeRecord } from './types';
import { fetchCandles, fetchSpotPrice } from './priceFeed';
import { getLatestIndicators } from './indicators';
import { evaluateStrategy, updateTrailingStop, buildInitialPosition } from './strategy';
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

    // Load persisted position state or start fresh
    this.position = this.logger.loadState<PositionState>('position') ?? buildInitialPosition();
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

    // ── 4. Circuit breaker check ────────────────────────────────────────────
    const balances = await this.walletManager.getBalances(spotPrice);

    // In dry-run on devnet, substitute the configured starting capital so the
    // full trade cycle can be exercised without needing real devnet USDC.
    const simulated = this.dryRun && this.cfg.network.useDevnet;
    const availableUSDC = simulated
      ? this.cfg.capital.startingCapitalUSDC
      : balances.usdcBalance;

    console.log(`[Bot] Wallet — SOL: ${balances.solBalance.toFixed(4)} | USDC: ${balances.usdcBalance.toFixed(2)}${simulated ? ` (sim $${availableUSDC})` : ''} | Total: $${balances.totalValueUSDC.toFixed(2)}`);
    this.logger.saveState('balances', { ...balances, updatedAt: now });

    // ── Gas reserve check ────────────────────────────────────────────────────
    // Gas buffer = total SOL in wallet minus the SOL the bot holds as a position.
    // Only the gas buffer should cover transaction fees; position SOL gets sold normally.
    const minGas = this.cfg.capital.minSolReserveForGas;
    const gasBuffer = balances.solBalance - this.position.solBalance;
    if (!simulated && gasBuffer < minGas) {
      const msg = `⚠️ Low gas warning! Gas buffer ${gasBuffer.toFixed(4)} SOL is below minimum ${minGas} SOL — trading paused until topped up`;
      console.warn(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
      return;
    }

    // Circuit breaker compares real portfolio value against startingCapitalUSDC.
    // Skip it in dry-run devnet mode — the real wallet balance is irrelevant there.
    if (!simulated && this.walletManager.isCircuitBreakerTripped(balances.totalValueUSDC, this.cfg)) {
      this.circuitBreakerTripped = true;
      const msg = `Circuit breaker triggered! Portfolio value $${balances.totalValueUSDC.toFixed(2)} exceeds ${this.cfg.strategy.risk.circuitBreakerDrawdownPct}% drawdown`;
      console.error(`[Bot] ${msg}`);
      await this.notifier.sendAlert(msg);
      return;
    }

    // ── 5. Evaluate strategy ────────────────────────────────────────────────
    const signal: StrategySignal = evaluateStrategy(
      spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      this.position,
      this.cfg,
      now,
    );

    console.log(`[Bot] Signal: ${signal.action.toUpperCase()} — ${signal.reason}`);
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

    // ── 6. Execute signal ───────────────────────────────────────────────────
    switch (signal.action) {
      case 'buy_tier1':
        await this.executeBuy(1, availableUSDC, signal, spotPrice);
        break;
      case 'buy_tier2':
        await this.executeBuy(2, availableUSDC, signal, spotPrice);
        break;
      case 'buy_tier3':
        await this.executeBuy(3, availableUSDC, signal, spotPrice);
        break;
      case 'sell_half':
        await this.executeSellHalf(signal, spotPrice);
        break;
      case 'sell_all':
        await this.executeSellAll(signal, spotPrice);
        break;
      case 'hold':
      default:
        break;
    }

    // ── 7. Persist state ────────────────────────────────────────────────────
    this.logger.saveState('position', this.position);
  }

  private async executeBuy(
    tier: 1 | 2 | 3,
    availableUSDC: number,
    signal: StrategySignal,
    price: number,
  ): Promise<void> {
    const allocs = this.walletManager.computeTierAllocations(availableUSDC, this.cfg, this.position);
    const usdcToSpend = tier === 1 ? allocs.tier1 : tier === 2 ? allocs.tier2 : allocs.tier3;

    if (usdcToSpend <= 0) {
      console.warn(`[Bot] Tier ${tier} — no USDC available to spend`);
      return;
    }

    console.log(`[Bot] Buying SOL with $${usdcToSpend.toFixed(2)} USDC (Tier ${tier})${this.dryRun ? ' [DRY RUN]' : ''}`);
    const result = await this.executor.buySol(usdcToSpend, this.dryRun, price);

    if (!result.success) {
      console.error(`[Bot] Buy failed: ${result.error}`);
      return;
    }

    // Update position state — use actual execution price from swap, not the
    // pre-slippage market price, so avg entry and stop-loss are accurate.
    const execPrice = result.price;
    const prevSol = this.position.solBalance;
    const newSol = prevSol + result.outputAmount;
    const prevAvg = this.position.averageEntryPrice;
    const newAvg =
      prevSol === 0
        ? execPrice
        : (prevAvg * prevSol + execPrice * result.outputAmount) / newSol;

    const tiers = { ...this.position.tiers };
    if (tier === 1) {
      tiers.tier1Filled = true;
      tiers.tier1EntryPrice = execPrice;
      tiers.tier1Amount = usdcToSpend;
    } else if (tier === 2) {
      tiers.tier2Filled = true;
      tiers.tier2EntryPrice = execPrice;
      tiers.tier2Amount = usdcToSpend;
    } else {
      tiers.tier3Filled = true;
      tiers.tier3EntryPrice = execPrice;
      tiers.tier3Amount = usdcToSpend;
    }

    this.position = {
      ...this.position,
      inPosition: true,
      solBalance: newSol,
      averageEntryPrice: newAvg,
      highWaterMark: Math.max(this.position.highWaterMark, price),
      tiers,
    };
    this.logger.saveState('position', this.position);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      action: `buy_tier${tier}`,
      side: 'buy',
      solAmount: result.outputAmount,
      usdcAmount: usdcToSpend,
      price,
      tier,
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

  private async executeSellHalf(signal: StrategySignal, price: number): Promise<void> {
    const halfSol = this.position.solBalance / 2;
    if (halfSol <= 0) return;

    console.log(`[Bot] Selling 50% of SOL position (${halfSol.toFixed(4)} SOL)${this.dryRun ? ' [DRY RUN]' : ''}`);
    const result = await this.executor.sellSol(halfSol, this.dryRun, price);

    if (!result.success) {
      console.error(`[Bot] Sell-half failed: ${result.error}`);
      return;
    }

    const pnl = this.calculatePnl(halfSol, result.outputAmount);
    this.position = {
      ...this.position,
      solBalance: this.position.solBalance - halfSol,
      partialExitDone: true,
    };
    this.logger.saveState('position', this.position);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      action: 'sell_half',
      side: 'sell',
      solAmount: halfSol,
      usdcAmount: result.outputAmount,
      price,
      tier: null,
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

  private async executeSellAll(signal: StrategySignal, price: number): Promise<void> {
    const solToSell = this.position.solBalance;
    if (solToSell <= 0) return;

    console.log(`[Bot] Selling entire SOL position (${solToSell.toFixed(4)} SOL)${this.dryRun ? ' [DRY RUN]' : ''}`);
    const result = await this.executor.sellSol(solToSell, this.dryRun, price);

    if (!result.success) {
      console.error(`[Bot] Sell-all failed: ${result.error}`);
      return;
    }

    const pnl = this.calculatePnl(solToSell, result.outputAmount);

    // Apply cooldown
    const cooldownMs = this.cfg.strategy.cooldown.candlesAfterExit *
      this.cfg.strategy.cooldown.candleDurationMinutes * 60 * 1000;
    const cooldownUntil = Date.now() + cooldownMs;

    // Reset position
    this.position = { ...buildInitialPosition(), cooldownUntil };
    this.logger.saveState('position', this.position);

    const trade: TradeRecord = {
      timestamp: Date.now(),
      action: 'sell_all',
      side: 'sell',
      solAmount: solToSell,
      usdcAmount: result.outputAmount,
      price,
      tier: null,
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
    console.log(`[Bot] Cooldown until ${new Date(cooldownUntil).toISOString()}`);
  }

  private calculatePnl(solAmount: number, usdcReceived: number): number {
    const costBasis = solAmount * this.position.averageEntryPrice;
    return usdcReceived - costBasis;
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    console.log('[Bot] Circuit breaker manually reset');
  }

  /**
   * Force a full buy_tier1 → sell_all cycle using live quotes.
   * Only callable when dryRun=true. Used to smoke-test the trade path
   * without waiting for real strategy signals.
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
      action: 'buy_tier1',
      reason: 'test-cycle forced buy',
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: 'neutral',
    };

    console.log('[Bot] Step 1/2 — forcing buy_tier1...');
    await this.executeBuy(1, availableUSDC, buySignal, spotPrice);

    const sellSignal: StrategySignal = {
      action: 'sell_all',
      reason: 'test-cycle forced sell',
      price: spotPrice,
      rsi4h,
      vwap4h,
      sma3d,
      trendBias: 'neutral',
    };

    console.log('[Bot] Step 2/2 — forcing sell_all...');
    await this.executeSellAll(sellSignal, spotPrice);

    console.log('[Bot] ══ TEST CYCLE COMPLETE ══\n');
  }
}
