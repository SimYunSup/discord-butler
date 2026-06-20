import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idleSessionKeys } from './reaper.js';
import type { SessionMap } from './persistence/session-map.js';

const NOW = Date.parse('2026-06-20T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function entry(hoursAgo: number) {
  return { window: 'w', cwd: '/c', lastActivityIso: new Date(NOW - hoursAgo * HOUR).toISOString() };
}

test('idleSessionKeys returns only conversations idle past the cutoff', () => {
  const map: SessionMap = {
    fresh: entry(1), // 1h ago → keep
    edge: entry(5), // exactly 5h ago → NOT strictly older → keep
    stale: entry(6), // 6h ago → reap
    ancient: entry(48), // reap
  };
  assert.deepEqual(idleSessionKeys(map, NOW, 5 * HOUR).sort(), ['ancient', 'stale']);
});

test('idleSessionKeys skips entries with an empty/unparsable timestamp (never reap on bad data)', () => {
  const map: SessionMap = {
    bad: { window: 'w', cwd: '/c', lastActivityIso: '' },
    nan: { window: 'w', cwd: '/c', lastActivityIso: 'not-a-date' },
    old: entry(10),
  };
  assert.deepEqual(idleSessionKeys(map, NOW, 5 * HOUR), ['old']);
});

test('idleSessionKeys is empty when nothing is stale', () => {
  assert.deepEqual(idleSessionKeys({ a: entry(0.5), b: entry(2) }, NOW, 5 * HOUR), []);
});
