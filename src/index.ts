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
import type { ChecklistLine, SolanaBotV1TickAction, SolanaBotV1TickNotification } from './sharedTypes';
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

const dbPath = process.env.DB_PATH
  ?? path.resolve(__dirname, '..', 'data', 'trades-solana-bot-v1.db');
const logger = new TradeLogger(dbPath);

const maxImpact = cfg.solanaBotV1.risk.maxQuotePriceImpactPct ?? Infinity;
const executor = new TradeExecutor(rpcUrl, privateKey, 1.0, maxImpact);
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
const persistedPosition = logger.loadState<typeof position>('solanaBotV1_position');
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
  ?? { day: '', dayStartValueUSDC: 0, tradesToday: 0 };

type SolanaBotV1SkipStats = {
  day: string; // YYYY-MM-DD UTC
  impactSkipsToday: number;
  impactSkipsTotal: number;
  lastImpactMsg: string | null;
};

let skipStats: SolanaBotV1SkipStats =
  logger.loadState<SolanaBotV1SkipStats>('solanaBotV1_skip_stats')
  ?? { day: '', impactSkipsToday: 0, impactSkipsTotal: 0, lastImpactMsg: null };

let tickInProgress = false;
let botState =
  logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('solanaBotV1_state')
  ?? { highWaterMark: 0, solBalance: 0, usdcBalance: 0 };

