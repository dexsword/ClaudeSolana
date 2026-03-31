import axios from 'axios';
import { SolanaBotV1TickNotification, TradeRecord } from './sharedTypes';

export interface NotificationConfig {
  enabled: boolean;
  webhookUrl: string;
  type: 'discord' | 'telegram';
  telegramBotToken?: string;
  telegramChatId?: string;
}

export class Notifier {
  private cfg: NotificationConfig;
  private warnedMisconfigured = false;

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

  async sendTickNotification(tick: SolanaBotV1TickNotification): Promise<void> {
    if (!this.cfg.enabled) return;

    const emojiByAction: Record<SolanaBotV1TickNotification['action'], string> = {
      HOLD: '⏸️',
      BUY: '🟢',
      SELL: '🔴',
      BOOTSTRAP_SELL: '🟡',
      HALT: '⛔',
      COOLDOWN: '🕒',
      SKIP_IMPACT: '⚠️',
    };
    const emoji = emojiByAction[tick.action] ?? '❓';

    const fmtNum = (v: number | null, digits: number = 2): string => (v === null ? 'n/a' : v.toFixed(digits));
    const fmtPct = (v: number | null, digits: number = 2): string => (v === null ? 'n/a' : `${v.toFixed(digits)}%`);
    const fmtMin = (v: number | null): string => (v === null ? 'n/a' : `${v.toFixed(0)}m`);
    const fmtLine = (l: { label: string; pass: boolean; detail: string }): string => `${l.pass ? '✅' : '❌'} ${l.label}: ${l.detail}`;

    const ts = new Date(tick.ts).toISOString().slice(0, 19).replace('T', ' ');
    const rsiLine = tick.rsi === null ? 'RSI n/a' : `RSI ${tick.rsi.toFixed(1)} (${tick.rsiDirection})`;
    const vwapLine = tick.vwapDevPct === null
      ? 'VWAP dev n/a'
      : `VWAP dev ${tick.vwapDevPct.toFixed(2)}% (need <= -${fmtNum(tick.requiredDevPct, 2)}%)`;
    const emaLine = `EMA50 ${fmtPct(tick.emaTrendPct, 2)} | slope ${fmtPct(tick.emaSlopePct, 3)}`;
    const atrLine = `ATR ${fmtPct(tick.atrPct, 2)}`;

    const pos = tick.position;
    const posLine = pos.inPosition
      ? `IN (${pos.entryAssumed ? 'assumed' : 'tracked'}) entry $${fmtNum(pos.entryPrice, 4)} | U/PnL ${fmtPct(pos.unrealizedPct, 2)} | hold ${fmtMin(pos.holdMinutes)} | SOL% ${pos.solPct.toFixed(1)}%`
      : `OUT | SOL% ${pos.solPct.toFixed(1)}%`;

    const risk = tick.risk;
    const riskLine = `dayPnL ${risk.dayPnlPct.toFixed(2)}% | trades ${risk.tradesToday}/${risk.maxDailyTrades} | impactSkips ${risk.impactSkipsToday} | cooldown ${risk.cooldownRemainingMin ?? 0}m | halt ${risk.dailyHalt ? 'YES' : 'no'}`;

    const message = [
      `${emoji} **${tick.action}** (SolanaBotV1 ${tick.timeframe}, ${tick.mode}) — \`${ts}\``,
      `Price: $${tick.price.toFixed(4)} | ${rsiLine} | ${vwapLine}`,
      `${emaLine} | ${atrLine}`,
      `Position: ${posLine}`,
      `Risk: ${riskLine}`,
      '',
      '**Gates**',
      ...tick.checklist.gates.map(fmtLine),
      '',
      '**Entry Checklist**',
      ...tick.checklist.entry.map(fmtLine),
      '',
      '**Exit Checklist**',
      ...tick.checklist.exit.map(fmtLine),
      '',
      `Decision: ${tick.decisionReason}`,
    ].join('\n');

    await this.send(message);
  }

  async sendAlert(message: string): Promise<void> {
    if (!this.cfg.enabled) return;
    await this.send(`⚠️ **ALERT**\n${message}`);
  }

  private async send(text: string): Promise<void> {
    try {
      if (this.cfg.type === 'discord') {
        if (!this.cfg.webhookUrl) {
          if (!this.warnedMisconfigured) {
            this.warnedMisconfigured = true;
            console.warn('[Notifier] notifications.enabled=true but DISCORD_WEBHOOK_URL/webhookUrl is empty; skipping Discord sends');
          }
          return;
        }

        // Discord hard-limits messages to 2000 chars. Keep a buffer for safety.
        const maxLen = 1_900;
        const chunks = splitByLines(text, maxLen);
        if (chunks.length === 1) {
          await axios.post(this.cfg.webhookUrl, { content: chunks[0] }, { timeout: 8000 });
          return;
        }

        for (let i = 0; i < chunks.length; i++) {
          const prefix = `(${i + 1}/${chunks.length}) `;
          const body = chunks[i];
          await axios.post(this.cfg.webhookUrl, { content: `${prefix}${body}` }, { timeout: 8000 });
        }
      } else if (this.cfg.type === 'telegram') {
        const token = this.cfg.telegramBotToken ?? process.env.TELEGRAM_BOT_TOKEN;
        const chatId = this.cfg.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
        if (!token || !chatId) {
          if (!this.warnedMisconfigured) {
            this.warnedMisconfigured = true;
            console.warn('[Notifier] notifications.enabled=true but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing; skipping Telegram sends');
          }
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

function splitByLines(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const lines = text.split('\n');
  const out: string[] = [];
  let cur = '';

  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length <= maxLen) {
      cur = next;
      continue;
    }

    if (cur) out.push(cur);

    // If a single line is too long, hard-split it.
    if (line.length > maxLen) {
      for (let i = 0; i < line.length; i += maxLen) {
        out.push(line.slice(i, i + maxLen));
      }
      cur = '';
      continue;
    }

    cur = line;
  }

  if (cur) out.push(cur);
  return out;
}
