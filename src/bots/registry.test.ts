import { it } from 'node:test';
import assert from 'node:assert/strict';
import { bots } from './registry.js';

it('registry has eight bots', () => {
  const ids = bots.map((b) => b.id).sort();
  assert.deepEqual(ids, [
    'ask',
    'counseling',
    'finance',
    'planning',
    'research',
    'resume',
    'saju',
    'travel',
  ]);
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

it('counseling and resume are shared with threadPerMessage', () => {
  const counseling = bots.find((b) => b.id === 'counseling');
  assert.equal(counseling!.shared, true);
  assert.equal(counseling!.threadPerMessage, true);
  assert.equal(counseling!.memoryMode, 'companion');

  const resume = bots.find((b) => b.id === 'resume');
  assert.equal(resume!.shared, true);
  assert.equal(resume!.threadPerMessage, true);
});

it('research and ask use threadPerMessage (personal)', () => {
  const research = bots.find((b) => b.id === 'research');
  assert.equal(research!.shared, false);
  assert.equal(research!.threadPerMessage, true);

  const ask = bots.find((b) => b.id === 'ask');
  assert.equal(ask!.shared, false);
  assert.equal(ask!.threadPerMessage, true);
  assert.equal(ask!.channelName, '일반');
});
