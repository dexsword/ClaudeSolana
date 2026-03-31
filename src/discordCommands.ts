import { Client, Events, GatewayIntentBits, Message } from 'discord.js';
import { TradeLogger } from './logger';
import type { SolanaBotV1TickNotification } from './sharedTypes';
import type { SolanaBotV1Position } from './typesSolanaBotV1';

export interface DiscordCommandsConfig {
  botToken: string;
  dryRun: boolean;
  network: string;
  startTime: Date;
  botId: string;  // 'solanaBotV1'
}

export class DiscordCommands {
  private client: Client;
  private logger: TradeLogger;
  private cfg: DiscordCommandsConfig;

  constructor(cfg: DiscordCommandsConfig, logger: TradeLogger) {
    this.cfg = cfg;
    this.logger = logger;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('messageCreate', (msg: Message) => this.handleMessage(msg));
    this.client.once(Events.ClientReady, () => {
      console.log(`[Discord] Command bot logged in as ${this.client.user?.tag}`);
    });
    this.client.on('error', (err: Error) => {
      console.warn('[Discord] Client error:', err.message);
    });
  }

  async start(): Promise<void> {
    await this.client.login(this.cfg.botToken);
  }

  destroy(): void {
    this.client.destroy();
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (msg.author.bot) return;
    if (!msg.content.trim().startsWith('!solbot')) return;

    const parts = msg.content.trim().split(/\s+/);
    const command = parts[1]?.toLowerCase();

    try {
      switch (command) {
        case 'status':
          await msg.reply(this.buildStatus());
          break;
        case 'position':
          await msg.reply(this.buildPosition());
          break;
        case 'trades': {
          const n = parseInt(parts[2] ?? '5', 10);
          await msg.reply(this.buildTrades(isNaN(n) ? 5 : Math.min(n, 20)));
          break;
        }
        case 'last':
          await msg.reply(this.buildLastTick());
          break;
        case 'pnl':
          await msg.reply(this.buildPnl());
          break;
        case 'avg':
          await msg.reply(this.buildAvg());
          break;
        case 'help':
        case undefined:
          await msg.reply(this.buildHelp());
          break;
        default:
          await msg.reply(`Unknown command \`${command}\`. Use \`!solbot help\` to see available commands.`);
      }
    } catch (err) {
      console.warn('[Discord] Command handler error:', (err as Error).message);
    }
  }

  private buildStatus(): string {
    const uptime = this.formatUptime(Date.now() - this.cfg.startTime.getTime());
    const mode = this.cfg.dryRun ? ' [DRY RUN]' : '';
    const botName = 'SolanaBotV1';

    const bal =
      this.logger.loadState<{ solBalance: number; usdcBalance: number }>('solanaBotV1_state');
    const botState =
      this.logger.loadState<{ highWaterMark: number }>('solanaBotV1_state');

    const lastTick = this.loadLastTick();
    const lastPrice = lastTick?.price ?? null;
    const solBalance = bal?.solBalance ?? 0;
    const usdcBalance = bal?.usdcBalance ?? 0;
    const totalValueUSDC = bal && lastPrice ? solBalance * lastPrice + usdcBalance : 0;
    const hwm = botState?.highWaterMark ?? null;

    const balLine = bal
      ? lastPrice
        ? `SOL: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)} | Total: ~$${totalValueUSDC.toFixed(2)} (px $${lastPrice.toFixed(2)})`
        : `SOL: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)} | Total: n/a (no price yet)`
      : 'Balance: not yet fetched';
    const hwmLine = hwm ? ` | Peak: $${hwm.toFixed(2)}` : '';
    const lastLine = lastTick
      ? `Last tick: ${new Date(lastTick.ts).toISOString().slice(0, 19).replace('T', ' ')} | ${lastTick.action} — ${lastTick.decisionReason}`
      : 'Last tick: n/a';

    return [
      `🤖 **${botName} Status**`,
      `Status: 🟢 Online`,
      `Network: ${this.cfg.network}${mode}`,
      `Uptime: ${uptime}`,
      `${balLine}${hwmLine}`,
      lastLine,
    ].join('\n');
  }

