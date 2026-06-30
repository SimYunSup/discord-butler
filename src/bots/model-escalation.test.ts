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
