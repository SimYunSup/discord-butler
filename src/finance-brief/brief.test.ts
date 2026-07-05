import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBrief, type Signals } from './brief.js';

const s: Signals = {
  asof: '2026-07-03',
  universeSize: 15,
  top: [{ symbol: '005930', name: '삼성전자', sector: 'TECH', score: 0.024 }],
  bottom: [{ symbol: '000270', name: '기아', sector: 'CONS', score: -0.02 }],
  sectorRotation: [
    { sector: 'TECH', score: 0.005, rank: 1 },
    { sector: 'ENERGY', score: -0.006, rank: 2 },
  ],
  meta: { model: 'Alpha158+LGBM', ic: 0.0146, icir: 0.04, rankic: 0.01 },
};

test('renderBrief: asof·IC 캐비엇·섹터·종목 포함', () => {
  const md = renderBrief(s);
  assert.ok(md.includes('2026-07-03'));
  assert.ok(md.includes('0.0146')); // IC 노출
  assert.ok(md.includes('참고')); // 캐비엇
  assert.ok(md.includes('TECH'));
  assert.ok(md.includes('삼성전자'));
});

test('renderBrief: 빈 신호도 안전', () => {
  const empty: Signals = { ...s, top: [], bottom: [], sectorRotation: [] };
  assert.ok(renderBrief(empty).includes('2026-07-03'));
});
