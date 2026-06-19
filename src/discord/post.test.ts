import { it } from 'node:test';
import assert from 'node:assert/strict';
import { splitForDiscord, parseSelectBlock, parseFileBlock } from './post.js';

it('keeps short text as one chunk', () => {
  assert.deepEqual(splitForDiscord('hello'), ['hello']);
});

it('splits on newlines and round-trips with \\n join', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
  const chunks = splitForDiscord(text, 40);
  assert.ok(chunks.every((c) => c.length <= 40));
  assert.equal(chunks.join('\n'), text);
});

it('hard-slices a single overlong line', () => {
  const chunks = splitForDiscord('x'.repeat(100), 40);
  assert.deepEqual(chunks, ['x'.repeat(40), 'x'.repeat(40), 'x'.repeat(20)]);
});

it('parses a butler-select block and cleans the text', () => {
  const r = parseSelectBlock('pick:\n```butler-select\n- A\n- B\n```');
  assert.ok(r);
  assert.deepEqual(r!.options, ['A', 'B']);
  assert.equal(r!.cleaned, 'pick:');
});

it('returns null when there is no block', () => {
  assert.equal(parseSelectBlock('no block here'), null);
});

it('parses a butler-file block (paths) and cleans the text', () => {
  const r = parseFileBlock('여기요:\n```butler-file\n./output/report.pdf\n```');
  assert.ok(r);
  assert.deepEqual(r!.paths, ['./output/report.pdf']);
  assert.equal(r!.cleaned, '여기요:');
});

it('parseFileBlock returns null without a block', () => {
  assert.equal(parseFileBlock('just text'), null);
});
