import { Client, GatewayIntentBits, Message } from 'discord.js';
import { TradeLogger } from './logger';
import { PositionState } from './types';

export interface DiscordCommandsConfig {
  botToken: string;
  dryRun: boolean;
  network: string;
  startTime: Date;
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

    this.client.on('messageCreate', (msg) => this.handleMessage(msg));
    this.client.on('ready', () => {
      console.log(`[Discord] Command bot logged in as ${this.client.user?.tag}`);
    });
    this.client.on('error', (err) => {
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
        case 'pnl':
          await msg.reply(this.buildPnl());
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
    return [
      '🤖 **Bot Status**',
      `Status: 🟢 Online`,
      `Network: ${this.cfg.network}${mode}`,
      `Uptime: ${uptime}`,
    ].join('\n');
  }

  private buildPosition(): string {
    const pos = this.logger.loadState<PositionState>('position');
    if (!pos) return '📊 **Position**\nNo position data yet — bot hasn\'t run a cycle.';

    if (!pos.inPosition) {
      const cooldown =
        pos.cooldownUntil && pos.cooldownUntil > Date.now()
          ? `\nCooldown expires: ${new Date(pos.cooldownUntil).toUTCString()}`
          : '';
      return `📊 **Position**\nStatus: ⬜ No active position${cooldown}`;
    }

    const tiers: string[] = [];
    if (pos.tiers.tier1Filled) tiers.push(`T1 @ $${pos.tiers.tier1EntryPrice?.toFixed(4)}`);
    if (pos.tiers.tier2Filled) tiers.push(`T2 @ $${pos.tiers.tier2EntryPrice?.toFixed(4)}`);
    if (pos.tiers.tier3Filled) tiers.push(`T3 @ $${pos.tiers.tier3EntryPrice?.toFixed(4)}`);

    const trailingStop =
      pos.trailingStopActive && pos.trailingStopPrice
        ? `\nTrailing stop: $${pos.trailingStopPrice.toFixed(4)}`
        : '';

    const partialExit = pos.partialExitDone ? '\nPartial exit: ✅ done' : '';

    return [
      '📊 **Position**',
      `Status: 🟢 In position`,
      `SOL held: ${pos.solBalance.toFixed(4)} SOL`,
      `Avg entry: $${pos.averageEntryPrice.toFixed(4)}`,
      `Tiers filled: ${tiers.join(', ')}`,
      `High water mark: $${pos.highWaterMark.toFixed(4)}${trailingStop}${partialExit}`,
    ].join('\n');
  }

  private buildTrades(n: number): string {
    const trades = this.logger.getRecentTrades(n);
    if (trades.length === 0) return '📋 **Recent Trades**\nNo trades recorded yet.';

    const lines = trades.map((t) => {
      const emoji = t.side === 'buy' ? '🟢' : '🔴';
      const tier = t.tier ? ` T${t.tier}` : '';
      const pnl = t.pnl !== null ? ` | P&L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '';
      const dry = t.dryRun ? ' *(dry)*' : '';
      const date = new Date(t.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `${emoji} \`${date}\` **${t.action.toUpperCase()}${tier}**${dry} @ $${t.price.toFixed(4)} · ${t.solAmount.toFixed(3)} SOL${pnl}`;
    });

    return `📋 **Last ${trades.length} Trade(s)**\n${lines.join('\n')}`;
  }

  private buildPnl(): string {
    const total = this.logger.getTotalPnl();
    const emoji = total >= 0 ? '📈' : '📉';
    const sign = total >= 0 ? '+' : '';
    return `${emoji} **Realized P&L**\nTotal: **${sign}$${total.toFixed(2)} USDC**`;
  }

  private buildHelp(): string {
    return [
      '**SolBot Commands**',
      '`!solbot status` — online status, network, uptime',
      '`!solbot position` — current position & tiers',
      '`!solbot trades [n]` — last N trades (default 5, max 20)',
      '`!solbot pnl` — total realized P&L',
      '`!solbot help` — this message',
    ].join('\n');
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
