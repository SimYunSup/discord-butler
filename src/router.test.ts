import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from './bots/types.js';
import { conversationKey, sanitizeKey } from './router.js';

const base: Bot = {
  id: 'demo',
  channelName: 'demo',
  displayName: 'demo',
  persona: '...',
  allowedTools: ['Read'],
  shared: false,
  memoryMode: 'task',
};

it('personal bot → botId (threadId ignored)', () => {
  assert.equal(conversationKey(base, 'u1'), 'demo');
  assert.equal(conversationKey(base, 'u1', 't9'), 'demo');
});

it('shared bot → botId__userId', () => {
  assert.equal(conversationKey({ ...base, shared: true }, 'u1'), 'demo__u1');
});

it('threadPerMessage with a threadId → botId__thread_<threadId>', () => {
  const bot = { ...base, threadPerMessage: true };
  assert.equal(conversationKey(bot, 'u1', 't9'), 'demo__thread_t9');
});

it('threadPerMessage without a threadId falls back to the author-derived key', () => {
  // Invariant: a threadId only FURTHER-scopes; it never replaces author derivation.
  const bot = { ...base, threadPerMessage: true };
  assert.equal(conversationKey(bot, 'u1'), 'demo');
});

it('perUserGitHubAuth + threadPerMessage embeds the userId (token isolation)', () => {
  const bot = { ...base, threadPerMessage: true, perUserGitHubAuth: true };
  // Two users on the SAME thread id get DIFFERENT keys → never share a token window.
  assert.equal(conversationKey(bot, 'u1', 't9'), 'demo__thread_t9__uu1');
  assert.equal(conversationKey(bot, 'u2', 't9'), 'demo__thread_t9__uu2');
});

it('shared perUserGitHubAuth bot (no threadPerMessage) keys by user', () => {
  // The bundled GitHub bots are shared-only → key embeds the userId directly.
  const bot = { ...base, shared: true, perUserGitHubAuth: true };
  assert.equal(conversationKey(bot, 'u1'), 'demo__u1');
});

it('sanitizeKey keeps the key tmux/fs-safe', () => {
  assert.equal(sanitizeKey('demo__thread_123.456:7'), 'demo__thread_123_456_7');
});
