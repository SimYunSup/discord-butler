import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  noreplyEmail,
  saveGitHubSecret,
  loadGitHubSecret,
  removeGitHubSecret,
  githubTokenEnv,
  secretPath,
} from './github-token.js';

const SECRET = {
  login: 'octocat',
  id: 583231,
  name: 'The Octocat',
  email: '583231+octocat@users.noreply.github.com',
  token: 'ghp_TESTTOKEN',
  addedAt: '2026-06-27T00:00:00Z',
};

test('noreplyEmail: id+login noreply form', () => {
  assert.equal(noreplyEmail(583231, 'octocat'), '583231+octocat@users.noreply.github.com');
});

test('secretPath: secrets/github/<id>.json OUTSIDE any workspace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  assert.equal(secretPath(dir, '42'), join(dir, 'secrets', 'github', '42.json'));
});

test('save→load round-trip + file mode 0600', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  await saveGitHubSecret(dir, '42', SECRET);
  const loaded = await loadGitHubSecret(dir, '42');
  assert.deepEqual(loaded, SECRET);
  const mode = (await stat(secretPath(dir, '42'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('githubTokenEnv: stored token → GH_TOKEN + GIT_* env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  await saveGitHubSecret(dir, '42', SECRET);
  const env = await githubTokenEnv(dir, '42');
  assert.equal(env?.GH_TOKEN, 'ghp_TESTTOKEN');
  assert.equal(env?.GITHUB_TOKEN, 'ghp_TESTTOKEN');
  assert.equal(env?.GIT_AUTHOR_NAME, 'The Octocat');
  assert.equal(env?.GIT_AUTHOR_EMAIL, SECRET.email);
  assert.equal(env?.GIT_COMMITTER_NAME, 'The Octocat');
  assert.equal(env?.GIT_COMMITTER_EMAIL, SECRET.email);
});

test('githubTokenEnv: empty name falls back to login', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  await saveGitHubSecret(dir, '7', { ...SECRET, name: '' });
  const env = await githubTokenEnv(dir, '7');
  assert.equal(env?.GIT_AUTHOR_NAME, 'octocat');
});

test('githubTokenEnv: unregistered user → undefined (hard-gate signal)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  assert.equal(await githubTokenEnv(dir, 'nobody'), undefined);
});

test('remove: after delete load is undefined, second delete is false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'butler-'));
  await saveGitHubSecret(dir, '42', SECRET);
  assert.equal(await removeGitHubSecret(dir, '42'), true);
  assert.equal(await loadGitHubSecret(dir, '42'), undefined);
  assert.equal(await removeGitHubSecret(dir, '42'), false);
});
