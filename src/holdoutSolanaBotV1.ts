import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { SolanaBotV1Config } from './typesSolanaBotV1';
import { fetchCryptoCompareHourlyCandlesRange } from './cryptoCompare';
import { BacktestCandle, runSolanaBotV1Backtest } from './solanaBotV1BacktestEngine';

function aggregateHourly(hourly: BacktestCandle[], hours: number): BacktestCandle[] {
  if (hours <= 1) return hourly;
  const out: BacktestCandle[] = [];
  for (let i = 0; i + hours <= hourly.length; i += hours) {
    const chunk = hourly.slice(i, i + hours);
    out.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  return out;
}

async function main(): Promise<void> {
  const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
  if (!CC_KEY) {
    console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const tfArg = args.find((a) => a.startsWith('--timeframe='))?.split('=')[1] ?? '1h';
  const daysArg = args.find((a) => a.startsWith('--days='))?.split('=')[1];
  const holdoutDaysArg = args.find((a) => a.startsWith('--holdout-days='))?.split('=')[1];
  const slipArg = args.find((a) => a.startsWith('--slippage='))?.split('=')[1];
  const feeArg = args.find((a) => a.startsWith('--fee='))?.split('=')[1];

  const timeframe = tfArg.trim().toLowerCase();
  const days = daysArg ? Math.max(365, parseInt(daysArg, 10)) : 1095;
  const holdoutDays = holdoutDaysArg ? Math.max(90, parseInt(holdoutDaysArg, 10)) : 365;
  const slippagePct = slipArg ? parseFloat(slipArg) : 0.003;
  const feePct = feeArg ? parseFloat(feeArg) : 0.0004;

  const tfMatch = timeframe.match(/^([0-9]+)\s*([mhd])$/);
  if (!tfMatch) throw new Error(`Invalid timeframe: ${timeframe}`);
  const n = parseInt(tfMatch[1], 10);
  const u = tfMatch[2];
  const tfMinutes = u === 'm' ? n : u === 'h' ? n * 60 : n * 1440;
  if (tfMinutes < 60) throw new Error('Holdout script supports >=1h only');
  const hours = Math.max(1, Math.round(tfMinutes / 60));

  const cfg: SolanaBotV1Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config-solana-bot-v1.json'), 'utf-8'));
  cfg.solanaBotV1.timeframe = timeframe;

  const END_MS = Date.now();
  const START_MS = END_MS - days * 24 * 60 * 60 * 1000;
  console.log(`Holdout test: tf=${timeframe} history=${days}d holdout=${holdoutDays}d slip=${(slippagePct * 100).toFixed(2)}% fee=${(feePct * 100).toFixed(3)}%`);

  const hourly = await fetchCryptoCompareHourlyCandlesRange({
    fsym: 'SOL',
    tsym: 'USD',
    startMs: START_MS,
    endMs: END_MS,
    apiKey: CC_KEY,
    sleepMsBetweenCalls: 350,
  });
  const candles = aggregateHourly(hourly, hours);

  const holdoutMs = holdoutDays * 24 * 60 * 60 * 1000;
  const holdoutStartTs = (candles[candles.length - 1]?.timestamp ?? END_MS) - holdoutMs;
  const holdout = candles.filter((c) => c.timestamp >= holdoutStartTs);

  console.log(`Candles total: ${candles.length} | Holdout candles: ${holdout.length}`);

  const res = runSolanaBotV1Backtest(holdout, cfg, { startingCapitalUSDC: 100, slippagePct, feePct });
  const m = res.metrics;
  console.log(`Holdout results: Ann ${m.annualizedReturnPct.toFixed(2)}% | Ret ${m.totalReturnPct.toFixed(2)}% | MDD ${m.maxDrawdownPct.toFixed(2)}% | Sharpe ${m.sharpe.toFixed(2)} | Trades ${m.closedTrades} | PF ${m.profitFactor.toFixed(2)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
