import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyedQueue } from './keyed-queue.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('runs same-key tasks sequentially, in submission order, never overlapping', async () => {
  const q = new KeyedQueue();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const task = (id: string) => async (): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${id}`);
    await delay(20);
    events.push(`end:${id}`);
    active--;
    return id;
  };

  const results = await Promise.all([
    q.run('k', task('a')),
    q.run('k', task('b')),
    q.run('k', task('c')),
  ]);

  // This is the bug: concurrent same-key turns must NOT overlap, or two awaiters
  // tail the same events file and resolve on the same Stop → duplicate replies.
  assert.equal(maxActive, 1, 'same-key tasks overlapped');
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(events, [
    'start:a', 'end:a',
    'start:b', 'end:b',
    'start:c', 'end:c',
  ]);
});

test('runs different-key tasks concurrently', async () => {
  const q = new KeyedQueue();
  let active = 0;
  let maxActive = 0;
  const task = () => async (): Promise<void> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await delay(30);
    active--;
  };

  await Promise.all([q.run('a', task()), q.run('b', task()), q.run('c', task())]);

  assert.equal(maxActive, 3, 'different-key tasks were serialized');
});

test('a rejected task does not block later same-key tasks', async () => {
  const q = new KeyedQueue();
  const p1 = q.run('k', async () => {
    throw new Error('boom');
  });
  await assert.rejects(p1, /boom/);
  const p2 = q.run('k', async () => 'ok');
  assert.equal(await p2, 'ok');
});
