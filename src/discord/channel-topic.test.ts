import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChannelTopic } from './channel-topic.js';
import type { Bot } from '../bots/types.js';

const base = (over: Partial<Bot>): Bot =>
  ({
    id: 'x',
    channelName: 'x',
    displayName: 'X',
    shared: false,
    memoryMode: 'task',
    allowedTools: [],
    persona: '',
    ...over,
  }) as Bot;

test('buildChannelTopic: appends a uniform model·effort·/설명 tag to the usage text', () => {
  assert.equal(
    buildChannelTopic(base({ usage: '목적지·기간·예산을 알려주면 일정을 짜줘요.', model: 'opus', effort: 'high' })),
    '목적지·기간·예산을 알려주면 일정을 짜줘요.\n\n🧠 opus · effort high · 상세 /설명',
  );
});

test('buildChannelTopic: unset model/effort → 기본, and usage-less bot still gets the tag', () => {
  assert.equal(buildChannelTopic(base({ usage: '', model: undefined, effort: undefined })), '🧠 기본 · effort 기본 · 상세 /설명');
  assert.match(buildChannelTopic(base({ usage: 'x', model: 'haiku' })), /🧠 haiku · effort 기본 · 상세 \/설명$/);
});
