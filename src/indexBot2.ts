import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import cron from 'node-cron';
import fs from 'fs';
import { Bot2Config } from './typesBot2';
import { TradeExecutor } from './executor';
import { WalletManager } from './walletManager';
import { TradeLogger } from './logger';
import { Notifier } from './notifications';
import { DiscordCommands } from './discordCommands';
import { evaluateBot2Strategy, buildInitialBot2Position, updateBot2Position } from './strategyBot2';
import axios from 'axios';

const configPath = path.resolve(__dirname, '..', 'config-bot2.json');
if (!fs.existsSync(configPath)) {
  console.error('[Bot2] config-bot2.json not found');
  process.exit(1);
}
const cfg: Bot2Config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

if (dryRun) console.log('[Bot2] *** DRY-RUN MODE ***');

const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
  console.error('[Bot2] WALLET_PRIVATE_KEY not set');
  process.exit(1);
}

const rpcUrl = process.env.HELIUS_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const ccKey = process.env.CRYPTOCOMPARE_API_KEY ?? '';

const dbPath = process.env.DB_PATH ?? path.resolve(__dirname, '..', 'data', 'trades-bot2.db');
const logger = new TradeLogger(dbPath);

const executor = new TradeExecutor(rpcUrl, privateKey, 0.5);
const walletManager = new WalletManager(rpcUrl, executor.walletAddress, false);

const notifier = new Notifier({
  enabled: cfg.bot2.enabled,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
  type: 'discord',
});

const startTime = new Date();
const discordBotToken = process.env.DISCORD_BOT_TOKEN ?? '';
let discordCommands: DiscordCommands | null = null;

