import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import cron from 'node-cron';
import fs from 'fs';
import { SolanaBotV1Config } from './typesSolanaBotV1';
import { TradeExecutor } from './executor';
import { WalletManager } from './walletManager';
import { TradeLogger } from './logger';
import { Notifier } from './notifications';
import { DiscordCommands } from './discordCommands';
import {
  evaluateSolanaBotV1Strategy,
  buildInitialSolanaBotV1Position,
  updateSolanaBotV1Position,
} from './strategySolanaBotV1';
import axios from 'axios';
import { buildNotifierFromConfig, resolveDiscordBotToken } from './notificationsBootstrap';
import type { StrategySignal } from './sharedTypes';
import { fetchRecentCryptoCompareCandlesAggregatedMinutes, fetchCryptoCompareHourlyCandlesRange } from './cryptoCompare';

const configPath = path.resolve(__dirname, '..', 'config-solana-bot-v1.json');
if (!fs.existsSync(configPath)) {
  console.error('[SolanaBotV1] config-solana-bot-v1.json not found');
  process.exit(1);
}
const cfg: SolanaBotV1Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (dryRun) console.log('[SolanaBotV1] *** DRY-RUN MODE ***');

const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
  console.error('[SolanaBotV1] WALLET_PRIVATE_KEY not set');
  process.exit(1);
}

const rpcUrl = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ccKey = process.env.CRYPTOCOMPARE_API_KEY ?? '';

const legacyDbPath = path.resolve(__dirname, '..', 'data', 'trades-bot2.db');
const defaultDbPath = path.resolve(__dirname, '..', 'data', 'trades-solana-bot-v1.db');
const dbPath = process.env.DB_PATH
  ?? (fs.existsSync(legacyDbPath) ? legacyDbPath : defaultDbPath);
const logger = new TradeLogger(dbPath);

const maxImpact = cfg.solanaBotV1.risk.maxQuotePriceImpactPct ?? Infinity;
const executor = new TradeExecutor(rpcUrl, privateKey, 0.5, maxImpact);
const walletManager = new WalletManager(rpcUrl, executor.walletAddress, false);

const notifier: Notifier = buildNotifierFromConfig(cfg.notifications);

const startTime = new Date();
const discordBotToken = resolveDiscordBotToken(cfg.notifications);
let discordCommands: DiscordCommands | null = null;

if (discordBotToken) {
  discordCommands = new DiscordCommands(
    { botToken: discordBotToken, dryRun, network: 'MAINNET', startTime, botId: 'solanaBotV1' },
    logger,
  );
  discordCommands.start().catch((err) => {
    console.warn('[Discord] Failed to start:', err.message);
  });
}

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function parseTimeframeMinutes(tf: string): number {
  const s = tf.trim().toLowerCase();
  const m = s.match(/^([0-9]+)\s*([mhd])$/);
  if (!m) return 15;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (!Number.isFinite(n) || n <= 0) return 15;
  if (unit === 'm') return n;
  if (unit === 'h') return n * 60;
  return n * 1440;
}

let position = buildInitialSolanaBotV1Position();
const persistedPosition =
  logger.loadState<typeof position>('solanaBotV1_position')
  ?? logger.loadState<typeof position>('bot2_position');
if (persistedPosition) {
  position = persistedPosition;
}

type SolanaBotV1RiskState = {
  day: string; // YYYY-MM-DD UTC
  dayStartValueUSDC: number;
  tradesToday: number;
};

let riskState: SolanaBotV1RiskState =
  logger.loadState<SolanaBotV1RiskState>('solanaBotV1_risk')
  ?? logger.loadState<SolanaBotV1RiskState>('bot2_risk')
  ?? { day: '', dayStartValueUSDC: 0, tradesToday: 0 };

type SolanaBotV1SkipStats = {
  day: string; // YYYY-MM-DD UTC
  impactSkipsToday: number;
  impactSkipsTotal: number;
  lastImpactMsg: string | null;
};

let skipStats: SolanaBotV1SkipStats =
  logger.loadState<SolanaBotV1SkipStats>('solanaBotV1_skip_stats')
  ?? logger.loadState<SolanaBotV1SkipStats>('bot2_skip_stats')
  ?? { day: '', impactSkipsToday: 0, impactSkipsTotal: 0, lastImpactMsg: null };

let tickInProgress = false;
let botState =
  logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('solanaBotV1_state')
  ?? logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('bot2_state')
  ?? { highWaterMark: 0, solBalance: 0, usdcBalance: 0 };

