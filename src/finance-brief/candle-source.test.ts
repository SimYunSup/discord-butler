import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandles } from './candle-source.js';
import type { RawCandle } from './candle.js';

const c: RawCandle = {
  timestamp: '2024-01-02T00:00:00.000+09:00',
  openPrice: '100',
  highPrice: '105',
  lowPrice: '99',
  closePrice: '102',
  volume: '10',
  currency: 'KRW',
};

test('extractCandles: 직접 배열', () => {
  assert.equal(extractCandles([c]).length, 1);
});

test('extractCandles: {result:[]} 래핑', () => {
  assert.equal(extractCandles({ result: [c] }).length, 1);
});

test('extractCandles: {candles:[]} 래핑', () => {
  assert.equal(extractCandles({ candles: [c] }).length, 1);
});

test('extractCandles: {data:{result:[]}} 중첩', () => {
  assert.equal(extractCandles({ data: { result: [c] } }).length, 1);
});

test('extractCandles: 빈/이상 입력 → []', () => {
  assert.equal(extractCandles({}).length, 0);
  assert.equal(extractCandles(null).length, 0);
  assert.equal(extractCandles(undefined).length, 0);
  assert.equal(extractCandles('nope').length, 0);
});