if (discordBotToken) {
  discordCommands = new DiscordCommands(
    { botToken: discordBotToken, dryRun, network: 'MAINNET', startTime, botId: 'bot2' },
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

let position = buildInitialBot2Position();
let botState = logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('bot2_state') ?? { highWaterMark: 0, solBalance: 0, usdcBalance: 0 };

async function fetchPrice(): Promise<number> {
  const { data } = await axios.get('https://min-api.cryptocompare.com/data/price', {
    params: { fsym: 'SOL', tsyms: 'USD', api_key: ccKey },
  });
  return data.USD;
}

async function fetchCandles(hours: number = 48): Promise<Candle[]> {
  const endSec = Math.floor(Date.now() / 1000);
  const startSec = endSec - hours * 3600;
  const { data } = await axios.get('https://min-api.cryptocompare.com/data/v2/histohour', {
    params: { fsym: 'SOL', tsym: 'USD', limit: 2000, toTs: endSec, api_key: ccKey },
  });
  
  if (data.Response !== 'Success') {
    console.log('[Bot2] Candle API error:', data.Message);
    return [];
  }
  
  if (!data.Data || !data.Data.Data) {
    console.log('[Bot2] No candle data structure');
    return [];
  }
  
  const candles: Candle[] = [];
  for (const r of data.Data.Data) {
    if (r.time < startSec) continue;
    candles.push({
      timestamp: r.time * 1000,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volumefrom,
    });
  }
  console.log(`[Bot2] Fetched ${candles.length} hourly candles`);
  
  const agg: Candle[] = [];
  for (let i = 0; i < candles.length; i += 4) {
    const chunk = candles.slice(i, i + 4);
    if (chunk.length > 0) {
      agg.push({
        timestamp: chunk[0].timestamp,
        open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
      });
    }
  }
  return agg;
}

async function runTick(): Promise<void> {
  console.log(`[Bot2] Tick at ${new Date().toISOString()}`);
  
  try {
    const price = await fetchPrice();
    console.log(`[Bot2] SOL price: $${price}`);
    
    const balances = await walletManager.getBalances(price);
    const solValue = balances.solBalance * price;
    const usdcValue = balances.usdcBalance;
    const totalValue = solValue + usdcValue;
    const solPct = totalValue > 0 ? (solValue / totalValue) * 100 : 0;
    
    // Track high water mark and save balances
    if (totalValue > botState.highWaterMark) {
      botState.highWaterMark = totalValue;
    }
    botState.solBalance = balances.solBalance;
    botState.usdcBalance = balances.usdcBalance;
    logger.saveState('bot2_state', botState);
    const pnlFromHigh = totalValue - botState.highWaterMark;
    console.log(`[Bot2] Wallet: ${balances.solBalance.toFixed(4)} SOL ($${solValue.toFixed(2)}) + $${usdcValue.toFixed(2)} USDC = $${totalValue.toFixed(2)} | SOL%: ${solPct.toFixed(1)}% | High: $${botState.highWaterMark.toFixed(2)} | PnL: ${pnlFromHigh >= 0 ? '+' : ''}$${pnlFromHigh.toFixed(2)}`);
    
    const candles = await fetchCandles(72);
    if (candles.length < 15) {
      console.log('[Bot2] Not enough candle data');
      return;
    }
    
    const hasPosition = balances.solBalance > 0.1;
    const targetSolPct = 30;
    const currentSolPct = totalValue > 0 ? (solValue / totalValue) * 100 : 0;
    
    if (hasPosition && !position.inPosition) {
      // Bootstrap: if SOL % is too high, sell down to target
      if (currentSolPct > targetSolPct + 5) {
        const excessSol = balances.solBalance - (totalValue * (targetSolPct / 100) / price);
        if (excessSol > 0.1) {
          console.log(`[Bot2] Bootstrap: Selling excess SOL (${excessSol.toFixed(4)}) to reach ${targetSolPct}% target`);
          const result = await executor.sellSol(excessSol, dryRun, price);
          if (result.success) {
            console.log(`[Bot2] Bootstrap sell result:`, result);
          }
          return; // Exit tick after bootstrap sell
        }
      }
    }
    
    if (hasPosition && !position.inPosition) {
      position = {
        ...position,
        inPosition: true,
        entryPrice: price,
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
      console.log('[Bot2] Detected existing position from wallet');
    } else if (!hasPosition && position.inPosition) {
      position = buildInitialBot2Position();
      console.log('[Bot2] No position detected - reset state');
    }
    
    const signal = evaluateBot2Strategy(price, candles, position, cfg, Date.now());
    console.log(`[Bot2] Signal: ${signal.action} - ${signal.reason}`);
    
    if (signal.action === 'buy' && !position.inPosition) {
      const balances = await walletManager.getBalances(price);
      const usdcBalance = balances.usdcBalance;
      const tradeUsdc = Math.min(usdcBalance * 0.3, usdcBalance);
      
      if (tradeUsdc < 10) {
        console.log('[Bot2] Insufficient USDC balance');
        return;
      }
      
      console.log(`[Bot2] BUY ${tradeUsdc.toFixed(2)} USDC worth of SOL at $${price} (dryRun=${dryRun})`);
      
      const result = await executor.buySol(tradeUsdc, dryRun, price);
      console.log(`[Bot2] Buy result:`, result);
      if (result.success) {
        const txSig = result.txSignature ?? 'dry-run';
        await logger.logTrade({
          timestamp: Date.now(),
          action: 'buy',
          side: 'buy',
          solAmount: result.outputAmount,
          usdcAmount: tradeUsdc,
          price: price,
          zone: 'Bot2-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: 'Bot2 mean-reversion entry',
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
          zone: 'Bot2-mean-rev',
          txSignature: txSig,
          dryRun: dryRun,
          reason: 'Bot2 mean-reversion entry',
          rsi: signal.rsi,
          vwap: signal.vwap,
          sma: null,
          trendBias: 'neutral',
          pnl: null,
          avgEntryAtSell: null,
        }, dryRun);
      }
      
      position = updateBot2Position(position, 'buy', price, tradeUsdc / price, cfg, Date.now());
    } 
    else if (signal.action === 'sell' && position.inPosition && position.entryPrice) {
      const balances = await walletManager.getBalances(price);
      const solBalance = balances.solBalance;
      const size = Math.min(position.size, solBalance);
      
      if (size < 0.01) {
        console.log('[Bot2] Insufficient SOL balance');
        return;
      }
      
      console.log(`[Bot2] SELL ${size.toFixed(4)} SOL at $${price}`);
      
      const pnl = (price - position.entryPrice) * size;
      
      const result = await executor.sellSol(size, dryRun, price);
      if (result.success) {
        const txSig = result.txSignature ?? 'dry-run';
        await logger.logTrade({
          timestamp: Date.now(),
          action: 'sell',
          side: 'sell',
          solAmount: size,
          usdcAmount: result.outputAmount,
          price: price,
          zone: 'Bot2-mean-rev',
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
          zone: 'Bot2-mean-rev',
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
      
      position = updateBot2Position(position, 'sell', price, size, cfg, Date.now());
    }
    
  } catch (err) {
    console.error('[Bot2] Error:', err);
  }
}

console.log('[Bot2] Starting mean-reversion bot...');
console.log(`[Bot2] Config: RSI(${cfg.bot2.strategy.rsi.period}) deviation ${cfg.bot2.strategy.entry.minDeviationPct}% PT ${cfg.bot2.strategy.exit.profitTargetPct}% SL ${cfg.bot2.strategy.exit.stopLossPct}%`);

runTick().then(() => {
  cron.schedule('*/15 * * * *', runTick);
  console.log('[Bot2] Running on 15m cron');
});

process.on('SIGINT', () => {
  console.log('[Bot2] Shutting down...');
  discordCommands?.destroy();
  process.exit(0);
});
