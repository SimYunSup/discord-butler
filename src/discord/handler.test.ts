import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canApproveGate } from './handler.js';

const OWNER = 'owner-1';
// 'github' is a perUserGitHubAuth bot in the registry; key embeds the requester.
const KEY = 'github__u-requester-9';
const REQUESTER = 'requester-9';

test('owner may always approve', () => {
  assert.equal(canApproveGate(KEY, OWNER, OWNER, REQUESTER), true);
  // even a code-execution (owner-only) gate:
  assert.equal(canApproveGate(KEY, OWNER, OWNER, REQUESTER, true), true);
});

test('perUserGitHubAuth requester self-approves a non-code-exec gate', () => {
  assert.equal(canApproveGate(KEY, REQUESTER, OWNER, REQUESTER), true);
});

test('requester may NOT self-approve a code-execution gate (owner-only, RCE defense)', () => {
  assert.equal(canApproveGate(KEY, REQUESTER, OWNER, REQUESTER, true), false);
});

test('a stranger is denied', () => {
  assert.equal(canApproveGate(KEY, 'someone-else', OWNER, REQUESTER), false);
});

test('non-perUserGitHubAuth bot: only the owner may approve', () => {
  // A key whose botId is not a perUserGitHubAuth bot → requester can't self-approve.
  assert.equal(canApproveGate('finance__u5', '5', OWNER, '5'), false);
  assert.equal(canApproveGate('finance__u5', OWNER, OWNER, '5'), true);
});
