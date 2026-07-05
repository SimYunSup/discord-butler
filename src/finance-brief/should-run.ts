/** KST(UTC+9) 기준 YYYY-MM-DD. */
export function todayKst(now: Date): string {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/** ISO 주차 라벨(예: 2026-W27). 같은 주는 동일, 주가 바뀌면 달라진다. */
export function isoWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - day + 3); // 그 주 목요일로 이동
  const year = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(year, 0, 4));
  const firstThuDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * getMarketCalendarKR().result 로 "오늘이 KR 개장일인가"를 판정(시간 무관 — 개장 전 8시에도 유효).
 * 개장일: `today.date === today` 이고 `today.integrated.regularMarket.startTime` 존재.
 * 공휴일: today에 regularMarket이 없거나 today.date가 오늘이 아님(다음 영업일로 롤) → false.
 * 구조가 전혀 예상 밖이면 fail-open(true) — 주간 브리핑을 조용히 놓치는 것보다 낫다.
 */
export function isTradingDay(calResult: unknown, today: string): boolean {
  const t = (calResult as { today?: { date?: unknown; integrated?: { regularMarket?: { startTime?: unknown } } } })
    ?.today;
  if (!t || typeof t.date !== 'string') return true; // 구조 불명 → fail-open
  if (t.date !== today) return false; // 오늘이 today로 안 잡힘 = 휴장(다음 영업일로 롤)
  return typeof t.integrated?.regularMarket?.startTime === 'string';
}

/** 개장일이고 이번 주 미실행이면 실행. 휴장이면 skip → 다음 개장일 launchd가 이어받아 순연. */
export function decideRun(
  tradingToday: boolean,
  today: string,
  marker: string | null,
): { run: boolean; reason: string; week: string } {
  const week = isoWeek(today);
  if (!tradingToday) return { run: false, reason: `휴장(${today}) → 다음 개장일로 순연`, week };
  if (marker === week) return { run: false, reason: `이번주(${week}) 이미 실행`, week };
  return { run: true, reason: `개장 + ${week} 첫 실행`, week };
}