async function fetchPrice(): Promise<number> {
  const { data } = await axios.get('https://min-api.cryptocompare.com/data/price', {
    params: { fsym: 'SOL', tsyms: 'USD', api_key: ccKey },
  });
  return data.USD;
}

async function fetchCandles(): Promise<Candle[]> {
  const tfMinutes = parseTimeframeMinutes(cfg.solanaBotV1.timeframe);
  const baseMinutes = 15;
  const useMinutes = tfMinutes < 60 ? tfMinutes : baseMinutes;
  const factor = tfMinutes < 60
    ? (useMinutes === tfMinutes ? 1 : Math.max(1, Math.round(tfMinutes / baseMinutes)))
    : 1;

  // Need enough history for VWAP "session" (24h) + indicators + some buffer.
  const sessionCandles = Math.ceil(24 * 60 / tfMinutes);
  const lookbackCandles = Math.min(2000, Math.max(250, sessionCandles * 3 * factor));

  let candles: Candle[];
  if (tfMinutes >= 60) {
    const hours = Math.max(1, Math.round(tfMinutes / 60));
    const endMs = Date.now();
    const startMs = endMs - (lookbackCandles * tfMinutes * 60_000);
    const hourly = await fetchCryptoCompareHourlyCandlesRange({
      fsym: 'SOL',
      tsym: 'USD',
      startMs,
      endMs,
      apiKey: ccKey,
      sleepMsBetweenCalls: 350,
    });

    if (hours === 1) {
      candles = hourly;
    } else {
      const agg: Candle[] = [];
      for (let i = 0; i + hours <= hourly.length; i += hours) {
        const chunk = hourly.slice(i, i + hours);
        agg.push({
          timestamp: chunk[0].timestamp,
          open: chunk[0].open,
          high: Math.max(...chunk.map((c) => c.high)),
          low: Math.min(...chunk.map((c) => c.low)),
          close: chunk[chunk.length - 1].close,
          volume: chunk.reduce((s, c) => s + c.volume, 0),
        });
      }
      candles = agg;
    }
  } else {
    candles = await fetchRecentCryptoCompareCandlesAggregatedMinutes({
      fsym: 'SOL',
      tsym: 'USD',
      aggregateMinutes: useMinutes,
      candles: lookbackCandles,
      apiKey: ccKey,
    });
  }

  let out = candles;
  if (factor > 1) {
    const agg: Candle[] = [];
    for (let i = 0; i + factor <= candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      agg.push({
        timestamp: chunk[0].timestamp,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
      });
    }
    out = agg;
  }

  console.log(`[SolanaBotV1] Fetched ${out.length} candles (${tfMinutes}m)`);
  return out;
}

