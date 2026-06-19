import { it } from 'node:test';
import assert from 'node:assert/strict';
import { bots } from './registry.js';

it('registry has the four bots', () => {
  const ids = bots.map((b) => b.id).sort();
  assert.deepEqual(ids, ['finance', 'planning', 'saju', 'travel']);
});

it('every bot is fully defined', () => {
  for (const b of bots) {
    assert.ok(b.id && b.channelName && b.displayName && b.persona, `bot ${b.id} complete`);
    assert.ok(b.allowedTools.length > 0, `bot ${b.id} has tools`);
  }
});

it('saju is shared; finance persists via the finance sharedRef + flushOnEnd', () => {
  const saju = bots.find((b) => b.id === 'saju');
  assert.equal(saju!.shared, true);
  const finance = bots.find((b) => b.id === 'finance');
  assert.ok(finance!.sharedRefs?.includes('finance'), 'finance uses finance dir');
  assert.ok(finance!.flushOnEnd, 'finance flushes on /end');
});
