import axios from 'axios';
import { StrategySignal, TradeRecord } from './types';

export interface NotificationConfig {
  enabled: boolean;
  webhookUrl: string;
  type: 'discord' | 'telegram';
  telegramBotToken?: string;
  telegramChatId?: string;
}

export class Notifier {
  private cfg: NotificationConfig;

  constructor(cfg: NotificationConfig) {
    this.cfg = cfg;
  }

  async sendTradeNotification(trade: TradeRecord, dryRun: boolean): Promise<void> {
    if (!this.cfg.enabled) return;

    const emoji = trade.side === 'buy' ? '🟢' : '🔴';
    const mode = dryRun ? '[DRY RUN] ' : '';
    const tier = trade.tier ? ` (Tier ${trade.tier})` : '';
    const pnl = trade.pnl !== null ? `\nP&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}` : '';

    const message = [
      `${emoji} ${mode}**${trade.action.toUpperCase()}${tier}**`,
      `Price: $${trade.price.toFixed(4)}`,
      `SOL: ${trade.solAmount.toFixed(4)} | USDC: $${trade.usdcAmount.toFixed(2)}`,
      `RSI: ${trade.rsi?.toFixed(1) ?? 'N/A'} | VWAP: $${trade.vwap?.toFixed(4) ?? 'N/A'}`,
      `Trend: ${trade.trendBias}`,
      `Reason: ${trade.reason}${pnl}`,
      trade.txSignature ? `TX: \`${trade.txSignature}\`` : '',
    ].filter(Boolean).join('\n');

    await this.send(message);
  }

  async sendSignalNotification(signal: StrategySignal): Promise<void> {
    if (!this.cfg.enabled) return;
    if (signal.action === 'hold') return; // suppress hold signals

    const message = [
      `📊 **Signal: ${signal.action.toUpperCase()}**`,
      `Price: $${signal.price.toFixed(4)}`,
      `RSI: ${signal.rsi4h?.toFixed(1) ?? 'N/A'} | VWAP: $${signal.vwap4h?.toFixed(4) ?? 'N/A'}`,
      `Trend bias: ${signal.trendBias}`,
      `Reason: ${signal.reason}`,
    ].join('\n');

    await this.send(message);
  }

  async sendAlert(message: string): Promise<void> {
    if (!this.cfg.enabled) return;
    await this.send(`⚠️ **ALERT**\n${message}`);
  }

  private async send(text: string): Promise<void> {
    try {
      if (this.cfg.type === 'discord' && this.cfg.webhookUrl) {
        await axios.post(this.cfg.webhookUrl, { content: text }, { timeout: 8000 });
      } else if (this.cfg.type === 'telegram') {
        const token = this.cfg.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN;
        const chatId = this.cfg.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) {
          console.warn('[Notifier] Telegram credentials not configured');
          return;
        }
        await axios.post(
          `https://api.telegram.org/bot${token}/sendMessage`,
          { chat_id: chatId, text, parse_mode: 'Markdown' },
          { timeout: 8000 },
        );
      }
    } catch (err) {
      console.warn('[Notifier] Failed to send notification:', (err as Error).message);
    }
  }
}
