import { backfillSymbol, type CandleSource } from './backfill.js';
import { parseCsv, serializeCsv } from './candle.js';

export interface Instrument {
  symbol: string;
  name: string;
  sector: string;
}
export interface Universe {
  asof: string;
  instruments: Instrument[];
}

/** 유니버스의 각 심볼을 백필/증분해 심볼별 CSV로 쓴다(source·fs 주입식 → 테스트 가능). */
export async function runFetch(deps: {
  source: CandleSource;
  universe: Universe;
  dir: string;
  targetStart: string;
  readFile: (p: string) => Promise<string | null>;
  writeFile: (p: string, s: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ symbol: string; rows: number }[]> {
  const results: { symbol: string; rows: number }[] = [];
  for (const inst of deps.universe.instruments) {
    const path = `${deps.dir}/${inst.symbol}.csv`;
    const prev = await deps.readFile(path);
    const existing = prev ? parseCsv(prev) : [];
    const rows = await backfillSymbol(deps.source, inst.symbol, existing, {
      targetStart: deps.targetStart,
      sleep: deps.sleep,
    });
    await deps.writeFile(path, serializeCsv(rows));
    results.push({ symbol: inst.symbol, rows: rows.length });
  }
  return results;
}
