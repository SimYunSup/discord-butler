import { buildRows, mergeRows, type CsvRow, type RawCandle } from './candle.js';
export * from './candle-source.js';
import type { CandleSource } from './candle-source.js';

const MAX_PAGES = 60; // 200*60 = 12000봉 안전 상한

/** before 커서로 targetStart까지 백필하고 기존 CSV행과 병합. 증분이면 기존 최신 이후만. */
export async function backfillSymbol(
  source: CandleSource,
  symbol: string,
  existing: CsvRow[],
  opts: { targetStart: string; pageSize?: number; sleep?: (ms: number) => Promise<void> },
): Promise<CsvRow[]> {
  const pageSize = Math.min(opts.pageSize ?? 200, 200);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const lastExisting = existing.at(-1);
  const stopAt = lastExisting ? lastExisting.date : opts.targetStart;

  const collected: RawCandle[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { candles, rateLimitRemaining } = await source.fetch(symbol, {
      interval: '1d',
      count: pageSize,
      before,
      adjusted: true,
    });
    if (candles.length === 0) break;
    collected.push(...candles);

    let minTs = candles[0]?.timestamp ?? '';
    for (const c of candles) if (c.timestamp < minTs) minTs = c.timestamp;
    const minDate = minTs.slice(0, 10);

    if (rateLimitRemaining !== null && rateLimitRemaining <= 0) await sleep(1200);
    if (minDate <= stopAt) break; // 목표/기존 최신 도달
    if (candles.length < pageSize) break; // 히스토리 끝
    if (before !== undefined && minTs >= before) break; // 진행 없음(안전)
    before = minTs;
  }
  return mergeRows(existing, buildRows(collected));
}
