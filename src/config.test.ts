import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.js';

const base = { DISCORD_TOKEN: 'tok' } as NodeJS.ProcessEnv;

it('defaults httpPort=8787 and triggerToken=""', () => {
  const c = loadConfig({ ...base });
  assert.equal(c.httpPort, 8787);
  assert.equal(c.triggerToken, '');
});

it('parses BUTLER_HTTP_PORT and BUTLER_TRIGGER_TOKEN', () => {
  const c = loadConfig({ ...base, BUTLER_HTTP_PORT: '9000', BUTLER_TRIGGER_TOKEN: 'sek' });
  assert.equal(c.httpPort, 9000);
  assert.equal(c.triggerToken, 'sek');
});

it('throws on invalid BUTLER_HTTP_PORT', () => {
  assert.throws(() => loadConfig({ ...base, BUTLER_HTTP_PORT: 'abc' }));
});

it('defaults replyTimeoutMs=3600000 (backstop) and idleTimeoutMs=1800000', () => {
  const c = loadConfig({ ...base });
  assert.equal(c.replyTimeoutMs, 3_600_000);
  assert.equal(c.idleTimeoutMs, 1_800_000);
});

it('parses BUTLER_IDLE_TIMEOUT_MS and throws on invalid', () => {
  assert.equal(loadConfig({ ...base, BUTLER_IDLE_TIMEOUT_MS: '60000' }).idleTimeoutMs, 60_000);
  assert.throws(() => loadConfig({ ...base, BUTLER_IDLE_TIMEOUT_MS: '0' }));
  assert.throws(() => loadConfig({ ...base, BUTLER_IDLE_TIMEOUT_MS: 'abc' }));
});

it('defaults the agent to claude and kimi auth empty', () => {
  const c = loadConfig({ ...base });
  assert.equal(c.defaultAgent, 'claude');
  assert.equal(c.kimi.authToken, '');
  assert.equal(c.kimi.baseUrl, 'https://api.moonshot.ai/anthropic');
});

it('parses BUTLER_AGENT and KIMI_* env', () => {
  const c = loadConfig({
    ...base,
    BUTLER_AGENT: 'kimi',
    KIMI_BASE_URL: 'https://api.moonshot.cn/anthropic',
    KIMI_AUTH_TOKEN: 'sk-x',
    KIMI_MODEL: 'kimi-k2',
  });
  assert.equal(c.defaultAgent, 'kimi');
  assert.equal(c.kimi.baseUrl, 'https://api.moonshot.cn/anthropic');
  assert.equal(c.kimi.authToken, 'sk-x');
  assert.equal(c.kimi.model, 'kimi-k2');
});

it('throws on an unknown BUTLER_AGENT', () => {
  assert.throws(() => loadConfig({ ...base, BUTLER_AGENT: 'gpt' }));
});

it('accepts BUTLER_AGENT=codex and reads CODEX_PLUGIN_DIR', () => {
  const c = loadConfig({ ...base, BUTLER_AGENT: 'codex', CODEX_PLUGIN_DIR: '/opt/codex-plugin-cc' });
  assert.equal(c.defaultAgent, 'codex');
  assert.equal(c.codex.pluginDir, '/opt/codex-plugin-cc');
});
