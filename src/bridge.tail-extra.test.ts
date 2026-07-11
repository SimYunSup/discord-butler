import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailEventsForStop } from './bridge.js';

const NOOP = { onReply: () => {} };
const line = (event: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ event, ts: new Date().toISOString(), payload }) + '\n';

test('onStop streaming mode relays EVERY Stop and keeps tailing (async-followup)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-tail-'));
  const events = join(dir, 'e.jsonl');
  await writeFile(events, '');
  const relayed: string[] = [];
  const p = tailEventsForStop(events, NOOP, { idleTimeoutMs: 400, maxTimeoutMs: 5000, pollMs: 20, onStop: (t) => relayed.push(t) });
  for (const msg of ['web done', 'ingest done', 'core done']) {
    await new Promise((r) => setTimeout(r, 120));
    await appendFile(events, line('Stop', { last_assistant_message: msg }));
  }
  await assert.rejects(p, /idle/i); // settles only on idle, after relaying all three
  assert.deepEqual(relayed, ['web done', 'ingest done', 'core done']);
});

test('survives cleanup-daemon rotation mid-wait and resolves on the post-rotation Stop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-tail-'));
  const events = join(dir, 'e.jsonl');
  await writeFile(events, line('PostToolUse').repeat(40) + line('Stop', { last_assistant_message: 'OLD' }));
  const p = tailEventsForStop(events, NOOP, { idleTimeoutMs: 2000, maxTimeoutMs: 8000, pollMs: 20 });
  await new Promise((r) => setTimeout(r, 60)); // seek past the old Stop
  const tmp = join(dir, 'e.jsonl.tmp');
  await writeFile(tmp, line('Stop', { last_assistant_message: 'OLD' })); // retained tail, new inode, smaller
  await rename(tmp, events);
  await new Promise((r) => setTimeout(r, 120)); // observe rotation, re-anchor
  await appendFile(events, line('Stop', { last_assistant_message: 'NEW' }));
  assert.equal(await p, 'NEW');
});
