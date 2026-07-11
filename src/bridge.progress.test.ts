import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailEventsForStop, toolProgressLabel } from './bridge.js';

const line = (event: string, payload: Record<string, unknown> = {}) =>
  JSON.stringify({ event, ts: new Date().toISOString(), payload }) + '\n';

test('PreToolUse relays a throttled friendly label (not the raw tool name); only Stop resolves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'db-prog-'));
  const events = join(dir, 'e.jsonl');
  await writeFile(events, '');
  const seen: string[] = [];
  const p = tailEventsForStop(events, { onReply: () => {}, onProgress: (m: string) => { seen.push(m); } }, { idleTimeoutMs: 1000, maxTimeoutMs: 5000, pollMs: 20 });
  await appendFile(events, line('PreToolUse', { tool_name: 'WebFetch' }));
  await new Promise((r) => setTimeout(r, 60));
  await appendFile(events, line('PreToolUse', { tool_name: 'WebFetch' })); // same label → skip
  await new Promise((r) => setTimeout(r, 60));
  await appendFile(events, line('PreToolUse', { tool_name: 'Bash' })); // changed but <4s → throttled
  await new Promise((r) => setTimeout(r, 60));
  await appendFile(events, line('Stop', { last_assistant_message: 'final' }));
  assert.equal(await p, 'final');
  assert.deepEqual(seen, ['웹 자료 가져오는 중']);
});

test('toolProgressLabel maps tools + MCP-by-server, unknown → 작업 중', () => {
  assert.equal(toolProgressLabel('WebSearch'), '웹 검색 중');
  assert.equal(toolProgressLabel('Task'), '하위 작업 병렬 실행 중');
  assert.equal(toolProgressLabel('mcp__notion__fetch'), 'Notion 읽고 정리하는 중');
  assert.equal(toolProgressLabel('mcp__github__x'), '외부 도구 사용하는 중');
  assert.equal(toolProgressLabel('Whatever'), '작업 중');
});
