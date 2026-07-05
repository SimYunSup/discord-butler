export interface RawCandle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency?: string;
}

export interface CsvRow {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap: number;
  factor: number;
  change: number;
}

const HEADER = 'date,open,high,low,close,volume,vwap,factor,change';

/** change/vwap/factor를 채우고 date 오름차순 정렬(순수). */
function finalize(rows: Omit<CsvRow, 'vwap' | 'factor' | 'change'>[]): CsvRow[] {
  const sorted = [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let prevClose = sorted[0]?.close ?? 0;
  return sorted.map((r, i) => {
    const change = i === 0 ? 0 : r.close / prevClose - 1;
    prevClose = r.close;
    return { ...r, vwap: (r.high + r.low + r.close) / 3, factor: 1, change };
  });
}

export function buildRows(raws: RawCandle[]): CsvRow[] {
  return finalize(
    raws.map((c) => ({
      date: c.timestamp.slice(0, 10),
      open: Number(c.openPrice),
      high: Number(c.highPrice),
      low: Number(c.lowPrice),
      close: Number(c.closePrice),
      volume: Number(c.volume),
    })),
  );
}

export function mergeRows(existing: CsvRow[], fresh: CsvRow[]): CsvRow[] {
  const byDate = new Map<string, CsvRow>();
  for (const r of existing) byDate.set(r.date, r);
  for (const r of fresh) byDate.set(r.date, r); // fresh 우선
  return finalize([...byDate.values()]);
}

export function serializeCsv(rows: CsvRow[]): string {
  const lines = rows.map(
    (r) =>
      `${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume},${r.vwap},${r.factor},${r.change}`,
  );
  return [HEADER, ...lines].join('\n') + '\n';
}

export function parseCsv(text: string): CsvRow[] {
  const [head, ...body] = text.trim().split('\n');
  if (head !== HEADER) throw new Error(`unexpected CSV header: ${head}`);
  return body.filter(Boolean).map((line) => {
    const [date, open, high, low, close, volume, vwap, factor, change] = line.split(',');
    return {
      date: date ?? '',
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
      vwap: Number(vwap),
      factor: Number(factor),
      change: Number(change),
    };
  });
}
