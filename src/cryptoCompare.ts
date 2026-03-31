import axios from 'axios';

export interface CryptoCompareCandle {
  timestamp: number; // Unix ms (candle start)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

type CCDataRow = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumefrom: number;
};

type CCHistoResp = {
  Response: string;
  Message?: string;
  Data?: {
    Data?: CCDataRow[];
  };
};

async function fetchFromEndpoint(params: {
  endpoint: 'histominute' | 'histohour';
  fsym: string;
  tsym: string;
  aggregateMinutes?: number;
  startMs: number;
  endMs: number;
  apiKey: string;
  limitPerCall: number;
  sleepMsBetweenCalls: number;
}): Promise<CryptoCompareCandle[]> {
  const {
    endpoint,
    fsym,
    tsym,
    aggregateMinutes,
    startMs,
    endMs,
    apiKey,
    limitPerCall,
    sleepMsBetweenCalls,
  } = params;

  const startSec = Math.floor(startMs / 1000);
  const endSec = Math.floor(endMs / 1000);
  const all: CryptoCompareCandle[] = [];
  let toTs = endSec;

  while (true) {
    const url = endpoint === 'histohour'
      ? 'https://min-api.cryptocompare.com/data/v2/histohour'
      : 'https://min-api.cryptocompare.com/data/v2/histominute';

    const { data } = await axios.get<CCHistoResp>(
      url,
      {
        params: {
          fsym,
          tsym,
          ...(endpoint === 'histominute' ? { aggregate: aggregateMinutes } : {}),
          limit: limitPerCall,
          toTs,
          api_key: apiKey,
        },
        timeout: 30_000,
      },
    );

    if (data.Response !== 'Success') {
      throw new Error(data.Message ?? data.Response);
    }

    const rows = data.Data?.Data ?? [];
    if (!rows.length) break;

    for (const r of rows) {
      if (r.time < startSec || r.time > endSec) continue;
      if (r.open === 0 && r.close === 0) continue;
      all.push({
        timestamp: r.time * 1000,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volumefrom,
      });
    }

    const minTime = rows.reduce((m, r) => Math.min(m, r.time), rows[0].time);
    toTs = minTime - 1;
    if (minTime <= startSec) break;

    if (sleepMsBetweenCalls > 0) {
      await new Promise((r) => setTimeout(r, sleepMsBetweenCalls));
    }
  }

  const seen = new Set<number>();
  const uniq: CryptoCompareCandle[] = [];
  for (const c of all) {
    if (seen.has(c.timestamp)) continue;
    seen.add(c.timestamp);
    uniq.push(c);
  }
  uniq.sort((a, b) => a.timestamp - b.timestamp);
  return uniq;
}

export async function fetchCryptoCompareHourlyCandlesRange(params: {
  fsym: string;
  tsym: string;
  startMs: number;
  endMs: number;
  apiKey: string;
  limitPerCall?: number;
  sleepMsBetweenCalls?: number;
}): Promise<CryptoCompareCandle[]> {
  const {
    fsym,
    tsym,
    startMs,
    endMs,
    apiKey,
    limitPerCall = 2000,
    sleepMsBetweenCalls = 250,
  } = params;

  if (!apiKey) throw new Error('CRYPTOCOMPARE_API_KEY not set');

  return fetchFromEndpoint({
    endpoint: 'histohour',
    fsym,
    tsym,
    startMs,
    endMs,
    apiKey,
    limitPerCall,
    sleepMsBetweenCalls,
  });
}

export function computeLastClosedToTsSec(aggregateMinutes: number, nowSec: number = Math.floor(Date.now() / 1000)): number {
  const bucketSec = aggregateMinutes * 60;
  const lastClose = Math.floor(nowSec / bucketSec) * bucketSec;
  // toTs is inclusive; subtract 1 to avoid pulling the currently-forming candle.
  return Math.max(0, lastClose - 1);
}

/**
 * Fetch aggregated candles from CryptoCompare using histominute + aggregate.
 * Note: aggregateMinutes must be <= 60 for histominute.
 */
export async function fetchCryptoCompareCandlesAggregatedMinutes(params: {
  fsym: string;
  tsym: string;
  aggregateMinutes: number;
  startMs: number;
  endMs: number;
  apiKey: string;
  limitPerCall?: number;
  sleepMsBetweenCalls?: number;
}): Promise<CryptoCompareCandle[]> {
  const {
    fsym,
    tsym,
    aggregateMinutes,
    startMs,
    endMs,
    apiKey,
    limitPerCall = 2000,
    sleepMsBetweenCalls = 250,
  } = params;

  if (!apiKey) throw new Error('CRYPTOCOMPARE_API_KEY not set');
  if (aggregateMinutes < 1 || aggregateMinutes > 60) throw new Error(`aggregateMinutes must be 1..60 (got ${aggregateMinutes})`);

  // For 60m, use histohour so we can access longer history on free tier.
  if (aggregateMinutes === 60) {
    return fetchFromEndpoint({
      endpoint: 'histohour',
      fsym,
      tsym,
      startMs,
      endMs,
      apiKey,
      limitPerCall,
      sleepMsBetweenCalls,
    });
  }

  return fetchFromEndpoint({
    endpoint: 'histominute',
    fsym,
    tsym,
    aggregateMinutes,
    startMs,
    endMs,
    apiKey,
    limitPerCall,
    sleepMsBetweenCalls,
  });
}

export async function fetchRecentCryptoCompareCandlesAggregatedMinutes(params: {
  fsym: string;
  tsym: string;
  aggregateMinutes: number;
  candles: number;
  apiKey: string;
}): Promise<CryptoCompareCandle[]> {
  const { fsym, tsym, aggregateMinutes, candles, apiKey } = params;
  if (!apiKey) throw new Error('CRYPTOCOMPARE_API_KEY not set');

  const toTs = computeLastClosedToTsSec(aggregateMinutes);
  const limit = Math.min(2000, Math.max(10, candles));

  const { data } = await axios.get<CCHistoResp>(
    'https://min-api.cryptocompare.com/data/v2/histominute',
    {
      params: {
        fsym,
        tsym,
        aggregate: aggregateMinutes,
        limit,
        toTs,
        api_key: apiKey,
      },
      timeout: 30_000,
    },
  );

  if (data.Response !== 'Success') throw new Error(data.Message ?? data.Response);
  const rows = data.Data?.Data ?? [];

  const out: CryptoCompareCandle[] = [];
  for (const r of rows) {
    if (r.open === 0 && r.close === 0) continue;
    out.push({
      timestamp: r.time * 1000,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volumefrom,
    });
  }

  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