  private buildPosition(): string {
    const botName = 'SolanaBotV1';
    const state =
      this.logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('solanaBotV1_state');
    const pos =
      this.logger.loadState<SolanaBotV1Position>('solanaBotV1_position');
    const lastTick = this.loadLastTick();
    if (!state) return `📊 **${botName} Position**\nNo position data yet.`;

    const solBalance = state.solBalance ?? 0;
    const usdcBalance = state.usdcBalance ?? 0;
    const hwm = state.highWaterMark ?? 0;
    const currentPrice = lastTick?.price ?? null;
    const total = currentPrice ? solBalance * currentPrice + usdcBalance : 0;
    const solPct = (total > 0 && currentPrice !== null) ? (solBalance * currentPrice / total) * 100 : 0;
    const pnl = total - hwm;
    const pnlLine = hwm > 0 ? `\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (Peak: $${hwm.toFixed(2)})` : '';

    const entryLine = pos?.inPosition && pos.entryPrice
      ? (() => {
          const u = currentPrice ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : null;
          const holdMin = pos.entryTime ? Math.round((Date.now() - pos.entryTime) / 60000) : null;
          return `Entry: $${pos.entryPrice.toFixed(4)} (${pos.entryAssumed ? 'assumed' : 'tracked'}) | U/PnL: ${u === null ? 'n/a' : `${u >= 0 ? '+' : ''}${u.toFixed(2)}%`} | Hold: ${holdMin === null ? 'n/a' : `${holdMin}m`}`;
        })()
      : 'Entry: n/a';

    return [
      `📊 **${botName} Position**`,
      `Status: 🟢 Active`,
      `Price: ${currentPrice ? `$${currentPrice.toFixed(4)}` : 'n/a'}`,
      `SOL held: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)}`,
      `Allocation: ${total > 0 ? `${solPct.toFixed(1)}% SOL / ${(100 - solPct).toFixed(1)}% USDC` : 'n/a'}${pnlLine}`,
      entryLine,
    ].join('\n');
  }

  private buildTrades(n: number): string {
    const botName = 'SolanaBotV1';
    let trades = this.logger.getRecentTrades(n);

    trades = trades.filter((t) => t.zone === 'SolanaBotV1-mean-rev');
    
    if (trades.length === 0) return `📋 **${botName} Trades**\nNo trades recorded yet.`;

    const lines = trades.map((t) => {
      const emoji = t.side === 'buy' ? '🟢' : '🔴';
      const zone = t.zone ? ` [${t.zone}]` : '';
      const avgEntry = t.avgEntryAtSell != null ? ` avg@$${t.avgEntryAtSell.toFixed(2)}` : '';
      const pnl = t.pnl !== null ? ` | P&L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '';
      const dry = t.dryRun ? ' *(dry)*' : '';
      const date = new Date(t.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `${emoji} \`${date}\` **${t.action.toUpperCase()}${zone}**${dry} @ $${t.price.toFixed(4)} · ${t.solAmount.toFixed(3)} SOL${avgEntry}${pnl}`;
    });

    return `📋 **${botName} — Last ${trades.length} Trade(s)**\n${lines.join('\n')}`;
  }

  private buildLastTick(): string {
    const botName = 'SolanaBotV1';
    const lastTick = this.loadLastTick();
    if (!lastTick) return `🔍 **${botName} Last Tick**\nNo tick recorded yet.`;

    const date = new Date(lastTick.ts).toISOString().slice(0, 19).replace('T', ' ');
    const rsi = lastTick.rsi === null ? 'n/a' : `${lastTick.rsi.toFixed(1)} (${lastTick.rsiDirection})`;
    const vwapDev = lastTick.vwapDevPct === null ? 'n/a' : `${lastTick.vwapDevPct.toFixed(2)}%`;

    return [
      `🔍 **${botName} Last Tick**`,
      `Time: ${date}`,
      `Action: **${lastTick.action}**`,
      `Price: $${lastTick.price.toFixed(4)} | RSI: ${rsi} | VWAP dev: ${vwapDev}`,
      `Reason: ${lastTick.decisionReason}`,
    ].join('\n');
  }

  private buildAvg(): string {
    const botName = 'SolanaBotV1';

    const pos =
      this.logger.loadState<SolanaBotV1Position>('solanaBotV1_position');
    if (!pos?.inPosition || !pos.entryPrice) {
      return `📊 **${botName} Avg Entry**\nNo active position.`;
    }

    return [
      `📊 **${botName} Avg Entry**`,
      `Avg entry: $${pos.entryPrice.toFixed(4)} (${pos.entryAssumed ? 'assumed' : 'tracked'})`,
    ].join('\n');
  }

  private buildPnl(): string {
    const botName = 'SolanaBotV1';
    let trades = this.logger.getRecentTrades(100);

    trades = trades.filter((t) => t.zone === 'SolanaBotV1-mean-rev');
    
    const total = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const emoji = total >= 0 ? '📈' : '📉';
    const sign = total >= 0 ? '+' : '';
    return `${emoji} **${botName} Realized P&L**\nTotal: **${sign}$${total.toFixed(2)} USDC**`;
  }

  private buildHelp(): string {
    return [
      '**SolBot Commands**',
      '`!solbot status` — online status, balances, high water mark',
      '`!solbot position` — current SOL/USDC allocation',
      '`!solbot trades [n]` — last N trades (default 5, max 20)',
      '`!solbot pnl` — total realized P&L',
      '`!solbot last` — last tick summary',
      '`!solbot help` — this message',
    ].join('\n');
  }

  private loadLastTick(): SolanaBotV1TickNotification | null {
    return this.logger.loadState<SolanaBotV1TickNotification>('solanaBotV1_last_tick');
  }

  private formatUptime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const d = Math.floor(totalSeconds / 86400);
    const h = Math.floor((totalSeconds % 86400) / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s}s`;
  }
}
