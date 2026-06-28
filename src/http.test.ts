import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { startTriggerServer, type TriggerDeps } from './http.js';
import type { ButlerConfig } from './config.js';

const cfg: ButlerConfig = {
  discordToken: 'x',
  dataDir: '/tmp',
  claudeBin: 'claude',
  tmuxBin: 'tmux',
  replyTimeoutMs: 1000,
  idleTimeoutMs: 1000,
  httpPort: 0,
  triggerToken: 'secret',
  defaultAgent: 'claude',
  fallbackAgents: [],
  kimi: { baseUrl: 'https://api.moonshot.ai/anthropic', authToken: '', model: '' },
  glm: { baseUrl: 'https://api.z.ai/api/anthropic', authToken: '', model: '' },
  codex: { pluginDir: '' },
};

async function withServer(deps: TriggerDeps, fn: (port: number) => Promise<void>): Promise<void> {
  const server = startTriggerServer(cfg, deps)!;
  await new Promise<void>((r) => server.on('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

it('disabled (returns undefined) when no triggerToken', () => {
  const s = startTriggerServer({ ...cfg, triggerToken: '' }, { trigger: async () => {} });
  assert.equal(s, undefined);
});

it('401 on bad token, trigger not called', async () => {
  let called = false;
  const deps: TriggerDeps = { trigger: async () => { called = true; } };
  await withServer(deps, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/trigger/planning`, {
      method: 'POST',
      headers: { 'x-butler-token': 'wrong' },
    });
    assert.equal(res.status, 401);
    await new Promise((r) => setImmediate(r));
    assert.equal(called, false);
  });
});

it('404 for an unknown bot id', async () => {
  await withServer({ trigger: async () => {} }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/trigger/nope`, {
      method: 'POST',
      headers: { 'x-butler-token': 'secret' },
    });
    assert.equal(res.status, 404);
  });
});

it('404 for a bot without a triggerPrompt (planning)', async () => {
  await withServer({ trigger: async () => {} }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/trigger/planning`, {
      method: 'POST',
      headers: { 'x-butler-token': 'secret' },
    });
    assert.equal(res.status, 404);
  });
});

it('healthz returns ok', async () => {
  await withServer({ trigger: async () => {} }, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});