let dailyHaltAlert =
  logger.loadState<{ day: string; reason: string }>('solanaBotV1_daily_halt_alert')
  ?? { day: '', reason: '' };

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

      // Avoid spamming alerts every tick while halted.
      if (dailyHaltAlert.day !== day || dailyHaltAlert.reason !== reason) {
        dailyHaltAlert = { day, reason };
        logger.saveState('solanaBotV1_daily_halt_alert', dailyHaltAlert);
        await notifier.sendAlert(`${reason} — SolanaBotV1 halting new trades until next UTC day`);
      }
    }
    const pnlFromHigh = totalValue - botState.highWaterMark;
    console.log(`[SolanaBotV1] Wallet: ${balances.solBalance.toFixed(4)} SOL ($${solValue.toFixed(2)}) + $${usdcValue.toFixed(2)} USDC = $${totalValue.toFixed(2)} | SOL%: ${solPct.toFixed(1)}% | High: $${botState.highWaterMark.toFixed(2)} | PnL: ${pnlFromHigh >= 0 ? '+' : ''}$${pnlFromHigh.toFixed(2)}`);
    
    const candles = await fetchCandles();
    if (candles.length < 15) {
      console.log('[SolanaBotV1] Not enough candle data');

      const mk = (label: string, pass: boolean, detail: string): ChecklistLine => ({ label, pass, detail });
      const tickTs = Date.now();
      const mode = cfg.solanaBotV1.strategy.mode ?? 'mean_reversion';
      const entryAssumed = Boolean(position.entryAssumed);
      const holdMinutes = position.inPosition && position.entryTime ? (tickTs - position.entryTime) / 60000 : null;
      const unrealizedPct = position.inPosition && position.entryPrice
        ? ((price - position.entryPrice) / position.entryPrice) * 100
        : null;

      const tick: SolanaBotV1TickNotification = {
        ts: tickTs,
        timeframe: cfg.solanaBotV1.timeframe,
        mode,
        action: dailyHalt ? 'HALT' : 'HOLD',
        decisionReason: 'Not enough candle data',
        price,
        rsi: null,
        rsiDirection: 'flat',
        vwap: null,
        vwapDevPct: null,
        emaTrendPct: null,
        emaSlopePct: null,
        atrPct: null,
        requiredDevPct: null,
        profitTargetPct: null,
        stopLossPct: null,
        position: {
          inPosition: position.inPosition,
          entryPrice: position.entryPrice,
          entryAssumed,
          unrealizedPct,
          holdMinutes,
          solPct: currentSolPct,
          solBalance: balances.solBalance,
          usdcBalance: balances.usdcBalance,
          totalValueUSDC: totalValue,
        },
        risk: {
          dayPnlPct,
          tradesToday: riskState.tradesToday,
          maxDailyTrades,
          impactSkipsToday: skipStats.impactSkipsToday,
          dailyHalt,
          cooldownRemainingMin: position.cooldownUntil ? Math.max(0, Math.round((position.cooldownUntil - tickTs) / 60000)) : null,
        },
        checklist: {
          gates: [
            mk('Bot enabled', cfg.solanaBotV1.enabled, `enabled=${cfg.solanaBotV1.enabled}`),
            mk('Daily risk brake', !dailyHalt, `halt=${dailyHalt} (trades ${riskState.tradesToday}/${maxDailyTrades}, dayPnL ${dayPnlPct.toFixed(2)}%)`),
            mk('Indicators ready', false, `candles=${candles.length} (need >= 15)`),
          ],
          entry: [mk('N/A', true, 'Waiting for indicators')],
          exit: [mk('N/A', true, 'Waiting for indicators')],
        },
      };

      logger.saveState('solanaBotV1_last_tick', tick);
      await notifier.sendTickNotification(tick);
      return;
    }
    
    if (hasPosition && !position.inPosition) {
      // Bootstrap: if SOL % is too high, sell down to target
      if (currentSolPct > targetSolPct + 5) {
        const excessSol = balances.solBalance - (totalValue * (targetSolPct / 100) / price);
        if (excessSol > 0.1) {
          console.log(`[SolanaBotV1] Bootstrap: Selling excess SOL (${excessSol.toFixed(4)}) to reach ${targetSolPct}% target`);

          const mk = (label: string, pass: boolean, detail: string): ChecklistLine => ({ label, pass, detail });
          const tickTs = Date.now();
          const mode = cfg.solanaBotV1.strategy.mode ?? 'mean_reversion';

          const tick: SolanaBotV1TickNotification = {
            ts: tickTs,
            timeframe: cfg.solanaBotV1.timeframe,
            mode,
            action: 'BOOTSTRAP_SELL',
            decisionReason: `Bootstrap sell: excess SOL ${excessSol.toFixed(4)} to target ${targetSolPct}%`,
            price,
            rsi: null,
            rsiDirection: 'flat',
            vwap: null,
            vwapDevPct: null,
            emaTrendPct: null,
            emaSlopePct: null,
            atrPct: null,
            requiredDevPct: null,
            profitTargetPct: null,
            stopLossPct: null,
            position: {
              inPosition: position.inPosition,
              entryPrice: position.entryPrice,
              entryAssumed: Boolean(position.entryAssumed),
              unrealizedPct: null,
              holdMinutes: null,
              solPct: currentSolPct,
              solBalance: balances.solBalance,
              usdcBalance: balances.usdcBalance,
              totalValueUSDC: totalValue,
            },
            risk: {
              dayPnlPct,
              tradesToday: riskState.tradesToday,
              maxDailyTrades,
              impactSkipsToday: skipStats.impactSkipsToday,
              dailyHalt,
              cooldownRemainingMin: null,
            },
            checklist: {
              gates: [mk('Bootstrap condition', true, `solPct=${currentSolPct.toFixed(1)}% > ${targetSolPct + 5}%`)],
              entry: [mk('N/A', true, 'Bootstrap sell')],
              exit: [mk('N/A', true, 'Bootstrap sell')],
            },
          };

          logger.saveState('solanaBotV1_last_tick', tick);
          await notifier.sendTickNotification(tick);

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

    const mk = (label: string, pass: boolean, detail: string): ChecklistLine => ({ label, pass, detail });
    const fmt = (v: number | null, digits: number = 2): string => (v === null ? 'n/a' : v.toFixed(digits));
    const d = signal.diagnostics;

    const tickTs = Date.now();
    let tickAction: SolanaBotV1TickAction = dailyHalt
      ? 'HALT'
      : d.cooldownRemainingMin !== null && d.cooldownRemainingMin > 0
        ? 'COOLDOWN'
        : signal.action === 'buy'
          ? 'BUY'
          : signal.action === 'sell'
            ? 'SELL'
            : 'HOLD';

    let decisionReason = signal.reason;

    const gates: ChecklistLine[] = [
      mk('Bot enabled', cfg.solanaBotV1.enabled, `enabled=${cfg.solanaBotV1.enabled}`),
      mk('Daily risk brake', !dailyHalt, `halt=${dailyHalt} (trades ${riskState.tradesToday}/${maxDailyTrades}, dayPnL ${dayPnlPct.toFixed(2)}%)`),
      mk('Cooldown', d.cooldownRemainingMin === null || d.cooldownRemainingMin === 0, `remaining=${d.cooldownRemainingMin ?? 0}m`),
      mk('Trend gate (entries)', d.allowEntry || position.inPosition, d.allowEntry ? 'allow' : (d.entryGateReason ?? 'gated')),
      mk(
        'Impact guard',
        true,
        `maxImpact=${maxImpact === Infinity ? 'none' : `${maxImpact.toFixed(2)}%`} (enforced on quote)`
      ),
    ];

    const entryChecklist: ChecklistLine[] = [
      mk('Price vs EMA50', d.bullishRegime, `emaTrend=${fmt(d.emaTrendPct, 2)}% (need >= 0%)`),
      mk('EMA slope', d.emaSlopeUp, `emaSlope=${fmt(d.emaSlopePct, 3)}% (need >= 0%)`),
      mk('VWAP deviation', d.belowVwap, `dev=${fmt(d.deviationPct, 2)}% (need <= -${fmt(d.requiredDevPct, 2)}%)`),
      mk(
        'RSI oversold/recovery',
        d.recoveryOk,
        `rsi=${fmt(signal.rsi, 1)} prev=${fmt(null, 1)} (need rsi<${cfg.solanaBotV1.strategy.rsi.oversold} OR prev<${cfg.solanaBotV1.strategy.rsi.oversold} and rsi>=${cfg.solanaBotV1.strategy.rsi.exitOversold})`,
      ),
      mk('Volatility', d.volOk, `atr=${fmt(signal.atrPercent, 2)}% (need <= 8.00%)`),
    ];

    // Fill in prevRSI for the checklist if present.
    if (signal.rsi !== null) {
      // We don't have prevRSI in the signal payload; use diagnostics gates instead.
      entryChecklist[3] = mk(
        'RSI oversold/recovery',
        d.recoveryOk,
        `oversoldNow=${d.oversoldNow} wasOversold=${d.wasOversold} rsi=${signal.rsi.toFixed(1)} (oversold<${cfg.solanaBotV1.strategy.rsi.oversold}, exit>=${cfg.solanaBotV1.strategy.rsi.exitOversold})`,
      );
    }

    const exitChecklist: ChecklistLine[] = d.pnlPct === null || d.holdMinutes === null
      ? [mk('Entry tracked', false, 'entryPrice/entryTime missing')]
      : [
          mk('Regime exit (deep below EMA)', d.regimeExitHit, `emaTrend=${fmt(d.emaTrendPct, 2)}% (sell if < ${cfg.solanaBotV1.strategy.trendFilter.disableBelowPct}%)`),
          mk('Stop loss', d.stopLossHit, `pnl=${fmt(d.pnlPct, 2)}% (sell if <= -${fmt(d.stopLossPct, 2)}%)`),
          mk('Profit target', d.profitTargetHit, `pnl=${fmt(d.pnlPct, 2)}% (sell if >= ${fmt(d.profitTargetPct, 2)}%)`),
          mk(
            'RSI exit',
            d.rsiExitHit,
            `rsi=${fmt(signal.rsi, 1)} dir=${signal.rsiDirection} (sell if rsi>${cfg.solanaBotV1.strategy.rsi.exitOverbought} and falling)`,
          ),
          mk('Reversion exit', d.reversionExitHit, `dev=${fmt(d.deviationPct, 2)}% | pnl=${fmt(d.pnlPct, 2)}%`),
          mk('Time exit', d.timeExitHit, `hold=${fmt(d.holdMinutes, 0)}m (sell if >${cfg.solanaBotV1.strategy.exit.maxHoldMinutes}m and pnl>0)`),
        ];

    const minTradeUsdc = cfg.solanaBotV1.strategy.position.minTradeUSDC;

    if (!dailyHalt && signal.action === 'buy' && !position.inPosition) {
      // Reuse balances already fetched at top of tick — no redundant RPC call.
      const usdcBalance = balances.usdcBalance;
      const pct = Math.max(0, Math.min(1, cfg.solanaBotV1.strategy.position.maxPositionPct / 100));
      const tradeUsdc = Math.min(usdcBalance * pct, usdcBalance);
      
      if (tradeUsdc < minTradeUsdc) {
        console.log('[SolanaBotV1] Insufficient USDC balance');
        tickAction = 'HOLD';
        decisionReason = `Insufficient USDC balance for minTradeUSDC=${minTradeUsdc}`;
      } else {
      
      console.log(`[SolanaBotV1] BUY ${tradeUsdc.toFixed(2)} USDC worth of SOL at $${price} (dryRun=${dryRun})`);
      
      const result = await executor.buySol(tradeUsdc, dryRun, price);
      console.log(`[SolanaBotV1] Buy result:`, result);
      if (!result.success && result.error && result.error.includes('Quote price impact too high')) {
        skipStats.impactSkipsToday += 1;
        skipStats.impactSkipsTotal += 1;
        skipStats.lastImpactMsg = result.error;
        logger.saveState('solanaBotV1_skip_stats', skipStats);

        tickAction = 'SKIP_IMPACT';
        decisionReason = `Skipped buy: ${result.error}`;
      }
      if (!result.success) {
        if (tickAction !== 'SKIP_IMPACT') {
          tickAction = 'HOLD';
          decisionReason = `Buy failed: ${result.error ?? 'unknown error'}`;
        }
      } else {
        const txSig = result.txSignature ?? 'dry-run';
        const fillPrice = result.price;
        const fillSol = result.outputAmount;

        await logger.logTrade({
          timestamp: Date.now(),
          action: 'buy',
          side: 'buy',
          solAmount: fillSol,
          usdcAmount: tradeUsdc,
          price: fillPrice,
          zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: signal.reason,
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
          solAmount: fillSol,
          usdcAmount: tradeUsdc,
          price: fillPrice,
          zone: 'SolanaBotV1-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: signal.reason,
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: null,
          avgEntryAtSell: null,
        }, dryRun);

        position = updateSolanaBotV1Position(position, 'buy', fillPrice, fillSol, cfg, Date.now());
        logger.saveState('solanaBotV1_position', position);
        riskState.tradesToday += 1;
        logger.saveState('solanaBotV1_risk', riskState);

        tickAction = 'BUY';
        decisionReason = `${signal.reason} | filled $${fillPrice.toFixed(4)} size ${fillSol.toFixed(4)} SOL`;
      }
      }
    } 
    else if (!dailyHalt && signal.action === 'sell' && position.inPosition && position.entryPrice) {
      // Reuse balances already fetched at top of tick — no redundant RPC call.
      const solBalance = balances.solBalance;
      // Reserve SOL for rent + tx fees. Jupiter wraps native SOL into a WSOL
      // token account (rent-exempt min = 0.00203928 SOL) plus ~0.001 SOL for
      // priority fees. Selling the full raw balance causes simulation failure
      // (InstructionError Custom:1 = InsufficientFunds on the WSOL creation).
      const SOL_FEE_RESERVE = 0.005;
      const size = Math.min(position.size, Math.max(0, solBalance - SOL_FEE_RESERVE));
      
      if (size < 0.01) {
        console.log('[SolanaBotV1] Insufficient SOL balance');
        tickAction = 'HOLD';
        decisionReason = 'Insufficient SOL balance';
      } else {
        console.log(`[SolanaBotV1] SELL ${size.toFixed(4)} SOL at $${price}`);

        const result = await executor.sellSol(size, dryRun, price);
        console.log(`[SolanaBotV1] Sell result:`, result);
        if (!result.success && result.error && result.error.includes('Quote price impact too high')) {
          skipStats.impactSkipsToday += 1;
          skipStats.impactSkipsTotal += 1;
          skipStats.lastImpactMsg = result.error;
          logger.saveState('solanaBotV1_skip_stats', skipStats);

          tickAction = 'SKIP_IMPACT';
          decisionReason = `Skipped sell: ${result.error}`;
        }

        if (!result.success) {
          if (tickAction !== 'SKIP_IMPACT') {
            tickAction = 'HOLD';
            decisionReason = `Sell failed: ${result.error ?? 'unknown error'}`;
          }
        } else {
          const txSig = result.txSignature ?? 'dry-run';
          const fillPrice = result.price;
          const proceedsUsdc = result.outputAmount;
          const pnl = (fillPrice - position.entryPrice) * size;

          await logger.logTrade({
            timestamp: Date.now(),
            action: 'sell',
            side: 'sell',
            solAmount: size,
            usdcAmount: proceedsUsdc,
            price: fillPrice,
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
            usdcAmount: proceedsUsdc,
            price: fillPrice,
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

          position = updateSolanaBotV1Position(position, 'sell', fillPrice, size, cfg, Date.now());
          logger.saveState('solanaBotV1_position', position);
          riskState.tradesToday += 1;
          logger.saveState('solanaBotV1_risk', riskState);

          tickAction = 'SELL';
          decisionReason = `${signal.reason} | filled $${fillPrice.toFixed(4)} size ${size.toFixed(4)} SOL pnl ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
        }
      }
    }

    const tick: SolanaBotV1TickNotification = {
      ts: tickTs,
      timeframe: cfg.solanaBotV1.timeframe,
      mode: d.mode,
      action: tickAction,
      decisionReason,
      price: signal.price,
      rsi: signal.rsi,
      rsiDirection: signal.rsiDirection,
      vwap: signal.vwap,
      vwapDevPct: signal.vwap ? ((signal.price - signal.vwap) / signal.vwap) * 100 : null,
      emaTrendPct: d.emaTrendPct,
      emaSlopePct: d.emaSlopePct,
      atrPct: signal.atrPercent,
      requiredDevPct: d.requiredDevPct,
      profitTargetPct: d.profitTargetPct,
      stopLossPct: d.stopLossPct,
      position: {
        inPosition: position.inPosition,
        entryPrice: position.entryPrice,
        entryAssumed: Boolean(position.entryAssumed),
        unrealizedPct: position.inPosition && position.entryPrice ? ((price - position.entryPrice) / position.entryPrice) * 100 : null,
        holdMinutes: position.inPosition && position.entryTime ? (tickTs - position.entryTime) / 60000 : null,
        solPct: currentSolPct,
        solBalance: balances.solBalance,
        usdcBalance: balances.usdcBalance,
        totalValueUSDC: totalValue,
      },
      risk: {
        dayPnlPct,
        tradesToday: riskState.tradesToday,
        maxDailyTrades,
        impactSkipsToday: skipStats.impactSkipsToday,
        dailyHalt,
        cooldownRemainingMin: position.cooldownUntil ? Math.max(0, Math.round((position.cooldownUntil - tickTs) / 60000)) : null,
      },
      checklist: {
        gates,
        entry: entryChecklist,
        exit: exitChecklist,
      },
    };

    logger.saveState('solanaBotV1_last_tick', tick);
    await notifier.sendTickNotification(tick);
    
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
