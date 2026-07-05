import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backfillSymbol,
  type CandleSource,
  type CandleResponse,
  type CandleQuery,
} from './backfill.js';
import { buildRows, type RawCandle } from './candle.js';

// 결정적 합성 히스토리(2023-12-01부터 연속 50일, 오름차순).
function makeHistory(): RawCandle[] {
  const out: RawCandle[] = [];
  const start = new Date('2023-12-01');
  for (let i = 0; i < 50; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    const price = 1000 + i;
    out.push({
      timestamp: `${d}T00:00:00.000+09:00`,
      openPrice: String(price),
      highPrice: String(price + 5),
      lowPrice: String(price - 5),
      closePrice: String(price + 1),
      volume: '100',
      currency: 'KRW',
    });
  }
  return out;
}

class FakeSource implements CandleSource {
  calls = 0;
  constructor(private hist: RawCandle[]) {}
  async fetch(_sym: string, q: CandleQuery): Promise<CandleResponse> {
    this.calls++;
    const count = q.count ?? 100;
    let pool = this.hist;
    const before = q.before;
    if (before) pool = pool.filter((c) => c.timestamp < before);
    const page = pool.slice(-count); // 최신 count개(오름차순 유지)
    const remaining = 4 - ((this.calls - 1) % 5); // 5req/창 모사(0까지)
    return { candles: page, rateLimitRemaining: remaining };
  }
}

test('backfill: 빈 상태에서 targetStart까지 페이지네이션', async () => {
  const src = new FakeSource(makeHistory());
  const rows = await backfillSymbol(src, '005930', [], {
    targetStart: '2023-12-01',
    pageSize: 20,
    sleep: async () => {},
  });
  assert.equal(rows.length, 50);
  const first = rows[0];
  const last = rows.at(-1);
  assert.ok(first && last);
  assert.equal(first.date, '2023-12-01');
  assert.equal(last.date, '2024-01-19');
  assert.ok(src.calls >= 3); // 50/20 → 3+ 페이지
});

test('backfill: 증분 — 기존 최신 이후만 가져와 병합', async () => {
  const hist = makeHistory();
  const existing = buildRows(hist.slice(0, 40)); // 2023-12-01..2024-01-09
  const src = new FakeSource(hist);
  const rows = await backfillSymbol(src, '005930', existing, {
    targetStart: '2023-12-01',
    pageSize: 20,
    sleep: async () => {},
  });
  assert.equal(rows.length, 50);
  const last = rows.at(-1);
  assert.ok(last);
  assert.equal(last.date, '2024-01-19');
});

test('backfill: remaining=0이면 sleep 호출', async () => {
  const src = new FakeSource(makeHistory());
  let slept = 0;
  await backfillSymbol(src, '005930', [], {
    targetStart: '2023-12-01',
    pageSize: 10,
    sleep: async () => {
      slept++;
    },
  });
  assert.ok(slept >= 1);
});
