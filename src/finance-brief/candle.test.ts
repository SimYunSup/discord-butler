import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRows, mergeRows, serializeCsv, parseCsv, type RawCandle } from './candle.js';

function raw(ts: string, o: number, h: number, l: number, c: number, v: number): RawCandle {
  return {
    timestamp: `${ts}T00:00:00.000+09:00`,
    openPrice: String(o),
    highPrice: String(h),
    lowPrice: String(l),
    closePrice: String(c),
    volume: String(v),
    currency: 'KRW',
  };
}

test('buildRows: 오름차순 정렬 + vwap/factor/change 계산', () => {
  const rows = buildRows([
    raw('2024-01-03', 110, 115, 108, 112, 20),
    raw('2024-01-02', 100, 105, 99, 102, 10),
  ]);
  assert.equal(rows.length, 2);
  const [r0, r1] = rows;
  assert.ok(r0 && r1);
  assert.equal(r0.date, '2024-01-02');
  assert.equal(r0.factor, 1);
  assert.equal(r0.change, 0); // 첫 행
  assert.equal(r1.vwap, (115 + 108 + 112) / 3);
  assert.ok(Math.abs(r1.change - (112 / 102 - 1)) < 1e-9);
});

test('mergeRows: date 중복 제거 + fresh 우선 + change 재계산', () => {
  const a = buildRows([raw('2024-01-02', 100, 105, 99, 102, 10)]);
  const b = buildRows([
    raw('2024-01-02', 100, 105, 99, 200, 10),
    raw('2024-01-03', 110, 115, 108, 112, 20),
  ]);
  const m = mergeRows(a, b);
  assert.equal(m.length, 2);
  const [m0, m1] = m;
  assert.ok(m0 && m1);
  assert.equal(m0.close, 200); // fresh 우선
  assert.ok(Math.abs(m1.change - (112 / 200 - 1)) < 1e-9);
});

test('serializeCsv/parseCsv 왕복', () => {
  const rows = buildRows([raw('2024-01-02', 100, 105, 99, 102, 10)]);
  const back = parseCsv(serializeCsv(rows));
  const [b0] = back;
  assert.ok(b0);
  assert.equal(b0.date, '2024-01-02');
  assert.equal(b0.close, 102);
});
