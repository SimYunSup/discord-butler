import assert from 'node:assert/strict';
import { test } from 'node:test';
import { regexRedactPII, isPlausibleSpan, redactPII } from './redact.js';

test('masks email / phone / 주민번호 / card / account', () => {
  const r = regexRedactPII(
    '연락처 010-1234-5678, 이메일 a.b+c@example.co.kr, 주민 900101-1234567, 카드 1234-5678-9012-3456, 계좌 123-45-678901',
  );
  assert.match(r.text, /\[REDACTED:phone\]/);
  assert.match(r.text, /\[REDACTED:email\]/);
  assert.match(r.text, /\[REDACTED:rrn\]/);
  assert.match(r.text, /\[REDACTED:card\]/);
  assert.match(r.text, /\[REDACTED:account\]/);
  assert.equal(r.hits, 5);
  // No raw PII survives.
  assert.doesNotMatch(r.text, /010-1234-5678|900101-1234567|example\.co\.kr/);
});

test('masks GitHub tokens (defense in depth)', () => {
  const r = regexRedactPII('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 here');
  assert.match(r.text, /\[REDACTED:gh-token\]/);
  assert.doesNotMatch(r.text, /ghp_/);
});

test('does NOT over-mask dates or plain numbers (avoids false positives)', () => {
  // A date (8 digits) must not trip the account rule (needs ≥10 digits).
  const r = regexRedactPII('마지막 갱신 2024-01-15, 목표 수익률 7% (나스닥100 기준).');
  assert.equal(r.hits, 0);
  assert.equal(r.text, '마지막 갱신 2024-01-15, 목표 수익률 7% (나스닥100 기준).');
});

test('empty / clean text is returned unchanged with 0 hits', () => {
  assert.deepEqual(regexRedactPII(''), { text: '', hits: 0 });
  assert.deepEqual(regexRedactPII('평범한 문장입니다.'), { text: '평범한 문장입니다.', hits: 0 });
});

test('isPlausibleSpan drops model false positives, keeps real PII', () => {
  assert.equal(isPlausibleSpan('홍길동', 'name'), true);
  assert.equal(isPlausibleSpan('나스닥100', 'name'), false); // name with a digit → brand/instrument
  assert.equal(isPlausibleSpan('ISA 계좌', 'account'), false); // "account" with no digit
  assert.equal(isPlausibleSpan('notanemail', 'email'), false); // "email" with no @
  assert.equal(isPlausibleSpan('x', 'name'), false); // too short
  assert.equal(isPlausibleSpan('서울시 강남구', 'address'), true);
  assert.equal(isPlausibleSpan('2024-01-15', 'date'), false); // non-canonical type
});

test('redactPII without OLLAMA_HOST is regex-only and never throws', async () => {
  const prev = process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_HOST;
  try {
    const r = await redactPII('전화 010-1234-5678');
    assert.match(r.text, /\[REDACTED:phone\]/);
    assert.equal(r.hits, 1);
  } finally {
    if (prev !== undefined) process.env.OLLAMA_HOST = prev;
  }
});
