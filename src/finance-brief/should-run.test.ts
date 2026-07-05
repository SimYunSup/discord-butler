import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayKst, isoWeek, isTradingDay, decideRun } from './should-run.js';

test('todayKst: KST 날짜(UTC+9)', () => {
  assert.equal(todayKst(new Date('2026-07-05T20:00:00Z')), '2026-07-06'); // UTC 20시 = KST 익일 05시
  assert.equal(todayKst(new Date('2026-07-06T00:00:00Z')), '2026-07-06'); // KST 09시
});

test('isoWeek: 같은 주 동일, 다음 주 상이', () => {
  assert.equal(isoWeek('2026-07-06'), isoWeek('2026-07-08')); // 월~수 같은 주
  assert.notEqual(isoWeek('2026-07-06'), isoWeek('2026-07-13'));
});

// getMarketCalendarKR().result 형태(probe 실측)
const openCal = {
  today: { date: '2026-07-06', integrated: { regularMarket: { startTime: '2026-07-06T09:00:00.000+09:00' } } },
  previousBusinessDay: { date: '2026-07-03' },
  nextBusinessDay: { date: '2026-07-07' },
};

test('isTradingDay: 개장일(regularMarket 있음) → true', () => {
  assert.equal(isTradingDay(openCal, '2026-07-06'), true);
});

test('isTradingDay: 휴장(today에 regularMarket 없음) → false', () => {
  const holiday = { today: { date: '2026-07-06', integrated: {} } };
  assert.equal(isTradingDay(holiday, '2026-07-06'), false);
});

test('isTradingDay: today.date가 오늘과 불일치(다음 영업일로 롤) → false', () => {
  const rolled = { today: { date: '2026-07-07', integrated: { regularMarket: { startTime: 'x' } } } };
  assert.equal(isTradingDay(rolled, '2026-07-06'), false);
});

test('isTradingDay: 구조 불명 → fail-open(true)', () => {
  assert.equal(isTradingDay({}, '2026-07-06'), true);
  assert.equal(isTradingDay(null, '2026-07-06'), true);
});

test('decideRun: 개장 + 이번주 미실행 → run', () => {
  assert.equal(decideRun(true, '2026-07-06', null).run, true);
});
test('decideRun: 휴장 → skip(순연)', () => {
  assert.equal(decideRun(false, '2026-07-06', null).run, false);
});
test('decideRun: 이번주 이미 실행 → skip', () => {
  const wk = isoWeek('2026-07-06');
  assert.equal(decideRun(true, '2026-07-07', wk).run, false);
});
