import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelTier } from './model-escalation.js';

const ESC = {
  modelTriggers: ['opus', '오퍼스'],
  escalatedModel: 'opus',
  effortTriggers: ['깊게', '심층', 'deep'],
  escalatedEffort: 'xhigh',
  modelResetTriggers: ['소넷으로', '원래대로'],
  effortResetTriggers: ['가볍게', '원래대로'],
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

test('escalation is STICKY: a triggerless message keeps the prior tier', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  const sticky = { model: 'opus', effort: 'xhigh' };
  // No trigger this turn → carry the sticky tier forward, not snap back to base.
  assert.deepEqual(resolveModelTier(base, ESC, '그래서 다음은?', sticky), {
    model: 'opus',
    effort: 'xhigh',
  });
  // Sticky on one axis carries only that axis.
  assert.deepEqual(resolveModelTier(base, ESC, '계속해줘', { model: 'opus' }), {
    model: 'opus',
    effort: 'medium',
  });
});

test('a de-escalation trigger RESETS its axis back to the base', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  const sticky = { model: 'opus', effort: 'xhigh' };
  // Effort reset only → effort to base, model stays sticky.
  assert.deepEqual(resolveModelTier(base, ESC, '이제 가볍게 가자', sticky), {
    model: 'opus',
    effort: 'medium',
  });
  // A reset word hitting both axes → both back to base.
  assert.deepEqual(resolveModelTier(base, ESC, '원래대로 돌려줘', sticky), {
    model: 'sonnet',
    effort: 'medium',
  });
});

test('de-escalation beats an escalation trigger in the SAME message', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  const sticky = { model: 'opus', effort: 'xhigh' };
  assert.deepEqual(resolveModelTier(base, ESC, '원래대로, opus 말고 심층도 말고', sticky), {
    model: 'sonnet',
    effort: 'medium',
  });
});

test('a fresh escalation trigger re-escalates a de-escalated axis', () => {
  const base = { model: 'sonnet', effort: 'medium' };
  assert.deepEqual(resolveModelTier(base, ESC, '다시 심층으로', base), {
    model: 'sonnet',
    effort: 'xhigh',
  });
});
