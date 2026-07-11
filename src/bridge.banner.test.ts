import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineBanner } from './bridge.js';

test('engineBanner: claude shows 🧠 + model + effort', () => {
  assert.equal(engineBanner('claude', 'opus', 'high'), '🧠 **Claude** · `opus` · high');
});

test('engineBanner: fallback engine shows ⚙️ and omits an absent model/effort', () => {
  assert.equal(engineBanner('kimi'), '⚙️ **Kimi**');
  assert.equal(engineBanner('glm', 'glm-4.6'), '⚙️ **GLM** · `glm-4.6`');
});

test('engineBanner: escalation up/down markers name the trigger', () => {
  assert.equal(
    engineBanner('claude', 'opus', 'xhigh', ['opus', '심층']),
    '🧠 **Claude** · `opus` · xhigh · ⬆️ 격상(트리거: opus·심층)',
  );
  assert.equal(
    engineBanner('claude', 'sonnet', 'medium', [], ['원래대로']),
    '🧠 **Claude** · `sonnet` · medium · ⬇️ 격하(트리거: 원래대로)',
  );
});
