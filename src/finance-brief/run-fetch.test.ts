import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFetch, type Universe } from './run-fetch.js';
import type { CandleSource, CandleQuery, CandleResponse } from './backfill.js';
import { parseCsv } from './candle.js';

class OnePageSource implements CandleSource {
  async fetch(sym: string, _q: CandleQuery): Promise<CandleResponse> {
    return {
      candles: [
        {
          timestamp: '2024-01-02T00:00:00.000+09:00',
          openPrice: '100',
          highPrice: '105',
          lowPrice: '99',
          closePrice: `${sym === '005930' ? 102 : 202}`,
          volume: '10',
          currency: 'KRW',
        },
      ],
      rateLimitRemaining: 4,
    };
  }
}

test('runFetch: 심볼별 CSV를 메모리 fs에 쓴다', async () => {
  const uni: Universe = {
    asof: '2024-01-02',
    instruments: [
      { symbol: '005930', name: '삼성전자', sector: 'TECH' },
      { symbol: '000660', name: 'SK하이닉스', sector: 'TECH' },
    ],
  };
  const files = new Map<string, string>();
  const out = await runFetch({
    source: new OnePageSource(),
    universe: uni,
    dir: '/tmp/candles',
    targetStart: '2024-01-01',
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, s) => {
      files.set(p, s);
    },
    sleep: async () => {},
  });
  assert.equal(out.length, 2);
  const [o0] = out;
  assert.ok(o0);
  assert.equal(o0.rows, 1);
  const csv = files.get('/tmp/candles/005930.csv');
  assert.ok(csv);
  const [p0] = parseCsv(csv);
  assert.ok(p0);
  assert.equal(p0.close, 102);
});
