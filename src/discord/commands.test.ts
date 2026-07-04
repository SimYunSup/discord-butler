import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUserApiJson, validateToken } from './commands.js';

test('parseUserApiJson: valid gh api user JSON → identity', () => {
  const out = JSON.stringify({ id: 583231, login: 'octocat', name: 'The Octocat' });
  assert.deepEqual(parseUserApiJson(out), { id: 583231, login: 'octocat', name: 'The Octocat' });
});

test('parseUserApiJson: null name falls back to login', () => {
  const out = JSON.stringify({ id: 1, login: 'ghost', name: null });
  assert.deepEqual(parseUserApiJson(out), { id: 1, login: 'ghost', name: 'ghost' });
});

test('parseUserApiJson: missing id/login → undefined', () => {
  assert.equal(parseUserApiJson(JSON.stringify({ login: 'x' })), undefined);
  assert.equal(parseUserApiJson('not json'), undefined);
});

test('validateToken: gh success → identity', async () => {
  const fakeRun = (async () => ({
    stdout: JSON.stringify({ id: 42, login: 'me', name: 'Me' }),
    stderr: '',
  })) as unknown as Parameters<typeof validateToken>[1];
  const res = await validateToken('ghp_x', fakeRun);
  assert.deepEqual(res, { id: 42, login: 'me', name: 'Me' });
});

test('validateToken: gh throws (bad credentials) → {error}', async () => {
  const fakeRun = (async () => {
    throw new Error('HTTP 401: Bad credentials');
  }) as unknown as Parameters<typeof validateToken>[1];
  const res = await validateToken('ghp_bad', fakeRun);
  assert.ok('error' in res);
  assert.match((res as { error: string }).error, /401|Bad credentials/);
});