async function runTick(): Promise<void> {
  if (tickInProgress) {
    console.log('[SolanaBotV1] Tick skipped (previous tick still running)');
    return;
  }
  tickInProgress = true;

  console.log(`[SolanaBotV1] Tick at ${new Date().toISOString()}`);
  
  try {
    const price = await fetchPrice();
    console.log(`[SolanaBotV1] SOL price: $${price}`);
    
    const balances = await walletManager.getBalances(price);
    const solValue = balances.solBalance * price;
    const usdcValue = balances.usdcBalance;
    const totalValue = solValue + usdcValue;
    const solPct = totalValue > 0 ? (solValue / totalValue) * 100 : 0;

    const hasPosition = balances.solBalance > 0.1;
    const targetSolPct = cfg.solanaBotV1.strategy.position.maxPositionPct;
    const currentSolPct = totalValue > 0 ? (solValue / totalValue) * 100 : 0;
    
    // Track high water mark and save balances
    if (totalValue > botState.highWaterMark) {
      botState.highWaterMark = totalValue;
    }
    botState.solBalance = balances.solBalance;
    botState.usdcBalance = balances.usdcBalance;
    logger.saveState('solanaBotV1_state', botState);

    // Daily risk state (UTC)
    const day = new Date().toISOString().slice(0, 10);
    if (riskState.day !== day) {
      riskState = { day, dayStartValueUSDC: totalValue, tradesToday: 0 };
      logger.saveState('solanaBotV1_risk', riskState);
    }

    if (skipStats.day !== day) {
      skipStats = { ...skipStats, day, impactSkipsToday: 0, lastImpactMsg: null };
      logger.saveState('solanaBotV1_skip_stats', skipStats);
    }

    const dayPnlPct = riskState.dayStartValueUSDC > 0
      ? ((totalValue - riskState.dayStartValueUSDC) / riskState.dayStartValueUSDC) * 100
      : 0;

    const maxDailyTrades = cfg.solanaBotV1.risk.maxDailyTrades;
    const maxDailyLossPct = cfg.solanaBotV1.risk.maxDailyLossPct;
    const dailyHalt = (riskState.tradesToday >= maxDailyTrades) || (dayPnlPct <= -maxDailyLossPct);
    if (dailyHalt) {
      const reason = riskState.tradesToday >= maxDailyTrades
        ? `Daily trade limit reached (${riskState.tradesToday}/${maxDailyTrades})`
        : `Daily loss limit hit (${dayPnlPct.toFixed(2)}% <= -${maxDailyLossPct}%)`;
      console.warn(`[SolanaBotV1] ${reason} — trading halted for the day`);
      await notifier.sendAlert(`${reason} — SolanaBotV1 halting new trades until next UTC day`);
    }
    const pnlFromHigh = totalValue - botState.highWaterMark;
    console.log(`[SolanaBotV1] Wallet: ${balances.solBalance.toFixed(4)} SOL ($${solValue.toFixed(2)}) + $${usdcValue.toFixed(2)} USDC = $${totalValue.toFixed(2)} | SOL%: ${solPct.toFixed(1)}% | High: $${botState.highWaterMark.toFixed(2)} | PnL: ${pnlFromHigh >= 0 ? '+' : ''}$${pnlFromHigh.toFixed(2)}`);
    
    const candles = await fetchCandles();
    if (candles.length < 15) {
      console.log('[SolanaBotV1] Not enough candle data');

      const posStatus = hasPosition ? 'IN' : 'OUT';
      const posReason = hasPosition
        ? (position.entryAssumed ? 'entry=assumed' : 'entry=tracked')
        : 'no_SOL';
      const status = `pos=${posStatus}(${posReason}) solPct=${currentSolPct.toFixed(1)}% dayPnL=${dayPnlPct.toFixed(2)}% trades=${riskState.tradesToday}/${maxDailyTrades} impactSkips=${skipStats.impactSkipsToday}${dailyHalt ? ' HALT' : ''}`;

      const tickHold: StrategySignal = {
        action: 'hold',
        reason: `Not enough candle data | ${status}`,
        price,
        rsi4h: null,
        vwap4h: null,
        sma3d: null,
        trendBias: 'neutral',
        zone: 'solana_v1_mean_rev',
        targetSolPct: cfg.solanaBotV1.strategy.position.maxPositionPct,
        rsiDirection: 'flat',
      };
      await notifier.sendSignalNotification(tickHold, null);
      return;
    }
    
    if (hasPosition && !position.inPosition) {
      // Bootstrap: if SOL % is too high, sell down to target
      if (currentSolPct > targetSolPct + 5) {
        const excessSol = balances.solBalance - (totalValue * (targetSolPct / 100) / price);
        if (excessSol > 0.1) {
          console.log(`[SolanaBotV1] Bootstrap: Selling excess SOL (${excessSol.toFixed(4)}) to reach ${targetSolPct}% target`);

          const bootstrapSellSig: StrategySignal = {
            action: 'rebalance_sell',
            reason: `Bootstrap: selling excess SOL (${excessSol.toFixed(4)}) to target ${targetSolPct}%`,
            price,
            rsi4h: null,
            vwap4h: null,
            sma3d: null,
            trendBias: 'neutral',
            zone: 'solana_v1_mean_rev',
            targetSolPct: targetSolPct,
            rsiDirection: 'flat',
          };
          await notifier.sendSignalNotification(bootstrapSellSig, null);

          const result = await executor.sellSol(excessSol, dryRun, price);
          if (result.success) {
            console.log(`[SolanaBotV1] Bootstrap sell result:`, result);
          }
          return; // Exit tick after bootstrap sell
        }
      }
    }
    
    if (hasPosition && !position.inPosition) {
      position = {
        ...position,
        inPosition: true,
        // If we restart with SOL already held and no entry info, assume current price
        // so the bot can manage exits; this is conservative and will be corrected
        // naturally after the next full trade cycle.
        entryPrice: position.entryPrice ?? price,
        entryAssumed: position.entryPrice == null,
        entryTime: Date.now(),
        size: balances.solBalance,
        pnlPct: 0,
        trailingActive: false,
        trailingPrice: null,
        cooldownUntil: null,
        tradesToday: 0,
        lastTradeDate: new Date().toDateString(),
        peakValue: totalValue,
        currentValue: totalValue,
      };
      console.log('[SolanaBotV1] Detected existing position from wallet');
      if (persistedPosition === null) {
        await notifier.sendAlert('SolanaBotV1 restarted with existing SOL position; entry price unknown — assuming current spot for risk management');
      }
      logger.saveState('solanaBotV1_position', position);
    } else if (!hasPosition && position.inPosition) {
      position = buildInitialSolanaBotV1Position();
      console.log('[SolanaBotV1] No position detected - reset state');
      logger.saveState('solanaBotV1_position', position);
    }
    
    const signal = evaluateSolanaBotV1Strategy(price, candles, position, cfg, Date.now());
    console.log(`[SolanaBotV1] Signal: ${signal.action} - ${signal.reason}`);

    const mappedAction = signal.action === 'buy'
      ? 'rebalance_buy'
      : signal.action === 'sell'
        ? 'rebalance_sell'
        : 'hold';

    const posStatus = hasPosition ? 'IN' : 'OUT';
    const posReason = hasPosition
      ? (position.entryAssumed ? 'entry=assumed' : 'entry=tracked')
      : 'no_SOL';
    const status = `pos=${posStatus}(${posReason}) solPct=${currentSolPct.toFixed(1)}% dayPnL=${dayPnlPct.toFixed(2)}% trades=${riskState.tradesToday}/${maxDailyTrades} impactSkips=${skipStats.impactSkipsToday}${dailyHalt ? ' HALT' : ''}`;

    const tickSignal: StrategySignal = {
      action: mappedAction,
      reason: `${signal.reason} | ${status}`,
      price: signal.price,
      rsi4h: signal.rsi,
      vwap4h: signal.vwap,
      sma3d: null,
      trendBias: 'neutral',
      zone: 'solana_v1_mean_rev',
      targetSolPct: cfg.solanaBotV1.strategy.position.maxPositionPct,
      rsiDirection: signal.rsiDirection,
    };
    await notifier.sendSignalNotification(tickSignal, null);
    
    if (!dailyHalt && signal.action === 'buy' && !position.inPosition) {
      const balances = await walletManager.getBalances(price);
      const usdcBalance = balances.usdcBalance;
      const pct = Math.max(0, Math.min(1, cfg.solanaBotV1.strategy.position.maxPositionPct / 100));
      const tradeUsdc = Math.min(usdcBalance * pct, usdcBalance);
      
      if (tradeUsdc < 10) {
        console.log('[SolanaBotV1] Insufficient USDC balance');
        return;
      }
      
      console.log(`[SolanaBotV1] BUY ${tradeUsdc.toFixed(2)} USDC worth of SOL at $${price} (dryRun=${dryRun})`);
      
      const result = await executor.buySol(tradeUsdc, dryRun, price);
      console.log(`[SolanaBotV1] Buy result:`, result);
      if (!result.success && result.error && result.error.includes('Quote price impact too high')) {
        skipStats.impactSkipsToday += 1;
        skipStats.impactSkipsTotal += 1;
        skipStats.lastImpactMsg = result.error;
        logger.saveState('solanaBotV1_skip_stats', skipStats);
      }
      if (result.success) {
        const txSig = result.txSignature ?? 'dry-run';
          await logger.logTrade({
          timestamp: Date.now(),
          action: 'buy',
          side: 'buy',
          solAmount: result.outputAmount,
          usdcAmount: tradeUsdc,
          price: price,
            zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
            reason: 'SolanaBotV1 mean-reversion entry',
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: null,
          avgEntryAtSell: null,
        });
          await notifier.sendTradeNotification({
          timestamp: Date.now(),
          action: 'buy',
          side: 'buy',
          solAmount: result.outputAmount,
          usdcAmount: tradeUsdc,
          price: price,
            zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
            reason: 'SolanaBotV1 mean-reversion entry',
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: null,
          avgEntryAtSell: null,
        }, dryRun);
      }
      
      position = updateSolanaBotV1Position(position, 'buy', price, tradeUsdc / price, cfg, Date.now());
      logger.saveState('solanaBotV1_position', position);
      riskState.tradesToday += 1;
      logger.saveState('solanaBotV1_risk', riskState);
    } 
    else if (!dailyHalt && signal.action === 'sell' && position.inPosition && position.entryPrice) {
      const balances = await walletManager.getBalances(price);
      const solBalance = balances.solBalance;
      const size = Math.min(position.size, solBalance);
      
      if (size < 0.01) {
        console.log('[SolanaBotV1] Insufficient SOL balance');
        return;
      }
      
      console.log(`[SolanaBotV1] SELL ${size.toFixed(4)} SOL at $${price}`);
      
      const pnl = (price - position.entryPrice) * size;
      
      const result = await executor.sellSol(size, dryRun, price);
      if (!result.success && result.error && result.error.includes('Quote price impact too high')) {
        skipStats.impactSkipsToday += 1;
        skipStats.impactSkipsTotal += 1;
        skipStats.lastImpactMsg = result.error;
        logger.saveState('solanaBotV1_skip_stats', skipStats);
      }
      if (result.success) {
        const txSig = result.txSignature ?? 'dry-run';
        await logger.logTrade({
          timestamp: Date.now(),
          action: 'sell',
          side: 'sell',
          solAmount: size,
          usdcAmount: result.outputAmount,
          price: price,
          zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: signal.reason,
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: pnl,
          avgEntryAtSell: position.entryPrice,
        });
        await notifier.sendTradeNotification({
          timestamp: Date.now(),
          action: 'sell',
          side: 'sell',
          solAmount: size,
          usdcAmount: result.outputAmount,
          price: price,
          zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: signal.reason,
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: pnl,
          avgEntryAtSell: position.entryPrice,
        }, dryRun);
      }
      
      position = updateSolanaBotV1Position(position, 'sell', price, size, cfg, Date.now());
      logger.saveState('solanaBotV1_position', position);
      riskState.tradesToday += 1;
      logger.saveState('solanaBotV1_risk', riskState);
    }
    
  } catch (err) {
    console.error('[SolanaBotV1] Error:', err);
    await notifier.sendAlert(`Bot error: ${(err as Error).message}`);
  } finally {
    tickInProgress = false;
  }
}

