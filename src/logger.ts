import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { TradeRecord } from './sharedTypes';

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
        pnl                REAL,
        avg_entry_at_sell  REAL,
        created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
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

    // Add zone column to trades if it doesn't exist yet (migration from tier-based schema)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN zone TEXT`);
    } catch {
      // Column already exists — ignore
    }
    // Add avg_entry_at_sell column (migration for existing installs)
    try {
      this.db.exec(`ALTER TABLE trades ADD COLUMN avg_entry_at_sell REAL`);
    } catch {
      // Column already exists — ignore
    }
  }

  logTrade(record: TradeRecord): number {
    const stmt = this.db.prepare(`
      INSERT INTO trades
        (timestamp, action, side, sol_amount, usdc_amount, price, zone,
         tx_signature, dry_run, reason, rsi, vwap, sma, trend_bias, pnl, avg_entry_at_sell)
      VALUES
        (@timestamp, @action, @side, @sol_amount, @usdc_amount, @price, @zone,
         @tx_signature, @dry_run, @reason, @rsi, @vwap, @sma, @trend_bias, @pnl, @avg_entry_at_sell)
    `);

    const result = stmt.run({
      timestamp: record.timestamp,
      action: record.action,
      side: record.side,
      sol_amount: record.solAmount,
      usdc_amount: record.usdcAmount,
      price: record.price,
      zone: record.zone ?? null,
      tx_signature: record.txSignature ?? null,
      dry_run: record.dryRun ? 1 : 0,
      reason: record.reason,
      rsi: record.rsi ?? null,
      vwap: record.vwap ?? null,
      sma: record.sma ?? null,
      trend_bias: record.trendBias,
      pnl: record.pnl ?? null,
      avg_entry_at_sell: record.avgEntryAtSell ?? null,
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
      zone: (r.zone ?? null) as string | null,
      txSignature: r.tx_signature as string | null,
      dryRun: Boolean(r.dry_run),
      reason: r.reason as string,
      rsi: r.rsi as number | null,
      vwap: r.vwap as number | null,
      sma: r.sma as number | null,
      trendBias: r.trend_bias as string,
      pnl: r.pnl as number | null,
      avgEntryAtSell: (r.avg_entry_at_sell ?? null) as number | null,
    }));
  }

  getLastSignal(): { action: string; reason: string; price: number; rsi4h: number | null; vwap4h: number | null; sma3d: number | null; trendBias: string; executed: boolean; timestamp: number } | null {
    const row = this.db.prepare(
      'SELECT * FROM signals ORDER BY timestamp DESC LIMIT 1',
    ).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      action: row.action as string,
      reason: row.reason as string,
      price: row.price as number,
      rsi4h: row.rsi_4h as number | null,
      vwap4h: row.vwap_4h as number | null,
      sma3d: row.sma_3d as number | null,
      trendBias: row.trend_bias as string,
      executed: Boolean(row.executed),
      timestamp: row.timestamp as number,
    };
  }

  getTotalPnl(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL').get() as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}
