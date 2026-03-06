import 'dotenv/config';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';
import { BotConfig } from './types';
import { TradingBot } from './bot';
import { TradeExecutor } from './executor';
import { WalletManager } from './walletManager';
import { TradeLogger } from './logger';
import { Notifier } from './notifications';

// ── Load config ──────────────────────────────────────────────────────────────
const configPath = path.resolve(__dirname, '..', 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('[Main] config.json not found at', configPath);
  process.exit(1);
}
const cfg: BotConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// ── Parse CLI flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const testCycle = args.includes('--test-cycle');

if (dryRun) console.log('[Main] *** DRY-RUN MODE — no real transactions will be sent ***');

// ── Validate environment ─────────────────────────────────────────────────────
const privateKey = process.env.WALLET_PRIVATE_KEY;
if (!privateKey) {
  console.error('[Main] WALLET_PRIVATE_KEY not set in .env');
  process.exit(1);
}

const rpcUrl = cfg.network.useDevnet
  ? (process.env.HELIUS_RPC_URL_DEVNET ?? cfg.network.rpcEndpoint)
  : (process.env.HELIUS_RPC_URL ?? cfg.network.rpcEndpoint);

// ── Bootstrap modules ────────────────────────────────────────────────────────
const dbPath = process.env.DB_PATH ?? path.resolve(__dirname, '..', 'data', 'trades.db');
const logger = new TradeLogger(dbPath);

const executor = new TradeExecutor(rpcUrl, privateKey, cfg.strategy.risk.maxSlippagePct);

const walletManager = new WalletManager(rpcUrl, executor.walletAddress, cfg.network.useDevnet);

const notifier = new Notifier({
  enabled: cfg.notifications.enabled,
  webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? cfg.notifications.webhookUrl,
  type: cfg.notifications.type as 'discord' | 'telegram',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
});

const bot = new TradingBot(cfg, executor, walletManager, logger, notifier, dryRun);

// ── Run immediately on start, then on cron ───────────────────────────────────
async function runTick(): Promise<void> {
  try {
    await bot.tick();
  } catch (err) {
    console.error('[Main] Unhandled error in tick:', err);
    await notifier.sendAlert(`Bot error: ${(err as Error).message}`);
  }
}

console.log(`[Main] Starting Solana swing trading bot`);
console.log(`[Main] Network: ${cfg.network.useDevnet ? 'DEVNET' : 'MAINNET'}`);
console.log(`[Main] Wallet: ${executor.walletAddress}`);
console.log(`[Main] Cron: ${cfg.scheduler.cronExpression}`);
console.log(`[Main] Dry-run: ${dryRun}`);

// ── Startup notification ─────────────────────────────────────────────────────
const network = cfg.network.useDevnet ? 'DEVNET' : 'MAINNET';
const mode = dryRun ? ' [DRY RUN]' : '';
notifier.sendAlert(`🤖 Bot online — ${network}${mode}\nWallet: \`${executor.walletAddress}\`\nCron: \`${cfg.scheduler.cronExpression}\``).catch(() => {});

// Run immediately
if (testCycle) {
  if (!dryRun) {
    console.error('[Main] --test-cycle requires --dry-run');
    process.exit(1);
  }
  bot.runTestCycle().then(() => {
    logger.close();
    process.exit(0);
  }).catch(err => {
    console.error('[Main] Test cycle error:', err);
    logger.close();
    process.exit(1);
  });
} else {
  runTick().then(() => {
    // Schedule subsequent runs
    cron.schedule(cfg.scheduler.cronExpression, runTick, { timezone: 'UTC' });
    console.log(`[Main] Scheduler active — next runs on cron: ${cfg.scheduler.cronExpression}`);
  });
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Main] Shutting down...');
  logger.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.close();
  process.exit(0);
});
