// U1 CLI: node --import tsx scripts/finance-brief/fetch-candles.mjs
// .env(TOSSINVEST_CLIENT_ID/SECRET)가 process.env에 있어야 함.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runFetch } from '../../src/finance-brief/run-fetch.ts';
import { TossCandleSource } from '../../src/finance-brief/candle-source.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const dir = resolve(repo, 'data/finance-brief/candles');
await mkdir(dir, { recursive: true });
const universe = JSON.parse(await readFile(resolve(here, 'universe.kospi200.json'), 'utf8'));

const results = await runFetch({
  source: new TossCandleSource(),
  universe,
  dir,
  targetStart: process.env.FB_TARGET_START ?? '2019-01-01',
  readFile: async (p) => readFile(p, 'utf8').catch(() => null),
  writeFile: (p, s) => writeFile(p, s),
});
console.log(
  `fetched ${results.length} symbols:`,
  results.map((r) => `${r.symbol}:${r.rows}`).join(' '),
);