console.log('[SolanaBotV1] Starting bot...');
console.log(`[SolanaBotV1] Config: RSI(${cfg.solanaBotV1.strategy.rsi.period}) deviation ${cfg.solanaBotV1.strategy.entry.minDeviationPct}% PT ${cfg.solanaBotV1.strategy.exit.profitTargetPct}% SL ${cfg.solanaBotV1.strategy.exit.stopLossPct}%`);

const cronExpression = cfg.scheduler?.cronExpression ?? '*/15 * * * *';
const mode = dryRun ? ' [DRY RUN]' : '';

const cfgSnapshot = [
  `tf=${cfg.solanaBotV1.timeframe} cron=${cronExpression}`,
  `mode=${cfg.solanaBotV1.strategy.mode ?? 'mean_reversion'}`,
  `entryDev>=${cfg.solanaBotV1.strategy.entry.minDeviationPct}% PT=${cfg.solanaBotV1.strategy.exit.profitTargetPct}% SL=${cfg.solanaBotV1.strategy.exit.stopLossPct}%`,
  `ema=${cfg.solanaBotV1.strategy.trendFilter.emaPeriod} band=[${cfg.solanaBotV1.strategy.trendFilter.disableBelowPct},${cfg.solanaBotV1.strategy.trendFilter.disableAbovePct}]`,
  `maxPos=${cfg.solanaBotV1.strategy.position.maxPositionPct}% dailyLoss=${cfg.solanaBotV1.risk.maxDailyLossPct}% dailyTrades=${cfg.solanaBotV1.risk.maxDailyTrades}`,
  `jupMaxSlippage=0.5% maxImpact=${(maxImpact === Infinity ? 'none' : `${maxImpact}%`)}`,
  `impactSkipsToday=${skipStats.impactSkipsToday} total=${skipStats.impactSkipsTotal}`,
].join('\n');

