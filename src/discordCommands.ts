import { Client, GatewayIntentBits, Message } from 'discord.js';
import { TradeLogger } from './logger';
import { PositionState } from './types';

export interface DiscordCommandsConfig {
  botToken: string;
  dryRun: boolean;
  network: string;
  startTime: Date;
  botId: string;  // 'bot1' or 'bot2'
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
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2 (Mean Reversion)' : 'Bot #1 (Swing)';

    const stateKey = this.cfg.botId === 'bot2' ? 'bot2_state' : 'balances';
    const hwmKey = this.cfg.botId === 'bot2' ? 'bot2_state' : 'portfolioHWM';
    
    const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number; totalValueUSDC: number; updatedAt: number }>(stateKey);
    const pos = this.cfg.botId === 'bot1' ? this.logger.loadState<PositionState>('position') : null;
    const bot2State = this.cfg.botId === 'bot2' ? this.logger.loadState<{ highWaterMark: number }>(hwmKey) : null;

    const solBalance = bal?.solBalance ?? 0;
    const usdcBalance = bal?.usdcBalance ?? 0;
    const totalValueUSDC = bal ? solBalance * 82 + usdcBalance : 0;  // Approx
    const hwm = bot2State?.highWaterMark ?? (this.cfg.botId === 'bot1' ? this.logger.loadState<number>('portfolioHWM') : null);

    const balLine = bal
      ? `SOL: ${solBalance.toFixed(4)} | USDC: $${usdcBalance.toFixed(2)} | Total: ~$${totalValueUSDC.toFixed(2)}`
      : 'Balance: not yet fetched';
    const hwmLine = hwm ? ` | Peak: $${hwm.toFixed(2)}` : '';
    const balAge = bal?.updatedAt ? ` *(as of ${new Date(bal.updatedAt).toISOString().slice(11, 16)} UTC)*` : '';

    return [
      `🤖 **${botName} Status**`,
      `Status: 🟢 Online`,
      `Network: ${this.cfg.network}${mode}`,
      `Uptime: ${uptime}`,
      `${balLine}${hwmLine}${balAge}`,
    ].join('\n');
  }

  private buildPosition(): string {
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2' : 'Bot #1';
    
    if (this.cfg.botId === 'bot2') {
      const state = this.logger.loadState<{ highWaterMark: number; solBalance: number; usdcBalance: number }>('bot2_state');
      if (!state) return `📊 **${botName} Position**\nNo position data yet.`;
      
      const solBalance = state.solBalance ?? 0;
      const usdcBalance = state.usdcBalance ?? 0;
      const hwm = state.highWaterMark ?? 0;
      const currentPrice = 82; // Approx
      const total = solBalance * currentPrice + usdcBalance;
      const solPct = total > 0 ? (solBalance * currentPrice / total) * 100 : 0;
      const pnl = total - hwm;
      const pnlLine = hwm > 0 ? `\nPnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (Peak: $${hwm.toFixed(2)})` : '';
      
      return [
        `📊 **${botName} Position**`,
        `Status: 🟢 Active`,
        `SOL held: ${solBalance.toFixed(4)}`,
        `USDC: $${usdcBalance.toFixed(2)}`,
        `Allocation: ${solPct.toFixed(1)}% SOL / ${(100 - solPct).toFixed(1)}% USDC${pnlLine}`,
      ].join('\n');
    }

    // Bot #1 original logic
    const pos = this.logger.loadState<PositionState>('position');
    if (!pos) return '📊 **Bot #1 Position**\nNo position data yet — bot hasn\'t run a cycle.';

    if (!pos.bootstrapDone) {
      return '📊 **Bot #1 Position**\n⏳ Not bootstrapped — waiting for RSI < 62 to buy initial 50% SOL';
    }

    const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number; totalValueUSDC: number }>('balances');
    let allocationLine = '';
    if (bal && bal.solBalance > 0) {
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
      '📊 **Bot #1 Position**',
      `Status: 🟢 Active`,
      `SOL held: ${pos.solBalance.toFixed(4)} SOL`,
      `Avg entry: $${pos.averageEntryPrice.toFixed(4)}${allocationLine}${trailingStop}${cooldown}`,
    ].join('\n');
  }

  private buildTrades(n: number): string {
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2' : 'Bot #1';
    let trades = this.logger.getRecentTrades(n);
    
    // Filter by bot
    if (this.cfg.botId === 'bot2') {
      trades = trades.filter(t => t.zone === 'Bot2-mean-rev');
    }
    
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

  private buildLastSignal(): string {
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2' : 'Bot #1';
    
    if (this.cfg.botId === 'bot2') {
      // Bot #2 - get last trade instead of signal
      const trades = this.logger.getRecentTrades(1);
      const bot2Trades = trades.filter(t => t.zone === 'Bot2-mean-rev');
      if (bot2Trades.length === 0) return `🔍 **${botName} Last Signal**\nNo trades yet.`;
      
      const t = bot2Trades[0];
      const emoji = t.side === 'buy' ? '🟢' : '🔴';
      const date = new Date(t.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      
      return [
        `🔍 **${botName} Last Trade**`,
        `${emoji} **${t.action.toUpperCase()}**`,
        `Price: $${t.price.toFixed(4)}`,
        `RSI: ${t.rsi?.toFixed(1) ?? 'N/A'} | VWAP: ${t.vwap ? '$'+t.vwap.toFixed(2) : 'N/A'}`,
        `Reason: ${t.reason}`,
        `Time: ${date}`,
      ].join('\n');
    }
    
    // Bot #1 - original signal logic
    const sig = this.logger.getLastSignal();
    if (!sig) return `🔍 **${botName} Last Signal**\nNo signals recorded yet.`;

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
      `🔍 **${botName} Last Signal**`,
      `${emoji} **${sig.action.toUpperCase()}**${executed}`,
      `Trend: ${sig.trendBias}`,
      `Price: $${sig.price.toFixed(4)}`,
      `RSI(4h): ${rsi}  |  VWAP: ${vwap}  |  SMA(3d): ${sma}`,
      `Reason: *${sig.reason}*`,
      `Time: ${date}`,
    ].join('\n');
  }

  private buildAvg(): string {
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2' : 'Bot #1';
    
    if (this.cfg.botId === 'bot2') {
      const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number }>('bot2_state');
      const solBalance = bal?.solBalance ?? 0;
      const usdcBalance = bal?.usdcBalance ?? 0;
      if (solBalance < 0.01) {
        return `📊 **${botName} Avg Entry**\nNo active position.`;
      }
      return [
        `📊 **${botName} Avg Entry**`,
        `Holding: ${solBalance.toFixed(4)} SOL`,
        `USDC: $${usdcBalance.toFixed(2)}`,
        `Avg entry: N/A (mean-reversion)`,
      ].join('\n');
    }
    
    // Bot #1 original logic
    const pos = this.logger.loadState<PositionState>('position');
    if (!pos?.bootstrapDone || pos.averageEntryPrice <= 0) {
      return '📊 **Bot #1 Avg Entry**\nNo active position.';
    }
    const bal = this.logger.loadState<{ solBalance: number; usdcBalance: number; totalValueUSDC: number }>('balances');
    const impliedPrice = bal && bal.solBalance > 0
      ? (bal.totalValueUSDC - bal.usdcBalance) / bal.solBalance
      : null;
    const unrealLine = impliedPrice != null
      ? (() => {
          const pct = (impliedPrice - pos.averageEntryPrice) / pos.averageEntryPrice * 100;
          const usdcGain = (impliedPrice - pos.averageEntryPrice) * pos.solBalance;
          return `\nUnrealized: ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% (${usdcGain >= 0 ? '+' : ''}$${usdcGain.toFixed(2)}) vs last tick $${impliedPrice.toFixed(4)}`;
        })()
      : '';
    return [
      '📊 **Bot #1 Avg Entry**',
      `Avg entry: $${pos.averageEntryPrice.toFixed(4)}`,
      `Holding: ${pos.solBalance.toFixed(4)} SOL${unrealLine}`,
    ].join('\n');
  }

  private buildPnl(): string {
    const botName = this.cfg.botId === 'bot2' ? 'Bot #2' : 'Bot #1';
    
    // Get PnL filtered by bot
    let trades = this.logger.getRecentTrades(100);
    if (this.cfg.botId === 'bot2') {
      trades = trades.filter(t => t.zone === 'Bot2-mean-rev');
    } else {
      trades = trades.filter(t => t.zone !== 'Bot2-mean-rev');
    }
    
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
