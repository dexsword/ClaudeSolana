import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  CryptoCompareCandle,
  fetchCryptoCompareCandlesAggregatedMinutes,
} from './cryptoCompare';
import { SolanaBotV1Config } from './typesSolanaBotV1';
import { runSolanaBotV1Backtest } from './solanaBotV1BacktestEngine';

const args = process.argv.slice(2);
const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];
const slipArg = args.find(a => a.startsWith('--slippage='))?.split('=')[1];

const START_MS = fromArg ? new Date(fromArg).getTime() : Date.now() - 180 * 24 * 60 * 60 * 1000;
const END_MS = Date.now();
const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';

if (!CC_KEY) {
  console.error('ERROR: CRYPTOCOMPARE_API_KEY not set');
  process.exit(1);
}

const SLIPPAGE = slipArg ? parseFloat(slipArg) / 100 : 0.002;
const FEE = 0.0004;
const CAPITAL = 100;

const cfg: SolanaBotV1Config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../config-solana-bot-v1.json'), 'utf-8')
);

async function main() {
  console.log('SolanaBotV1 Backtest');
  console.log('='.repeat(50));
  console.log(`Capital: $${CAPITAL}`);
  console.log(`Slippage: ${(SLIPPAGE * 100).toFixed(2)}%`);
  console.log(`Fee: ${(FEE * 100).toFixed(3)}%`);
  console.log('');

  console.log('Fetching 15m candles (CryptoCompare histominute aggregate=15)...');
  let candles: CryptoCompareCandle[];
  try {
    candles = await fetchCryptoCompareCandlesAggregatedMinutes({
      fsym: 'SOL',
      tsym: 'USD',
      aggregateMinutes: 15,
      startMs: START_MS,
      endMs: END_MS,
      apiKey: CC_KEY,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('only available for the last 7 days')) {
      const cappedStart = END_MS - 6 * 24 * 60 * 60 * 1000;
      console.warn('[Backtest] CryptoCompare minute history is limited on free tier; falling back to last ~6 days');
      candles = await fetchCryptoCompareCandlesAggregatedMinutes({
        fsym: 'SOL',
        tsym: 'USD',
        aggregateMinutes: 15,
        startMs: cappedStart,
        endMs: END_MS,
        apiKey: CC_KEY,
      });
    } else {
      throw err;
    }
  }
  console.log(`Fetched ${candles.length} 15m candles`);

  console.log(`Running simulation...`);
  const result = runSolanaBotV1Backtest(candles, cfg, {
    startingCapitalUSDC: CAPITAL,
    slippagePct: SLIPPAGE,
    feePct: FEE,
  });

  console.log('');
  console.log('='.repeat(50));
  console.log('BACKTEST RESULTS');
  console.log('='.repeat(50));
  console.log(`Period: ${new Date(candles[0]?.timestamp ?? 0).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1]?.timestamp ?? 0).toISOString().slice(0, 10)}`);
  console.log(`Final value: $${result.metrics.finalValueUSDC.toFixed(2)}`);
  console.log(`Total return: ${result.metrics.totalReturnPct >= 0 ? '+' : ''}${result.metrics.totalReturnPct.toFixed(1)}%`);
  console.log('');
  console.log(`Trades: ${result.trades.length} (${result.metrics.closedTrades} closed)`);
  console.log(`Win rate: ${result.metrics.winRatePct.toFixed(1)}%`);
  console.log(`Total PnL: $${result.metrics.totalPnlUSDC.toFixed(2)}`);
  console.log(`Avg win: $${result.metrics.avgWinUSDC.toFixed(2)}, Avg loss: $${result.metrics.avgLossUSDC.toFixed(2)}`);
  console.log(`Max drawdown: ${result.metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log('');
  console.log('Recent trades:');
  result.trades.slice(-10).forEach(t => {
    const d = new Date(t.timestamp).toISOString().slice(0, 16).replace('T', ' ');
    const pnl = t.action === 'sell' ? `P: $${t.pnl.toFixed(2)}` : '';
    console.log(`  ${d} ${t.action.toUpperCase()} @ $${t.price.toFixed(2)} ${pnl}`);
  });
}

main().catch(console.error);
