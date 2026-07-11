import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isInterruptCommand, isEndCommand, tailEventsForStop, InterruptError } from './bridge.js';

test('isInterruptCommand matches aliases; /그만 is an END command, not interrupt', () => {
  for (const c of ['/interrupt', '/stop', '/중단', '/멈춰', '/멈춤', '  /STOP  ']) assert.ok(isInterruptCommand(c), c);
  assert.ok(!isInterruptCommand('/그만'));
  assert.ok(isEndCommand('/그만'));
  assert.ok(!isInterruptCommand('그냥 텍스트'));
});

test('aborting the signal rejects the tail with InterruptError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-int-'));
  const events = join(dir, 'e.jsonl');
  await writeFile(events, '');
  const ac = new AbortController();
  const p = tailEventsForStop(events, { onReply: () => {} }, { idleTimeoutMs: 5000, maxTimeoutMs: 9000, pollMs: 20 }, ac.signal);
  setTimeout(() => ac.abort(), 60);
  await assert.rejects(p, (e) => e instanceof InterruptError);
});

test('an already-aborted signal rejects immediately with InterruptError', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-int-'));
  const events = join(dir, 'e.jsonl');
  await writeFile(events, '');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    tailEventsForStop(events, { onReply: () => {} }, { idleTimeoutMs: 5000, maxTimeoutMs: 9000, pollMs: 20 }, ac.signal),
    (e) => e instanceof InterruptError,
  );
});
