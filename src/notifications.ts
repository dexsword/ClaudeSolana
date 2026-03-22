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
    const zone = trade.zone ? ` [${trade.zone}]` : '';
    const pnlLine = trade.pnl !== null
      ? trade.avgEntryAtSell != null
        ? `\nAvg Entry: $${trade.avgEntryAtSell.toFixed(4)} | P&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`
        : `\nP&L: ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`
      : '';

    const message = [
      `${emoji} ${mode}**${trade.action.toUpperCase()}${zone}**`,
      `Price: $${trade.price.toFixed(4)}`,
      `SOL: ${trade.solAmount.toFixed(4)} | USDC: $${trade.usdcAmount.toFixed(2)}`,
      `RSI: ${trade.rsi?.toFixed(1) ?? 'N/A'} | VWAP: $${trade.vwap?.toFixed(4) ?? 'N/A'}`,
      `Trend: ${trade.trendBias}`,
      `Reason: ${trade.reason}${pnlLine}`,
      trade.txSignature ? `TX: \`${trade.txSignature}\`` : '',
    ].filter(Boolean).join('\n');

    await this.send(message);
  }

  async sendSignalNotification(signal: StrategySignal, avgEntry: number | null = null): Promise<void> {
    if (!this.cfg.enabled) return;

    const actionEmoji: Record<string, string> = {
      hold: '⏸️',
      bootstrap: '🚀',
      rebalance_buy: '🟢',
      rebalance_sell: '🟡',
      emergency_sell: '🔴',
    };
    const emoji = actionEmoji[signal.action] ?? '❓';

    const rsi = signal.rsi4h !== null ? `${signal.rsi4h.toFixed(1)} (${signal.rsiDirection})` : 'N/A';
    const vwapDev = signal.rsi4h !== null && signal.vwap4h !== null
      ? ` | VWAP dev: ${(((signal.price - signal.vwap4h) / signal.vwap4h) * 100).toFixed(1)}%`
      : '';
    const avgEntryLine = avgEntry != null && avgEntry > 0
      ? (() => {
          const pct = (signal.price - avgEntry) / avgEntry * 100;
          return `Avg Entry: $${avgEntry.toFixed(4)} | Unrealized: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        })()
      : '';

    const message = [
      `${emoji} **${signal.action.toUpperCase()}** — Zone: ${signal.zone} [${signal.trendBias}]`,
      `Price: $${signal.price.toFixed(4)} | RSI: ${rsi}${vwapDev}`,
      avgEntryLine,
      `Target: ${signal.targetSolPct}% SOL`,
      `Reason: ${signal.reason}`,
    ].filter(Boolean).join('\n');

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
