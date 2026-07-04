import { it } from 'node:test';
import assert from 'node:assert/strict';
import { bots } from './registry.js';

it('registry has eleven bots', () => {
  const ids = bots.map((b) => b.id).sort();
  assert.deepEqual(ids, [
    'ask',
    'code-review',
    'counseling',
    'finance',
    'github',
    'github-issue',
    'planning',
    'research',
    'resume',
    'saju',
    'travel',
  ]);
});

it('the three GitHub bots are perUserGitHubAuth + gatedShell, gated-run-only', () => {
  for (const id of ['github', 'github-issue', 'code-review']) {
    const b = bots.find((x) => x.id === id)!;
    assert.equal(b.perUserGitHubAuth, true, `${id} perUserGitHubAuth`);
    assert.equal(b.gatedShell, true, `${id} gatedShell`);
    assert.equal(b.shared, true, `${id} shared (userId in key → token isolation)`);
    // Shell access is ONLY the gated-run.sh (via the {{SCRIPTS_DIR}} placeholder).
    const bashTools = b.allowedTools.filter((t) => t.startsWith('Bash('));
    assert.ok(bashTools.length > 0, `${id} has a gated shell`);
    assert.ok(
      bashTools.every((t) => t.includes('gated-run.sh') || t.includes('sereview-run.sh')),
      `${id} shell is gated-run/sereview-run only`,
    );
  }
});

it('only issue-solving + code-review may execute repo code (owner-gated); issue-creation may not', () => {
  assert.equal(bots.find((b) => b.id === 'github')!.allowRepoCodeExec, true);
  assert.equal(bots.find((b) => b.id === 'code-review')!.allowRepoCodeExec, true);
  assert.notEqual(bots.find((b) => b.id === 'github-issue')!.allowRepoCodeExec, true);
});

it('every bot is fully defined', () => {
  for (const b of bots) {
    assert.ok(b.id && b.channelName && b.displayName && b.persona, `bot ${b.id} complete`);
    assert.ok(b.allowedTools.length > 0, `bot ${b.id} has tools`);
  }
});

it('saju is shared; finance persists via the finance sharedRef + flushOnEnd', () => {
  const saju = bots.find((b) => b.id === 'saju');
  assert.equal(saju!.shared, true);
  const finance = bots.find((b) => b.id === 'finance');
  assert.ok(finance!.sharedRefs?.includes('finance'), 'finance uses finance dir');
  assert.ok(finance!.flushOnEnd, 'finance flushes on /end');
});

it('counseling and resume are personal (solo-use) bots', () => {
  // Solo bots: not shared, no per-user/per-message threading → one workspace each.
  const counseling = bots.find((b) => b.id === 'counseling');
  assert.equal(counseling!.shared, false);
  assert.notEqual(counseling!.threadPerMessage, true);
  assert.equal(counseling!.memoryMode, 'companion');
  assert.ok(counseling!.flushOnEnd, 'counseling flushes memory.md on /end');
  assert.equal(counseling!.redact, true, 'counseling masks PII on the observation surface');

  const resume = bots.find((b) => b.id === 'resume');
  assert.equal(resume!.shared, false);
  assert.notEqual(resume!.threadPerMessage, true);
  assert.equal(resume!.memoryMode, 'task');
  // Resume enrichments: the korean-humanizer skill + read-only gh profile exploration.
  assert.ok(resume!.skillFiles?.some((f) => f.includes('korean-humanizer')), 'resume uses korean-humanizer');
  assert.ok(resume!.allowedTools.includes('Bash(gh:*)'), 'resume can read GitHub via gh');
});

it('research and ask use threadPerMessage (personal)', () => {
  const research = bots.find((b) => b.id === 'research');
  assert.equal(research!.shared, false);
  assert.equal(research!.threadPerMessage, true);

  const ask = bots.find((b) => b.id === 'ask');
  assert.equal(ask!.shared, false);
  assert.equal(ask!.threadPerMessage, true);
  assert.equal(ask!.channelName, '일반');
});
