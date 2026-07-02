import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadSessionKeys, idleSessionKeys, orphanWindowNames } from './reaper.js';
import type { SessionMap } from './persistence/session-map.js';
import type { TmuxWindowInfo } from './tmux/manager.js';

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

test('orphanWindowNames returns tmux windows not tracked by session-map', () => {
  const map: SessionMap = {
    a: { ...entry(1), window: 'tracked-a' },
    b: { ...entry(1), window: 'tracked-b' },
  };
  const windows: TmuxWindowInfo[] = [
    { name: 'tracked-a', command: 'claude', dead: false },
    { name: 'orphan', command: 'claude', dead: false },
    { name: 'tracked-b', command: 'claude', dead: false },
  ];
  assert.deepEqual(orphanWindowNames(map, windows), ['orphan']);
});

test('deadSessionKeys includes missing windows and shells left after CLI exit', () => {
  const map: SessionMap = {
    missing: { ...entry(1), window: 'missing-window' },
    shell: { ...entry(1), window: 'shell-window' },
    dead: { ...entry(1), window: 'dead-window' },
    live: { ...entry(1), window: 'live-window' },
  };
  const windows: TmuxWindowInfo[] = [
    { name: 'shell-window', command: 'bash', dead: false },
    { name: 'dead-window', command: 'claude', dead: true },
    { name: 'live-window', command: 'claude', dead: false },
  ];
  assert.deepEqual(deadSessionKeys(map, windows).sort(), ['dead', 'missing', 'shell']);
});
