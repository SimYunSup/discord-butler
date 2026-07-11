import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelTier } from './model-escalation.js';

const ESC = {
  modelTriggers: ['opus', '오퍼스'],
  escalatedModel: 'opus',
  effortTriggers: ['깊게', '심층', 'deep'],
  escalatedEffort: 'xhigh',
};

test('no escalation config → base tier unchanged', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, undefined, '아무 텍스트'), base);
});

test('no trigger match → base tier on both axes', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, ESC, '평범한 질문'), {
    model: 'sonnet',
    effort: 'medium',
  });
});

test('model axis only: "opus" bumps model, leaves effort', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, ESC, 'opus로 답해줘'), {
    model: 'opus',
    effort: 'medium',
  });
});

test('effort axis only: "심층" bumps effort, leaves model', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, ESC, '심층 분석 부탁'), {
    model: 'sonnet',
    effort: 'xhigh',
  });
});

test('both axes compose: "opus" + "deep" → escalated model AND effort', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, ESC, 'opus deep dive'), {
    model: 'opus',
    effort: 'xhigh',
  });
});

test('matching is case-insensitive', () => {
  const base = { model: 'haiku', effort: 'low' };
  assert.deepEqual(resolveModelTier(base, ESC, 'OPUS please'), {
    model: 'opus',
    effort: 'low',
  });
});

import { buildModelSwitchCommands, matchedEscalationTriggers } from './model-escalation.js';

const ESC_RESET = {
  ...ESC,
  modelResetTriggers: ['원래대로', '기본으로'],
  effortResetTriggers: ['가볍게', '원래대로'],
};

test('sticky: a triggerless message keeps the previous (escalated) tier', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(
    resolveModelTier(base, ESC, '평범한 후속 질문', { model: 'opus', effort: 'xhigh' }),
    { model: 'opus', effort: 'xhigh' },
  );
});

test('de-escalation word resets an axis to base, overriding sticky AND an escalate word in the same message', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  // "opus" would escalate model, but "원래대로" resets it; effort "가볍게" resets from sticky xhigh.
  assert.deepEqual(
    resolveModelTier(base, ESC_RESET, 'opus인데 원래대로 가볍게', { model: 'opus', effort: 'xhigh' }),
    { model: 'sonnet', effort: 'medium' },
  );
});

test('buildModelSwitchCommands emits only the axes that changed', () => {
  assert.deepEqual(buildModelSwitchCommands({ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'medium' }), ['/model opus']);
  assert.deepEqual(buildModelSwitchCommands({ model: 'opus', effort: 'medium' }, { model: 'opus', effort: 'xhigh' }), ['/effort xhigh']);
  assert.deepEqual(buildModelSwitchCommands({ model: 'opus', effort: 'xhigh' }, { model: 'opus', effort: 'xhigh' }), []);
});

test('matchedEscalationTriggers reports the first fired word per axis (incl. resets)', () => {
  const m = matchedEscalationTriggers(ESC_RESET, 'opus 심층 원래대로 가볍게');
  assert.equal(m.model, 'opus');
  assert.equal(m.effort, '심층');
  assert.equal(m.modelReset, '원래대로');
  assert.equal(m.effortReset, '가볍게');
});
