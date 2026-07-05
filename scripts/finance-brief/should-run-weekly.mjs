// 공휴일/주간 게이트: getMarketCalendarKR로 "오늘이 개장일인가"(시간 무관) + 이번주 미실행이면 실행.
// 실행이면 exit 0 + stdout에 ISO 주차(run-weekly.sh가 성공 후 마커로 기록), 스킵이면 exit 1.
// TOSSINVEST_* env 필요(run-weekly.sh가 .env source).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fetchMarketCalendarKR } from '../../src/finance-brief/candle-source.ts';
import { todayKst, isTradingDay, decideRun } from '../../src/finance-brief/should-run.ts';

const here = dirname(fileURLToPath(import.meta.url));
const markerPath = resolve(here, '../..', 'data/finance-brief/.last-week');

const today = todayKst(new Date());
let tradingToday = true; // 캘린더 조회 실패 시 fail-open(주간 브리핑을 조용히 놓치지 않게)
try {
  const cal = await fetchMarketCalendarKR();
  tradingToday = isTradingDay(cal, today);
} catch (err) {
  console.error(`[should-run] 캘린더 조회 실패 → fail-open(실행): ${err?.message ?? err}`);
}

const marker = await readFile(markerPath, 'utf8')
  .then((s) => s.trim())
  .catch(() => null);

const d = decideRun(tradingToday, today, marker);
console.error(`[should-run] ${d.reason}`);
if (d.run) {
  process.stdout.write(d.week);
  process.exit(0);
}
process.exit(1);