notifier
  .sendAlert(
    `🤖 Bot online — MAINNET${mode}\nWallet: \`${executor.walletAddress}\`\nBot: SolanaBotV1\n\n${cfgSnapshot}`,
  )
  .catch(() => {});

runTick().then(() => {
  cron.schedule(cronExpression, runTick, { timezone: 'UTC' });
  console.log(`[SolanaBotV1] Running on cron: ${cronExpression}`);
});

process.on('SIGINT', () => {
  console.log('[SolanaBotV1] Shutting down...');
  discordCommands?.destroy();
  logger.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  discordCommands?.destroy();
  logger.close();
  process.exit(0);
});

let fatalHandling = false;
async function handleFatal(label: string, err: unknown): Promise<void> {
  if (fatalHandling) return;
  fatalHandling = true;

  const e = err as Error;
  const msg = `${label}: ${e?.message ?? String(err)}`;
  console.error(`[SolanaBotV1] ${msg}`);
  try {
    await notifier.sendAlert(msg);
  } catch {
    // best-effort
  }

  try { discordCommands?.destroy(); } catch {}
  try { logger.close(); } catch {}
  setTimeout(() => process.exit(1), 500).unref();
}

process.on('unhandledRejection', (reason: unknown) => {
  void handleFatal('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err: Error) => {
  void handleFatal('Uncaught exception', err);
});
