import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputProbe, paneShowsProbe, nextSendAction } from './manager.js';

test('inputProbe takes the trimmed first line, capped at 20 chars', () => {
  assert.equal(inputProbe('  React 19 use 훅 동작 원리\n둘째 줄'), 'React 19 use 훅 동작 원리'.slice(0, 20));
  assert.equal(inputProbe('short'), 'short');
  assert.equal(inputProbe(''), '');
});

test('paneShowsProbe is false for an empty probe (never matches)', () => {
  assert.equal(paneShowsProbe('anything', ''), false);
  assert.equal(paneShowsProbe('❯ hello world', 'hello world'), true);
  assert.equal(paneShowsProbe('❯ ', 'hello world'), false);
});

// Idle, empty input box (a freshly-launched REPL that dropped the paste).
const IDLE_EMPTY = `
 ▐▛███▜▌   Claude Code v2.1.183
────────
❯
────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

// Message typed into the box but not yet submitted.
const TYPED_NOT_SENT = `
────────
❯ React 19 use 훅 동작 원리
────────
  ⏵⏵ auto mode on (shift+tab to cycle)
`;

// claude actively processing the turn.
const WORKING = `
❯ React 19 use 훅 동작 원리
✻ Synthesizing… (esc to interrupt · 1.2k tokens)
`;

test('nextSendAction: empty box → retype (the dropped-paste recovery)', () => {
  assert.equal(nextSendAction(IDLE_EMPTY, 'React 19 use 훅 동작 원리'), 'retype');
});

test('nextSendAction: message in box, not submitted → enter', () => {
  assert.equal(nextSendAction(TYPED_NOT_SENT, 'React 19 use 훅 동작 원리'), 'enter');
});

test('nextSendAction: claude processing → done', () => {
  assert.equal(nextSendAction(WORKING, 'React 19 use 훅 동작 원리'), 'done');
});
