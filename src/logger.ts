import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { TradeRecord } from './types';

export class TradeLogger {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     INTEGER NOT NULL,
        action        TEXT    NOT NULL,
        side          TEXT    NOT NULL,
        sol_amount    REAL    NOT NULL,
        usdc_amount   REAL    NOT NULL,
        price         REAL    NOT NULL,
        tier          INTEGER,
        tx_signature  TEXT,
        dry_run       INTEGER NOT NULL DEFAULT 0,
        reason        TEXT    NOT NULL,
        rsi           REAL,
        vwap          REAL,
        sma           REAL,
        trend_bias    TEXT,
        pnl           REAL,
        created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS signals (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   INTEGER NOT NULL,
        action      TEXT    NOT NULL,
        reason      TEXT    NOT NULL,
        price       REAL    NOT NULL,
        rsi_4h      REAL,
        vwap_4h     REAL,
        sma_3d      REAL,
        trend_bias  TEXT,
        executed    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS bot_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
    `);
  }

  logTrade(record: TradeRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades
        (timestamp, action, side, sol_amount, usdc_amount, price, tier,
         tx_signature, dry_run, reason, rsi, vwap, sma, trend_bias, pnl)
      VALUES
        (@timestamp, @action, @side, @sol_amount, @usdc_amount, @price, @tier,
         @tx_signature, @dry_run, @reason, @rsi, @vwap, @sma, @trend_bias, @pnl)
    `);

    const result = stmt.run({
      timestamp: record.timestamp,
      action: record.action,
      side: record.side,
      sol_amount: record.solAmount,
      usdc_amount: record.usdcAmount,
      price: record.price,
      tier: record.tier ?? null,
      tx_signature: record.txSignature ?? null,
      dry_run: record.dryRun ? 1 : 0,
      reason: record.reason,
      rsi: record.rsi ?? null,
      vwap: record.vwap ?? null,
      sma: record.sma ?? null,
      trend_bias: record.trendBias,
      pnl: record.pnl ?? null,
    });

    return result.lastInsertRowid as number;
  }

  logSignal(signal: {
    timestamp: number;
    action: string;
    reason: string;
    price: number;
    rsi4h: number | null;
    vwap4h: number | null;
    sma3d: number | null;
    trendBias: string;
    executed: boolean;
  }): void {
    this.db.prepare(`
      INSERT INTO signals (timestamp, action, reason, price, rsi_4h, vwap_4h, sma_3d, trend_bias, executed)
      VALUES (@timestamp, @action, @reason, @price, @rsi4h, @vwap4h, @sma3d, @trendBias, @executed)
    `).run({
      timestamp: signal.timestamp,
      action: signal.action,
      reason: signal.reason,
      price: signal.price,
      rsi4h: signal.rsi4h ?? null,
      vwap4h: signal.vwap4h ?? null,
      sma3d: signal.sma3d ?? null,
      trendBias: signal.trendBias,
      executed: signal.executed ? 1 : 0,
    });
  }

  saveState(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO bot_state (key, value, updated_at)
      VALUES (@key, @value, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = datetime('now')
    `).run({ key, value: JSON.stringify(value) });
  }

  loadState<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  getRecentTrades(limit: number = 20): TradeRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      timestamp: r.timestamp as number,
      action: r.action as string,
      side: r.side as 'buy' | 'sell',
      solAmount: r.sol_amount as number,
      usdcAmount: r.usdc_amount as number,
      price: r.price as number,
      tier: r.tier as number | null,
      txSignature: r.tx_signature as string | null,
      dryRun: Boolean(r.dry_run),
      reason: r.reason as string,
      rsi: r.rsi as number | null,
      vwap: r.vwap as number | null,
      sma: r.sma as number | null,
      trendBias: r.trend_bias as string,
      pnl: r.pnl as number | null,
    }));
  }

  getTotalPnl(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL').get() as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}
