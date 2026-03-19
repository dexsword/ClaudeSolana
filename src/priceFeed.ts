import axios from 'axios';
import { Candle } from './types';

const BIRDEYE_BASE = 'https://public-api.birdeye.so';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Rate limiter: enforces a minimum gap between consecutive Birdeye API calls.
// The free tier returns 429 when two calls land simultaneously — this ensures
// they are always spaced at least BIRDEYE_MIN_INTERVAL_MS apart.
const BIRDEYE_MIN_INTERVAL_MS = 2000;
let lastBirdeyeCallMs = 0;
let birdeyeQueue: Promise<void> = Promise.resolve();

function birdeyeRateLimited<T>(fn: () => Promise<T>): Promise<T> {
  const result = birdeyeQueue.then(async () => {
    const now = Date.now();
    const wait = BIRDEYE_MIN_INTERVAL_MS - (now - lastBirdeyeCallMs);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastBirdeyeCallMs = Date.now();
    return fn();
  });
  // Chain the queue so future calls wait for this one to start
  birdeyeQueue = result.then(() => undefined, () => undefined);
  return result;
}

const TF_TO_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '3d': 259200,
};

/**
 * Fetch OHLCV candles from Birdeye API.
 * Falls back to Helius DAS API aggregated data if Birdeye fails.
 */
export async function fetchCandles(
  timeframe: string,
  limit: number,
  apiKey: string,
): Promise<Candle[]> {
  const intervalSeconds = TF_TO_SECONDS[timeframe];
  if (!intervalSeconds) throw new Error(`Unknown timeframe: ${timeframe}`);

  const now = Math.floor(Date.now() / 1000);
  const from = now - intervalSeconds * limit;

  try {
    return await birdeyeRateLimited(() => fetchBirdeyeCandles(timeframe, from, now, apiKey));
  } catch (err) {
    console.warn(`[PriceFeed] Birdeye failed (${(err as Error).message}), trying Helius fallback`);
    return await fetchHeliusCandles(timeframe, limit, intervalSeconds, now);
  }
}

async function fetchBirdeyeCandles(
  timeframe: string,
  from: number,
  to: number,
  apiKey: string,
): Promise<Candle[]> {
  // Birdeye uses different interval strings
  const birdeyeInterval: Record<string, string> = {
    '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H',
    '4h': '4H', '1d': '1D', '3d': '3D',
  };

  const resp = await axios.get(`${BIRDEYE_BASE}/defi/ohlcv`, {
    headers: { 'X-API-KEY': apiKey, accept: 'application/json' },
    params: {
      address: SOL_MINT,
      type: birdeyeInterval[timeframe] ?? timeframe,
      time_from: from,
      time_to: to,
    },
    timeout: 10000,
  });

  if (!resp.data?.data?.items) throw new Error('Unexpected Birdeye response shape');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return resp.data.data.items.map((item: any): Candle => ({
    timestamp: item.unixTime * 1000,
    open: item.o,
    high: item.h,
    low: item.l,
    close: item.c,
    volume: item.v,
  }));
}

/**
 * Minimal CoinGecko fallback — builds synthetic OHLCV candles.
 * Fetches OHLC and volume data in parallel, merging volume into each bucket.
 */
async function fetchHeliusCandles(
  timeframe: string,
  limit: number,
  intervalSeconds: number,
  nowSeconds: number,
): Promise<Candle[]> {
  const rawDays = Math.ceil((intervalSeconds * limit) / 86400);
  const validDays = [1, 7, 14, 30, 90, 180, 365];
  const days = validDays.find(d => d >= rawDays) ?? 365;
  const baseUrl = 'https://api.coingecko.com/api/v3/coins/solana';

  const [ohlcResp, chartResp] = await Promise.all([
    axios.get(`${baseUrl}/ohlc?vs_currency=usd&days=${days}`, { timeout: 10000 }),
    axios.get(`${baseUrl}/market_chart?vs_currency=usd&days=${days}`, { timeout: 10000 }),
  ]);

  if (!Array.isArray(ohlcResp.data)) throw new Error('Unexpected CoinGecko OHLC response');

  const bucketMs = intervalSeconds * 1000;
  const buckets = new Map<number, { open: number; high: number; low: number; close: number; volume: number }>();

  // Build OHLC buckets (CoinGecko returns [timestamp, open, high, low, close])
  for (const [ts, open, high, low, close] of ohlcResp.data) {
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { open, high, low, close, volume: 0 });
    } else {
      existing.high = Math.max(existing.high, high);
      existing.low = Math.min(existing.low, low);
      existing.close = close;
    }
  }

  // Merge volume data (market_chart returns { total_volumes: [[timestamp, volume], ...] })
  const totalVolumes: [number, number][] = chartResp.data?.total_volumes ?? [];
  for (const [ts, vol] of totalVolumes) {
    const bucket = Math.floor(ts / bucketMs) * bucketMs;
    const existing = buckets.get(bucket);
    if (existing) {
      existing.volume += vol;
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(-limit)
    .map(([ts, c]): Candle => ({
      timestamp: ts,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
}

/**
 * Fetch current SOL spot price in USDC via Jupiter price API.
 */
export async function fetchSpotPrice(): Promise<number> {
  const apiKey = process.env.JUPITER_PRICE_API_KEY ?? '';
  const resp = await axios.get('https://api.jup.ag/price/v3/price', {
    params: { ids: SOL_MINT },
    headers: { 'x-api-key': apiKey },
    timeout: 8000,
  });

  const price = resp.data?.[SOL_MINT]?.usdPrice;
  if (!price) throw new Error('Could not fetch spot price from Jupiter');
  return price;
}
