import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from '../bots/types.js';
import type { ButlerConfig } from '../config.js';
import { getBackend, isAgentKind, resolveBackend } from './index.js';

const config = {
  claudeBin: 'claude',
  kimi: { baseUrl: 'https://example/anthropic', authToken: '', model: '' },
  glm: { baseUrl: 'https://example/anthropic', authToken: '', model: '' },
  codex: { pluginDir: '' },
} as unknown as ButlerConfig;

const bot = (agent?: Bot['agent']): Bot =>
  ({
    id: 'b',
    channelName: 'c',
    displayName: 'd',
    persona: 'p',
    allowedTools: ['Read'],
    shared: false,
    memoryMode: 'task',
    agent,
  }) as Bot;

it('isAgentKind accepts known kinds, rejects others', () => {
  assert.equal(isAgentKind('claude'), true);
  assert.equal(isAgentKind('kimi'), true);
  assert.equal(isAgentKind('glm'), true);
  assert.equal(isAgentKind('codex'), true);
  assert.equal(isAgentKind('gpt'), false);
});

it('claude backend uses CLAUDE.md, the claudeBin, no extra env', () => {
  const b = getBackend('claude');
  assert.equal(b.instructionsFile, 'CLAUDE.md');
  const launch = b.launch(config);
  assert.equal(launch.bin, 'claude');
  assert.deepEqual(launch.args, []);
  assert.deepEqual(launch.env, {});
});

it('resolveBackend honors bot.agent, then the default', () => {
  assert.equal(resolveBackend(bot('kimi'), 'claude').kind, 'kimi');
  assert.equal(resolveBackend(bot(), 'kimi').kind, 'kimi');
  assert.equal(resolveBackend(bot(), 'claude').kind, 'claude');
});

it('kimi backend throws a clear error when KIMI_AUTH_TOKEN is missing', () => {
  assert.throws(() => getBackend('kimi').launch(config), /KIMI_AUTH_TOKEN/);
});

it('kimi backend sets Anthropic env (and ANTHROPIC_MODEL only when a model is set)', () => {
  const withToken = {
    ...config,
    kimi: { baseUrl: 'https://example/anthropic', authToken: 'sk-test', model: '' },
  } as ButlerConfig;
  const launch = getBackend('kimi').launch(withToken);
  assert.equal(launch.bin, 'claude');
  assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://example/anthropic');
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'sk-test');
  assert.equal('ANTHROPIC_MODEL' in launch.env, false);

  const withModel = {
    ...config,
    kimi: { baseUrl: 'https://example/anthropic', authToken: 'sk-test', model: 'kimi-k2' },
  } as ButlerConfig;
  assert.equal(getBackend('kimi').launch(withModel).env.ANTHROPIC_MODEL, 'kimi-k2');
});

it('glm backend throws a clear error when GLM_AUTH_TOKEN is missing', () => {
  assert.throws(() => getBackend('glm').launch(config), /GLM_AUTH_TOKEN/);
});

it('glm backend sets Anthropic env (and ANTHROPIC_MODEL only when a model is set)', () => {
  const withToken = {
    ...config,
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', authToken: 'sk-test', model: '' },
  } as ButlerConfig;
  const launch = getBackend('glm').launch(withToken);
  assert.equal(launch.bin, 'claude');
  assert.equal(launch.env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, 'sk-test');
  assert.equal('ANTHROPIC_MODEL' in launch.env, false);

  const withModel = {
    ...config,
    glm: { baseUrl: 'https://api.z.ai/api/anthropic', authToken: 'sk-test', model: 'glm-4.7' },
  } as ButlerConfig;
  assert.equal(getBackend('glm').launch(withModel).env.ANTHROPIC_MODEL, 'glm-4.7');
});

it('codex backend uses CLAUDE.md and throws without CODEX_PLUGIN_DIR', () => {
  const b = getBackend('codex');
  assert.equal(b.instructionsFile, 'CLAUDE.md');
  assert.throws(() => b.launch(config), /CODEX_PLUGIN_DIR/);
});

it('codex backend loads the plugin via --plugin-dir when CODEX_PLUGIN_DIR is set', () => {
  const withPlugin = { ...config, codex: { pluginDir: '/opt/codex-plugin-cc' } } as ButlerConfig;
  const launch = getBackend('codex').launch(withPlugin);
  assert.equal(launch.bin, 'claude');
  assert.deepEqual(launch.args, ['--plugin-dir', '/opt/codex-plugin-cc']);
  assert.deepEqual(launch.env, {});
});
