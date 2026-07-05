// U4 CLI: node --import tsx scripts/finance-brief/write-brief.mjs
// signals.json → <repo>/data/finance/시장브리핑-latest.md (sharedRefs['finance']).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { renderBrief } from '../../src/finance-brief/brief.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const signalsPath = resolve(repo, 'data/finance-brief/signals.json');
const financeDir = resolve(repo, 'data/finance');
await mkdir(financeDir, { recursive: true });

const signals = JSON.parse(await readFile(signalsPath, 'utf8'));
const md = renderBrief(signals);
await writeFile(resolve(financeDir, '시장브리핑-latest.md'), md);
await writeFile(resolve(financeDir, `시장브리핑-${signals.asof}.md`), md);
console.log(`wrote 시장브리핑-latest.md (asof ${signals.asof}, ic ${signals.meta.ic})`);
