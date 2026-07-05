import { createRequire } from 'node:module';
import type { RawCandle } from './candle.js';

export interface CandleQuery {
  interval: '1d';
  count?: number;
  before?: string;
  adjusted?: boolean;
}
export interface CandleResponse {
  candles: RawCandle[];
  rateLimitRemaining: number | null;
}
export interface CandleSource {
  fetch(symbol: string, q: CandleQuery): Promise<CandleResponse>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * Toss getCandles 응답에서 캔들 배열을 뽑는다. 응답 shape가 버전마다 다를 수 있어
 * (직접 배열 / {result:[]} / {candles:[]} / {data:{result:[]}} 등) 방어적으로 탐색.
 */
export function extractCandles(payload: unknown): RawCandle[] {
  if (Array.isArray(payload)) return payload as RawCandle[];
  const rec = asRecord(payload);
  if (!rec) return [];
  for (const key of ['result', 'candles', 'items', 'list', 'prices', 'data']) {
    const v = rec[key];
    if (Array.isArray(v)) return v as RawCandle[];
    const nested = asRecord(v);
    if (nested && Array.isArray(nested['candles'])) return nested['candles'] as RawCandle[];
    if (nested && Array.isArray(nested['result'])) return nested['result'] as RawCandle[];
  }
  return [];
}

let warnedEmpty = false;

interface OfficialClient {
  getCandles(
    symbol: string,
    options: Record<string, unknown>,
  ): Promise<{ data?: unknown; rateLimit?: { remaining?: number } }>;
}

/** getMarketCalendarKR().result 를 반환(개장/휴장 판정용). throw 가능 — 호출부에서 fail-open 처리. */
export async function fetchMarketCalendarKR(): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const client = require('toss-securities/src/official-client.js') as {
    getMarketCalendarKR: () => Promise<{ data?: unknown }>;
  };
  const res = await client.getMarketCalendarKR();
  const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
  const rec = data as { result?: unknown };
  return rec && typeof rec === 'object' && 'result' in rec ? rec.result : data;
}

/** toss-securities official-client의 getCandles 시세 read만 사용(계정/주문 미사용). */
export class TossCandleSource implements CandleSource {
  private client: OfficialClient;
  constructor() {
    const require = createRequire(import.meta.url);
    this.client = require('toss-securities/src/official-client.js') as OfficialClient;
  }
  async fetch(symbol: string, q: CandleQuery): Promise<CandleResponse> {
    const res = await this.client.getCandles(symbol, {
      interval: q.interval,
      count: q.count,
      before: q.before,
      adjusted: q.adjusted ?? true,
    });
    const candles = extractCandles(res.data ?? res);
    if (candles.length === 0 && !warnedEmpty) {
      warnedEmpty = true;
      const payload = res.data ?? res;
      const shape =
        payload && typeof payload === 'object'
          ? Object.keys(payload as object)
          : typeof payload;
      process.stderr.write(
        `[TossCandleSource] 0 candles for ${symbol}; payload shape=${JSON.stringify(shape)}\n`,
      );
    }
    const remaining = res.rateLimit?.remaining;
    return { candles, rateLimitRemaining: typeof remaining === 'number' ? remaining : null };
  }
}
