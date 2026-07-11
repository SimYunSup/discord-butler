import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderBotExplainer, summarizeCapabilities } from './bot-explainer.js';
import type { Bot } from '../bots/types.js';

const base = (over: Partial<Bot>): Bot =>
  ({ id: 'x', channelName: 'x', displayName: 'X', shared: false, memoryMode: 'task', allowedTools: [], persona: '', ...over }) as Bot;

test('renderBotExplainer: model/effort, escalation, de-escalation, memory, capabilities (no @라핏)', () => {
  const card = renderBotExplainer(
    base({
      channelName: '리서치', displayName: '리서치', model: 'sonnet', effort: 'medium', memoryMode: 'task',
      allowedTools: ['WebFetch', 'WebSearch', 'Read'],
      modelEscalation: {
        modelTriggers: ['opus'], escalatedModel: 'opus',
        effortTriggers: ['깊게', '심층'], escalatedEffort: 'xhigh',
        effortResetTriggers: ['원래대로', '가볍게'],
      },
    }),
  );
  assert.match(card, /#리서치/);
  assert.match(card, /🧠 모델 {2}`sonnet` · effort medium/);
  assert.match(card, /⬆️ 격상.*"opus" → 모델 opus/);
  assert.match(card, /"깊게"·"심층" → effort xhigh/);
  assert.match(card, /⬇️ 격하 {2}"원래대로"·"가볍게" → 기본으로/);
  assert.match(card, /🧵 메모리 {2}task/);
  assert.match(card, /🛠 기능 {2}웹 검색·자료 · 파일 읽기/);
  assert.doesNotMatch(card, /@라핏/, 'discord-butler has no codexOffload');
});

test('renderBotExplainer: merged line when model & effort share triggers; no-model → 기본', () => {
  const card = renderBotExplainer(
    base({ model: undefined, memoryMode: 'companion',
      modelEscalation: { modelTriggers: ['코드', '파일'], escalatedModel: 'sonnet', effortTriggers: ['코드', '파일'], escalatedEffort: 'high' } }),
  );
  assert.match(card, /🧠 모델 {2}기본/);
  assert.match(card, /⬆️ 격상 {2}"코드"·"파일" → 모델 sonnet \+ effort high/);
  assert.match(card, /🧵 메모리 {2}companion/);
});

test('summarizeCapabilities: maps, dedupes, order-stable; empty → 대화·글쓰기', () => {
  assert.equal(summarizeCapabilities(['mcp__notion__fetch', 'WebFetch', 'Read', 'Bash(gh:*)']), 'Notion · 웹 검색·자료 · 파일 읽기 · 셸 명령');
  assert.equal(summarizeCapabilities([]), '대화·글쓰기');
});
