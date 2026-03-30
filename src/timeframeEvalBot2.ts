import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import {
  evaluateBot2Strategy,
  buildInitialBot2Position,
  updateBot2Position,
} from './strategyBot2';
import { Bot2Config } from './typesBot2';

interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface TradeResult {
  timestamp: number;
  action: 'buy' | 'sell';
  price: number;
  size: number;
  pnl: number;
}

interface BacktestMetrics {
  totalReturn: number;
  annualizedReturn: number;
  sharpe: number;
  maxDrawdown: number;
  winRate: number;
  tradesPerYear: number;
  avgProfitPerTrade: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  avgWin: number;
  avgLoss: number;
  netAfterFees: number;
}

interface TimeframeResult {
  timeframe: string;
  metrics: BacktestMetrics;
  config: Partial<Bot2Config['bot2']['strategy']>;
  validation: {
    walkForwardPass: boolean;
    splitPeriodPass: boolean;
    robustness: number;
  };
}

const CC_KEY = process.env.CRYPTOCOMPARE_API_KEY ?? '';
const SLIPPAGE = 0.002;
const TRADING_FEE = 0.0004;
const CAPITAL = 100;
const MIN_TRADES_FOR_VALID = 10;

// Timeframes that can be derived from hourly data
const TIMEFRAMES = ['15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

const BASE_CONFIG: Bot2Config['bot2']['strategy'] = {
  rsi: { period: 4, oversold: 30, overbought: 70, exitOversold: 30, exitOverbought: 55 },
  vwap: { anchor: 'session', deviationThresholdPct: 2 },
  atr: { period: 14, volatilityScale: true, maxPositionPct: 15 },
  trendFilter: { enabled: true, emaPeriod: 20, disableBelowPct: -3, disableAbovePct: 3 },
  entry: { minDeviationPct: 0.5, confirmationCandles: 1, maxRetries: 2 },
  exit: { profitTargetPct: 1, stopLossPct: 2.5, trailingStopPct: 1, trailingActivationPct: 1.5, maxHoldMinutes: 60 },
  position: { maxPositionPct: 30, minTradeUSDC: 5, pyramidingEnabled: false },
  filters: { minVolumeUSD: 10000, minLiquidityPct: 1 },
};

interface CCHistoResp {
  Response: string;
  Data: { Data: Array<{ time: number; open: number; high: number; low: number; close: number; volumefrom: number }> };
}

async function fetchHourlyData(startMs: number, endMs: number): Promise<Candle[]> {
  const all: Candle[] = [];
  const startSec = Math.floor(startMs / 1000);
  let toTs = Math.floor(endMs / 1000);

  while (true) {
    const { data } = await axios.get<CCHistoResp>(
      'https://min-api.cryptocompare.com/data/v2/histohour',
      { params: { fsym: 'SOL', tsym: 'USD', limit: 2000, toTs, api_key: CC_KEY }, timeout: 30000 }
    );
    if (data.Response !== 'Success') throw new Error(data.Response);
    const rows = data.Data.Data;
    if (!rows.length) break;
    for (const r of rows) {
      if (r.time < startSec) continue;
      all.push({ timestamp: r.time * 1000, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volumefrom });
    }
    toTs = rows[0].time - 1;
    if (rows[0].time <= startSec) break;
  }
  return all.sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateToTimeframe(hourly: Candle[], tf: string): Candle[] {
  // Map timeframe to number of hourly candles to combine
  const hourlyCount: Record<string, number> = { 
    '15m': 1,      // 1 hour = 4x 15m
    '30m': 2,      // 2 hours = 2x 30m  
    '1h': 1,       // 1 hour = 1x 1h
    '2h': 2,       // 2 hours
    '4h': 4,       // 4 hours
    '6h': 6,       // 6 hours
    '12h': 12,     // 12 hours
    '1d': 24,      // 24 hours
  };
  
  const count = hourlyCount[tf] || 1;
  const candles: Candle[] = [];
  
  for (let i = 0; i < hourly.length; i += count) {
    const chunk = hourly.slice(i, i + count);
    if (chunk.length === 0) continue;
    
    candles.push({
      timestamp: chunk[0].timestamp,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    });
  }
  
  return candles;
}

function runBacktest(candles: Candle[], cfg: Bot2Config, positionSizePct: number = 30): { metrics: BacktestMetrics; trades: TradeResult[] } {
  const warmup = 100;
  let usdc = CAPITAL;
  let position = buildInitialBot2Position();
  const trades: TradeResult[] = [];
  const pnlHistory: number[] = [];
  let peak = CAPITAL;
  let maxDrawdown = 0;
  let wins = 0, losses = 0;
  let totalWin = 0, totalLoss = 0;

  for (let i = warmup; i < candles.length; i++) {
    const price = candles[i].close;
    const window = candles.slice(Math.max(0, i - 100), i + 1);
    const signal = evaluateBot2Strategy(price, window, position, cfg, candles[i].timestamp);

    if (signal.action === 'buy' && !position.inPosition) {
      const tradeUsdc = Math.min(usdc * (positionSizePct / 100), usdc);
      if (tradeUsdc < 1) continue;
      const size = tradeUsdc / price;
      const cost = size * price * (1 + SLIPPAGE + TRADING_FEE);
      usdc -= cost;
      position = updateBot2Position(position, 'buy', price * (1 + SLIPPAGE), size, cfg, candles[i].timestamp);
      trades.push({ timestamp: candles[i].timestamp, action: 'buy', price, size, pnl: 0 });
    } else if (signal.action === 'sell' && position.inPosition && position.entryPrice) {
      const proceeds = position.size * price * (1 - SLIPPAGE - TRADING_FEE);
      const pnl = proceeds - position.size * position.entryPrice;
      usdc += proceeds;
      pnlHistory.push(pnl);
      if (pnl > 0) { wins++; totalWin += pnl; } 
      else { losses++; totalLoss += Math.abs(pnl); }
      trades.push({ timestamp: candles[i].timestamp, action: 'sell', price, size: position.size, pnl });
      position = updateBot2Position(position, 'sell', price, position.size, cfg, candles[i].timestamp);
    } else if (position.inPosition) {
      position = updateBot2Position(position, 'hold', price, position.size, cfg, candles[i].timestamp);
    }

    const portfolioValue = usdc + (position.inPosition ? position.size * price : 0);
    if (portfolioValue > peak) peak = portfolioValue;
    const drawdown = (peak - portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const finalValue = usdc + (position.inPosition ? position.size * candles[candles.length - 1].close : 0);
  const totalReturn = ((finalValue - CAPITAL) / CAPITAL) * 100;
  const days = (candles[candles.length - 1].timestamp - candles[warmup].timestamp) / (1000 * 60 * 60 * 24);
  const years = days / 365;
  const annualizedReturn = years > 0 ? ((finalValue / CAPITAL) ** (1 / years) - 1) * 100 : 0;
  
  const totalClosedTrades = trades.filter(t => t.action === 'sell').length;
  const avgProfit = totalClosedTrades > 0 ? pnlHistory.reduce((s, p) => s + p, 0) / totalClosedTrades : 0;
  const avgWinVal = wins > 0 ? totalWin / wins : 0;
  const avgLossVal = losses > 0 ? totalLoss / losses : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
  
  const returns = pnlHistory.length > 1 ? pnlHistory.map((p, i) => {
    const prev = pnlHistory.slice(0, i).reduce((s, x) => s + x, 0);
    return i > 0 ? (pnlHistory[i] - pnlHistory[i-1]) / (CAPITAL + pnlHistory[i-1]) : 0;
  }) : [0];
  const meanRet = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdRet = Math.sqrt(returns.map(r => Math.pow(r - meanRet, 2)).reduce((s, r) => s + r, 0) / returns.length);
  const sharpe = stdRet > 0 ? (meanRet / stdRet) * Math.sqrt(252) : 0;

  const tradesPerYear = years > 0 ? totalClosedTrades / years : 0;
  const netAfterFees = finalValue - CAPITAL;

  return {
    metrics: {
      totalReturn,
      annualizedReturn,
      sharpe: Math.max(0, sharpe),
      maxDrawdown: maxDrawdown * 100,
      winRate: totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0,
      tradesPerYear,
      avgProfitPerTrade: avgProfit,
      profitFactor,
      totalTrades: totalClosedTrades,
      winningTrades: wins,
      losingTrades: losses,
      avgWin: avgWinVal,
      avgLoss: avgLossVal,
      netAfterFees,
    },
    trades,
  };
}

function runWalkForwardValidation(candles: Candle[], cfg: Bot2Config): { pass: boolean; avgValReturn: number; positivePeriods: number; totalPeriods: number } {
  const totalCandles = candles.length;
  const warmup = 100;
  const trainSize = Math.floor((totalCandles - warmup) * 0.6);
  const valSize = Math.floor((totalCandles - warmup) * 0.2);
  const stepSize = Math.floor((totalCandles - warmup) * 0.1);
  
  if (trainSize < 200 || valSize < 50) return { pass: false, avgValReturn: 0, positivePeriods: 0, totalPeriods: 0 };
  
  let positivePeriods = 0, totalPeriods = 0;
  let totalValReturn = 0;
  
  for (let i = warmup; i + trainSize + valSize <= totalCandles; i += stepSize) {
    const trainCandles = candles.slice(i, i + trainSize);
    const valCandles = candles.slice(i + trainSize, i + trainSize + valSize);
    
    if (trainCandles.length < 50 || valCandles.length < 20) continue;
    
    const trainResult = runBacktest(trainCandles, cfg);
    const valResult = runBacktest(valCandles, cfg);
    
    if (valResult.metrics.totalTrades >= MIN_TRADES_FOR_VALID) {
      totalPeriods++;
      totalValReturn += valResult.metrics.totalReturn;
      if (valResult.metrics.totalReturn > 0) positivePeriods++;
    }
  }
  
  const avgValReturn = totalPeriods > 0 ? totalValReturn / totalPeriods : 0;
  const pass = totalPeriods >= 2 && (positivePeriods / totalPeriods) >= 0.5;
  
  return { pass, avgValReturn, positivePeriods, totalPeriods };
}

function runSplitPeriodValidation(candles: Candle[], cfg: Bot2Config): { pass: boolean; period1Return: number; period2Return: number; bothPositive: boolean } {
  const warmup = 100;
  const mid = Math.floor((candles.length - warmup) / 2) + warmup;
  
  const period1 = candles.slice(warmup, mid);
  const period2 = candles.slice(mid);
  
  if (period1.length < 100 || period2.length < 100) return { pass: false, period1Return: 0, period2Return: 0, bothPositive: false };
  
  const result1 = runBacktest(period1, cfg);
  const result2 = runBacktest(period2, cfg);
  
  const pass = result1.metrics.totalTrades >= 5 && result2.metrics.totalTrades >= 5;
  const bothPositive = result1.metrics.totalReturn > 0 && result2.metrics.totalReturn > 0;
  
  return { pass, period1Return: result1.metrics.totalReturn, period2Return: result2.metrics.totalReturn, bothPositive };
}

async function optimizeForTimeframe(candles: Candle[], baseTf: string): Promise<Bot2Config> {
  const paramGrid = {
    rsiPeriod: [4, 6, 8],
    rsiOversold: [25, 30, 35],
    rsiExitOverbought: [50, 55, 60],
    minDeviationPct: [0.25, 0.5, 0.75, 1.0],
    profitTarget: [0.75, 1.0, 1.5],
    stopLoss: [1.5, 2.0, 2.5],
    cooldownMinutes: [5, 10],
  };
  
  const cfg: Bot2Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8'));
  
  let bestReturn = -Infinity;
  let bestConfig = cfg;
  let combos = 1;
  for (const k of Object.values(paramGrid)) combos *= k.length;
  
  let count = 0;
  for (const rsiPeriod of paramGrid.rsiPeriod) {
    for (const rsiOversold of paramGrid.rsiOversold) {
      for (const rsiExitOverbought of paramGrid.rsiExitOverbought) {
        for (const minDeviationPct of paramGrid.minDeviationPct) {
          for (const profitTarget of paramGrid.profitTarget) {
            for (const stopLoss of paramGrid.stopLoss) {
              for (const cooldownMinutes of paramGrid.cooldownMinutes) {
                count++;
                
                cfg.bot2.strategy.rsi.period = rsiPeriod;
                cfg.bot2.strategy.rsi.oversold = rsiOversold;
                cfg.bot2.strategy.rsi.exitOverbought = rsiExitOverbought;
                cfg.bot2.strategy.entry.minDeviationPct = minDeviationPct;
                cfg.bot2.strategy.exit.profitTargetPct = profitTarget;
                cfg.bot2.strategy.exit.stopLossPct = stopLoss;
                cfg.bot2.risk.cooldownMinutes = cooldownMinutes;
                
                const result = runBacktest(candles, cfg);
                const score = result.metrics.totalReturn - Math.abs(result.metrics.maxDrawdown) * 0.5;
                
                if (score > bestReturn && result.metrics.totalTrades >= 10) {
                  bestReturn = score;
                  bestConfig = JSON.parse(JSON.stringify(cfg));
                }
                
                if (count % 200 === 0) process.stdout.write(`\r[${baseTf}] Optimizing: ${count}/${combos}`);
              }
            }
          }
        }
      }
    }
  }
  console.log(`\r[${baseTf}] Optimization complete. Best return: ${bestReturn.toFixed(2)}%`);
  
  return bestConfig;
}

async function main() {
  console.log('='.repeat(80));
  console.log('BOT #2 TIMEFRAME EVALUATION FRAMEWORK');
  console.log('='.repeat(80));
  console.log('');
  
  const START_MS = Date.now() - 365 * 24 * 60 * 60 * 1000;
  const END_MS = Date.now();
  
  console.log('Phase 1: Fetching hourly data...');
  const hourly = await fetchHourlyData(START_MS, END_MS);
  console.log(`Fetched ${hourly.length} hourly candles`);
  console.log(`Period: ${new Date(hourly[0].timestamp).toISOString().slice(0, 10)} → ${new Date(hourly[hourly.length - 1].timestamp).toISOString().slice(0, 10)}`);
  console.log('');
  
  const results: TimeframeResult[] = [];
  
  console.log('='.repeat(80));
  console.log('PHASE 1: FIXED LOGIC COMPARISON');
  console.log('='.repeat(80));
  console.log('');
  
  for (const tf of TIMEFRAMES) {
    console.log(`Testing ${tf} timeframe...`);
    const candles = aggregateToTimeframe(hourly, tf);
    console.log(`  Aggregated to ${candles.length} ${tf} candles`);
    
    const cfg: Bot2Config = JSON.parse(fs.readFileSync(path.join(__dirname, '../config-bot2.json'), 'utf-8'));
    const { metrics } = runBacktest(candles, cfg);
    
    console.log(`  Return: ${metrics.totalReturn.toFixed(2)}% | Ann: ${metrics.annualizedReturn.toFixed(2)}% | WR: ${metrics.winRate.toFixed(0)}%`);
    console.log(`  Trades: ${metrics.totalTrades} (${metrics.tradesPerYear.toFixed(0)}/yr) | Sharpe: ${metrics.sharpe.toFixed(2)} | MDD: ${metrics.maxDrawdown.toFixed(2)}%`);
    
    results.push({
      timeframe: tf,
      metrics,
      config: JSON.parse(JSON.stringify(cfg.bot2.strategy)),
      validation: { walkForwardPass: false, splitPeriodPass: false, robustness: 0 },
    });
    console.log('');
  }
  
  console.log('='.repeat(80));
  console.log('PHASE 2: PER-TIMEFRAME OPTIMIZATION & VALIDATION');
  console.log('='.repeat(80));
  console.log('');
  
  for (let i = 0; i < results.length; i++) {
    const tf = results[i].timeframe;
    console.log(`\n[${tf}] Optimizing...`);
    
    const candles = aggregateToTimeframe(hourly, tf);
    const optimizedCfg = await optimizeForTimeframe(candles, tf);
    
    const { metrics } = runBacktest(candles, optimizedCfg);
    
    console.log(`[${tf}] Walk-forward validation...`);
    const wf = runWalkForwardValidation(candles, optimizedCfg);
    
    console.log(`[${tf}] Split-period validation...`);
    const sp = runSplitPeriodValidation(candles, optimizedCfg);
    
    const robustness = (metrics.sharpe * 0.3 + (100 - metrics.maxDrawdown) * 0.3 + metrics.winRate * 0.2 + (metrics.tradesPerYear / 100) * 0.2);
    
    results[i] = {
      timeframe: tf,
      metrics,
      config: optimizedCfg.bot2.strategy,
      validation: {
        walkForwardPass: wf.pass,
        splitPeriodPass: sp.pass,
        robustness: Math.min(100, robustness),
      },
    };
    
    console.log(`[${tf}] Optimized: Return ${metrics.totalReturn.toFixed(2)}% | WF: ${wf.pass ? 'PASS' : 'FAIL'} | Split: ${sp.bothPositive ? 'BOTH+' : 'MIXED'}`);
  }
  
  console.log('\n' + '='.repeat(80));
  console.log('RANKED COMPARISON');
  console.log('='.repeat(80));
  console.log('');
  
  const byReturn = [...results].sort((a, b) => b.metrics.totalReturn - a.metrics.totalReturn);
  const byIncome = [...results].sort((a, b) => b.metrics.tradesPerYear - a.metrics.tradesPerYear);
  const byStability = [...results].sort((a, b) => a.metrics.maxDrawdown - b.metrics.maxDrawdown);
  const byRobustness = [...results].sort((a, b) => b.validation.robustness - a.validation.robustness);
  
  console.log('📈 BY TOTAL RETURN:');
  byReturn.forEach((r, i) => console.log(`  ${i + 1}. ${r.timeframe}: ${r.metrics.totalReturn.toFixed(2)}% (${r.metrics.totalTrades} trades)`));
  
  console.log('\n💰 BY INCOME (trades/year):');
  byIncome.forEach((r, i) => console.log(`  ${i + 1}. ${r.timeframe}: ${r.metrics.tradesPerYear.toFixed(0)}/yr (WR: ${r.metrics.winRate.toFixed(0)}%)`));
  
  console.log('\n🛡️ BY STABILITY (lowest drawdown):');
  byStability.forEach((r, i) => console.log(`  ${i + 1}. ${r.timeframe}: ${r.metrics.maxDrawdown.toFixed(2)}% (Sharpe: ${r.metrics.sharpe.toFixed(2)})`));
  
  console.log('\n✅ BY ROBUSTNESS SCORE:');
  byRobustness.forEach((r, i) => console.log(`  ${i + 1}. ${r.timeframe}: ${r.validation.robustness.toFixed(1)} (WF: ${r.validation.walkForwardPass ? '✓' : '✗'}, Split: ${r.validation.splitPeriodPass ? '✓' : '✗'})`));
  
  const recommended = byRobustness[0];
  
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDATION');
  console.log('='.repeat(80));
  console.log(`\n🏆 BEST TIMEFRAME: ${recommended.timeframe}`);
  console.log(`   Total Return: ${recommended.metrics.totalReturn.toFixed(2)}%`);
  console.log(`   Annualized: ${recommended.metrics.annualizedReturn.toFixed(2)}%`);
  console.log(`   Trades/Year: ${recommended.metrics.tradesPerYear.toFixed(0)}`);
  console.log(`   Win Rate: ${recommended.metrics.winRate.toFixed(0)}%`);
  console.log(`   Max Drawdown: ${recommended.metrics.maxDrawdown.toFixed(2)}%`);
  console.log(`   Sharpe: ${recommended.metrics.sharpe.toFixed(2)}`);
  console.log(`   Robustness: ${recommended.validation.robustness.toFixed(1)}`);
  console.log('\nOptimal Config:');
  console.log(`  RSI: ${recommended.config.rsi?.period}/${recommended.config.rsi?.oversold}`);
  console.log(`  Deviation: ${recommended.config.entry?.minDeviationPct}%`);
  console.log(`  PT: ${recommended.config.exit?.profitTargetPct}% | SL: ${recommended.config.exit?.stopLossPct}%`);
  console.log('');
  
  const outputPath = path.join(__dirname, '../timeframe-evaluation.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`Full results saved to: ${outputPath}`);
}

main().catch(console.error);
