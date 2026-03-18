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

    this.client.on('messageCreate', (msg: Message) => this.handleMessage(msg));
    this.client.on('ready', () => {
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
          await msg.reply(this.buildLastSignal());
          break;
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

    const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number; totalValueUSDC: number; updatedAt: number }>('balances');
    const pos = this.logger.loadState<PositionState>('position');
    const hwm = this.logger.loadState<number>('portfolioHWM');

    // Use position.solBalance (updated after every trade) rather than bal.solBalance
    // (only updated at tick start, so stale immediately post-trade).
    const solBalance = pos?.bootstrapDone ? pos.solBalance : (bal?.solBalance ?? 0);
    const usdcBalance = bal?.usdcBalance ?? 0;
    // Re-derive total using the live SOL figure + cached USDC + implied SOL price
    const impliedSolPrice = bal && bal.solBalance > 0 ? (bal.totalValueUSDC - bal.usdcBalance) / bal.solBalance : 0;
    const totalValueUSDC = bal ? solBalance * impliedSolPrice + usdcBalance : 0;

    const balLine = bal
      ? `SOL: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)} | Total: ~$${totalValueUSDC.toFixed(2)}`
      : 'Balance: not yet fetched';
    const hwmLine = hwm ? ` | Peak: $${hwm.toFixed(2)}` : '';
    const balAge = bal ? ` *(as of ${new Date(bal.updatedAt).toISOString().slice(11, 16)} UTC)*` : '';

    return [
      '🤖 **Bot Status**',
      `Status: 🟢 Online`,
      `Network: ${this.cfg.network}${mode}`,
      `Uptime: ${uptime}`,
      `${balLine}${hwmLine}${balAge}`,
    ].join('\n');
  }

  private buildPosition(): string {
    const pos = this.logger.loadState<PositionState>('position');
    if (!pos) return '📊 **Position**\nNo position data yet — bot hasn\'t run a cycle.';

    if (!pos.bootstrapDone) {
      return '📊 **Position**\n⏳ Not bootstrapped — waiting for RSI < 62 to buy initial 50% SOL';
    }

    // Derive current SOL% from saved balance snapshot
    const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number; totalValueUSDC: number; updatedAt: number }>('balances');
    let allocationLine = '';
    if (bal && bal.solBalance > 0) {
      // Derive approximate SOL price from balance snapshot
      const derivedPrice = (bal.totalValueUSDC - bal.usdcBalance) / bal.solBalance;
      const managedSolUSDC = pos.solBalance * derivedPrice;
      const totalManaged = managedSolUSDC + bal.usdcBalance;
      const currentSolPct = totalManaged > 0 ? (managedSolUSDC / totalManaged) * 100 : 0;
      allocationLine = `\nAllocation: ${currentSolPct.toFixed(1)}% SOL / ${(100 - currentSolPct).toFixed(1)}% USDC`;
    }

    const trailingStop = pos.trailingStopActive && pos.trailingStopPrice
      ? `\nTrailing stop: $${pos.trailingStopPrice.toFixed(4)} (HWM: $${pos.highWaterMark.toFixed(4)})`
      : '';

    const cooldown = pos.cooldownUntil && pos.cooldownUntil > Date.now()
      ? `\nCooldown expires: ${new Date(pos.cooldownUntil).toUTCString()}`
      : '';

    return [
      '📊 **Position**',
      `Status: 🟢 Active`,
      `SOL held: ${pos.solBalance.toFixed(4)} SOL`,
      `Avg entry: $${pos.averageEntryPrice.toFixed(4)}${allocationLine}${trailingStop}${cooldown}`,
    ].join('\n');
  }

  private buildTrades(n: number): string {
    const trades = this.logger.getRecentTrades(n);
    if (trades.length === 0) return '📋 **Recent Trades**\nNo trades recorded yet.';

    const lines = trades.map((t) => {
      const emoji = t.side === 'buy' ? '🟢' : '🔴';
      const zone = t.zone ? ` [${t.zone}]` : '';
      const pnl = t.pnl !== null ? ` | P&L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}` : '';
      const dry = t.dryRun ? ' *(dry)*' : '';
      const date = new Date(t.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      return `${emoji} \`${date}\` **${t.action.toUpperCase()}${zone}**${dry} @ $${t.price.toFixed(4)} · ${t.solAmount.toFixed(3)} SOL${pnl}`;
    });

    return `📋 **Last ${trades.length} Trade(s)**\n${lines.join('\n')}`;
  }

  private buildLastSignal(): string {
    const sig = this.logger.getLastSignal();
    if (!sig) return '🔍 **Last Signal**\nNo signals recorded yet — bot hasn\'t run a cycle.';

    const actionEmoji: Record<string, string> = {
      hold: '⏸️',
      bootstrap: '🚀',
      rebalance_buy: '🟢',
      rebalance_sell: '🟡',
      emergency_sell: '🔴',
    };
    const emoji = actionEmoji[sig.action] ?? '❓';
    const executed = sig.executed ? ' ✅ executed' : ' — held';
    const date = new Date(sig.timestamp).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

    const rsi = sig.rsi4h !== null ? sig.rsi4h.toFixed(1) : 'n/a';
    const vwap = sig.vwap4h !== null ? `$${sig.vwap4h.toFixed(4)}` : 'n/a';
    const sma = sig.sma3d !== null ? `$${sig.sma3d.toFixed(4)}` : 'n/a';

    return [
      '🔍 **Last Signal**',
      `${emoji} **${sig.action.toUpperCase()}**${executed}`,
      `Trend: ${sig.trendBias}`,
      `Price: $${sig.price.toFixed(4)}`,
      `RSI(4h): ${rsi}  |  VWAP: ${vwap}  |  SMA(3d): ${sma}`,
      `Reason: *${sig.reason}*`,
      `Time: ${date}`,
    ].join('\n');
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
      '`!solbot status` — online status, network, uptime, wallet balances',
      '`!solbot position` — SOL allocation, avg entry, trailing stop',
      '`!solbot last` — last signal (zone, RSI, VWAP, reason)',
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
