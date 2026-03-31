import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

type Mapping = { from: string; to: string };

function parseArg(prefix: string): string | null {
  const v = process.argv.find((a) => a.startsWith(prefix));
  if (!v) return null;
  const parts = v.split('=');
  return parts.length >= 2 ? parts.slice(1).join('=').trim() : null;
}

function timestampForFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function ensureDbPath(): string {
  const argDb = parseArg('--db');
  if (argDb) return path.resolve(argDb);

  const envDb = process.env.DB_PATH;
  if (envDb) return path.resolve(envDb);

  const defaultDb = path.resolve(__dirname, '..', 'data', 'trades-solana-bot-v1.db');
  if (fs.existsSync(defaultDb)) return defaultDb;

  const legacyDb = path.resolve(__dirname, '..', 'data', 'trades-bot2.db');
  if (fs.existsSync(legacyDb)) return legacyDb;

  return defaultDb;
}

function main(): void {
  const dbPath = ensureDbPath();
  if (!fs.existsSync(dbPath)) {
    console.error(`[migrate] DB not found: ${dbPath}`);
    console.error('Usage: npx ts-node src/migrateBot2ToSolanaBotV1.ts --db=/absolute/or/relative/path/to/trades.db');
    process.exit(1);
  }

  const backupPath = `${dbPath}.bak-${timestampForFile()}`;
  fs.copyFileSync(dbPath, backupPath);
  console.log(`[migrate] Backup created: ${backupPath}`);

  const db = new Database(dbPath);
  try {
    const mappings: Mapping[] = [
      { from: 'bot2_state', to: 'solanaBotV1_state' },
      { from: 'bot2_risk', to: 'solanaBotV1_risk' },
      { from: 'bot2_skip_stats', to: 'solanaBotV1_skip_stats' },
      { from: 'bot2_position', to: 'solanaBotV1_position' },
      { from: 'bot2_last_tick', to: 'solanaBotV1_last_tick' },
    ];

    const zoneMappings: Array<{ from: string; to: string }> = [
      { from: 'Bot2-mean-rev', to: 'SolanaBotV1-mean-rev' },
    ];

    const tx = db.transaction(() => {
      // Migrate bot_state keys without overwriting existing SolanaBotV1 keys.
      const getVal = db.prepare('SELECT value FROM bot_state WHERE key = ?');
      const hasKey = db.prepare('SELECT 1 FROM bot_state WHERE key = ?');
      const insertKey = db.prepare(
        "INSERT INTO bot_state (key, value, updated_at) VALUES (@key, @value, datetime('now'))",
      );

      for (const m of mappings) {
        const existsTo = Boolean(hasKey.get(m.to));
        if (existsTo) {
          console.log(`[migrate] bot_state: keep existing ${m.to}`);
          continue;
        }

        const fromRow = getVal.get(m.from) as { value: string } | undefined;
        if (!fromRow) {
          console.log(`[migrate] bot_state: missing ${m.from} (skip)`);
          continue;
        }

        insertKey.run({ key: m.to, value: fromRow.value });
        console.log(`[migrate] bot_state: copied ${m.from} -> ${m.to}`);
      }

      // Rewrite historical zones to be consistent.
      const updateZone = db.prepare('UPDATE trades SET zone = @to WHERE zone = @from');
      for (const z of zoneMappings) {
        const info = updateZone.run({ from: z.from, to: z.to });
        console.log(`[migrate] trades.zone: ${z.from} -> ${z.to} (${info.changes} rows)`);
      }
    });

    tx();
    console.log(`[migrate] Done: ${dbPath}`);
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

main();
