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
