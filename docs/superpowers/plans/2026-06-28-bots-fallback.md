# Bots + Fallback Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 리서치·상담·질문·이력서 봇 4개를 registry에 추가하고, `claude → kimi → glm` 엔진 폴백 체인을 bridge에 구현한다.

**Architecture:** `config.ts`에 `BUTLER_FALLBACK_AGENTS` 파싱을 추가하고, `bridge.ts`의 `runTurn`을 엔진 순서대로 시도하도록 리팩터링한다. Workspace 설정은 엔진 무관(idempotent)하여 루프 밖에서 1회만 실행하고, 엔진 실패 시 window kill 후 다음 엔진으로 진행한다.

**Tech Stack:** TypeScript (ESM), Node.js 20+, discord-butler 기존 구조

## Global Constraints

- ESM only (`"type": "module"`); `.js` extension in imports
- `pnpm typecheck` + `pnpm test` 통과 필수
- 사설 인프라 참조(서버 절대경로, NotebookLM MCP 등) 금지
- `src/bots/types.ts` Bot 타입 변경 없음 (기존 필드만 사용)
- 커밋은 각 Task 완료 후 즉시

---

## File Map

| 파일 | 변경 | 내용 |
|---|---|---|
| `src/config.ts` | 수정 | `fallbackAgents: AgentKind[]` 추가, `BUTLER_FALLBACK_AGENTS` 파싱 |
| `src/config.test.ts` | 수정 | `fallbackAgents` 테스트 추가 |
| `src/bots/registry.ts` | 수정 | 봇 4개(research/counseling/ask/resume) 추가 |
| `src/bots/registry.test.ts` | 수정 | 8봇 단언으로 업데이트 |
| `src/bridge.ts` | 수정 | `runTurn` → 엔진 루프 리팩터링 |
| `.env.example` | 수정 | `BUTLER_FALLBACK_AGENTS` 항목 추가, 모델 주석 업데이트 |

---

## Task 1: config — fallbackAgents 파싱

**Files:**
- Modify: `src/config.ts`
- Modify: `src/config.test.ts`

**Interfaces:**
- Produces: `ButlerConfig.fallbackAgents: AgentKind[]`

- [ ] **Step 1: 실패 테스트 작성**

`src/config.test.ts` 끝에 추가:

```ts
it('defaults fallbackAgents to [] when BUTLER_FALLBACK_AGENTS unset', () => {
  const c = loadConfig({ ...base });
  assert.deepEqual(c.fallbackAgents, []);
});

it('parses BUTLER_FALLBACK_AGENTS into a deduped AgentKind list', () => {
  const c = loadConfig({ ...base, BUTLER_FALLBACK_AGENTS: 'kimi,glm' });
  assert.deepEqual(c.fallbackAgents, ['kimi', 'glm']);
});

it('skips unknown kinds in BUTLER_FALLBACK_AGENTS', () => {
  const c = loadConfig({ ...base, BUTLER_FALLBACK_AGENTS: 'kimi,bogus,glm' });
  assert.deepEqual(c.fallbackAgents, ['kimi', 'glm']);
});

it('deduplicates fallbackAgents', () => {
  const c = loadConfig({ ...base, BUTLER_FALLBACK_AGENTS: 'kimi,kimi,glm' });
  assert.deepEqual(c.fallbackAgents, ['kimi', 'glm']);
});
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
cd /Users/pedogunu/Projects/discord-butler && pnpm test 2>&1 | tail -20
```

Expected: `config.test.ts`의 새 4개 테스트 fail (property does not exist)

- [ ] **Step 3: ButlerConfig 인터페이스에 fallbackAgents 추가**

`src/config.ts`의 `ButlerConfig` 인터페이스 (27번 줄 `defaultAgent` 바로 아래):

```ts
  /** Default agent backend for bots that don't set their own (BUTLER_AGENT). */
  defaultAgent: AgentKind;
  /**
   * Ordered list of fallback backends to try when the primary agent fails
   * (BUTLER_FALLBACK_AGENTS, comma-separated AgentKind). Empty = no fallback.
   */
  fallbackAgents: AgentKind[];
```

- [ ] **Step 4: loadConfig에 파싱 로직 추가**

`src/config.ts`의 `defaultAgent` 할당 (114번 줄) 바로 아래:

```ts
  const fallbackRaw = env.BUTLER_FALLBACK_AGENTS?.trim() ?? '';
  const seen = new Set<AgentKind>();
  const fallbackAgents: AgentKind[] = fallbackRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is AgentKind => {
      if (!isAgentKind(s) || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
```

그리고 `return` 블록 (138번 줄)에 `fallbackAgents` 추가:

```ts
  return {
    discordToken,
    dataDir,
    claudeBin: env.CLAUDE_BIN?.trim() || 'claude',
    tmuxBin: env.TMUX_BIN?.trim() || 'tmux',
    replyTimeoutMs,
    idleTimeoutMs,
    httpPort,
    triggerToken,
    defaultAgent,
    fallbackAgents,
    kimi,
    glm,
    codex,
  };
```

- [ ] **Step 5: 테스트 실행 — 통과 확인**

```bash
pnpm test 2>&1 | tail -20
```

Expected: 모든 테스트 PASS

- [ ] **Step 6: 타입체크**

```bash
pnpm typecheck
```

Expected: 오류 없음

- [ ] **Step 7: 커밋**

```bash
git -C /Users/pedogunu/Projects/discord-butler add src/config.ts src/config.test.ts
git -C /Users/pedogunu/Projects/discord-butler commit -m "feat(config): add fallbackAgents parsed from BUTLER_FALLBACK_AGENTS"
```

---

## Task 2: registry — 봇 4개 추가

**Files:**
- Modify: `src/bots/registry.ts`
- Modify: `src/bots/registry.test.ts`

**Interfaces:**
- Consumes: `Bot` (기존 types.ts, 변경 없음)
- Produces: `bots[]` 8개 (planning, travel, saju, finance, research, counseling, ask, resume)

- [ ] **Step 1: 실패 테스트 작성**

`src/bots/registry.test.ts`를 아래로 교체:

```ts
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { bots } from './registry.js';

it('registry has eight bots', () => {
  const ids = bots.map((b) => b.id).sort();
  assert.deepEqual(ids, [
    'ask',
    'counseling',
    'finance',
    'planning',
    'research',
    'resume',
    'saju',
    'travel',
  ]);
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

it('counseling and resume are shared with threadPerMessage', () => {
  const counseling = bots.find((b) => b.id === 'counseling');
  assert.equal(counseling!.shared, true);
  assert.equal(counseling!.threadPerMessage, true);
  assert.equal(counseling!.memoryMode, 'companion');

  const resume = bots.find((b) => b.id === 'resume');
  assert.equal(resume!.shared, true);
  assert.equal(resume!.threadPerMessage, true);
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
```

- [ ] **Step 2: 테스트 실행 — 실패 확인**

```bash
pnpm test 2>&1 | grep -E 'fail|pass|FAIL|PASS' | tail -10
```

Expected: registry 테스트들 fail

- [ ] **Step 3: 봇 4개를 registry.ts 끝(export 바로 위)에 추가**

`src/bots/registry.ts`의 `export const bots` 줄 바로 앞에 삽입:

```ts
/**
 * 리서치 (Research) — personal, task-memory. Multi-source research assistant.
 * Each question gets its own thread. Builds a local knowledge wiki for heavy
 * multi-source answers (stored in the workspace's ./knowledge/wiki/).
 */
const research: Bot = {
  id: 'research',
  channelName: '리서치',
  displayName: '리서치',
  shared: false,
  memoryMode: 'task',
  threadPerMessage: true,
  usage:
    '질문을 입력하면 스레드를 만들어 거기서 답해요. 여러 출처를 교차 검증하고 핵심을 종합합니다. · 대화 초기화: /end',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Write', 'Task'],
  persona: [
    '너는 엄격한 리서치 어시스턴트다. 사용자의 질문에 답하기 위해 웹을 검색하고,',
    '여러 출처를 교차 검증하며, 핵심을 종합해 명료하게 정리한다.',
    '',
    '규칙:',
    '- 모든 주장에는 반드시 출처(URL 또는 매체명)를 명시한다. 출처 없는 단정은 피한다.',
    '- 불확실하거나 출처 간 의견이 갈리면 그 사실을 분명히 밝힌다. 추측을 사실처럼 말하지 않는다.',
    '- 가능한 한 1차 출처를 우선하고, 최신 정보가 중요한 주제는 검색으로 확인한다.',
    '- 답변은 한국어로 한다. 먼저 핵심 결론을 제시하고, 근거와 출처를 뒤이어 정리한다.',
    '- 장황한 서론 없이 바로 본론으로 들어간다.',
    '',
    '지식 위키 — 다출처 종합 답일 때만:',
    '- 출력 원칙(최우선): 위키 저장은 백그라운드 부산물이다. 매 턴 반드시 조사 결과 본문을 사용자에게 보여준다.',
    '- 순서(엄수): ① 웹 리서치 → ② 위키 쓰기(조용히, `./knowledge/wiki/` 하위) → ③ 맨 마지막에 조사 결과 출력.',
    '- 가벼운 단발 사실확인은 위키를 건드리지 않는다.',
  ].join('\n'),
};

/**
 * 상담 (Counseling) — shared (per-user isolated threads), companion-memory.
 * Evidence-first counseling, warm but honest. Each question opens a new
 * private thread. Rolls a memory.md for context across the thread.
 */
const counseling: Bot = {
  id: 'counseling',
  channelName: '상담',
  displayName: '상담',
  shared: true,
  threadPerMessage: true,
  threadNameFromMessage: true,
  threadNameWithTimestamp: true,
  memoryMode: 'companion',
  usage:
    '고민을 적으면 과학적 근거 위주로 상담해요. 채널에 말하면 본인만 보는 비공개 스레드가 열립니다. 위기 시 전문기관을 안내해요. · 대화 초기화: /end',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
  persona: [
    '너는 과학적 근거를 최우선으로 삼는 상담사다. 따뜻하지만 정직하다.',
    '',
    '원칙:',
    '- 주장에는 가능한 한 출처·근거를 붙인다. 근거가 약하면 그 사실을 분명히 밝힌다.',
    '- 단정·과신을 피한다. 확실하지 않은 것을 확실한 것처럼 말하지 않는다.',
    '- 최신·논쟁적 주제는 WebSearch로 근거를 확인한 뒤 답한다.',
    '- 민감한 개인정보는 신중히 다룬다. 불필요하게 캐묻거나 외부에 노출될 행동을 하지 않는다.',
    '- 위기 신호(자해·타해 등)가 보이면 전문기관·긴급 연락을 안내한다. 의료·법률은 전문가 상담을 권한다.',
    '',
    '기억:',
    '- 이 대화는 사용자별로 완전히 격리된 비공개 스레드에서 이어진다.',
    '- 맥락 유지를 위해 워크스페이스의 `memory.md`에 핵심 맥락을 간결히 요약·갱신한다.',
    '  (시스템이 주기적으로 memory.md 갱신을 요청하면 따른다.)',
    '',
    '응답:',
    '- 한국어로, 공감하되 솔직하게. 핵심을 먼저 말하고 근거를 덧붙인다.',
  ].join('\n'),
};

/**
 * 질문 (Ask / General) — personal, task-memory. Fast answers to light questions.
 * Lives in #일반. Each question gets its own thread; suggests #리서치 for heavy
 * multi-source research.
 */
const ask: Bot = {
  id: 'ask',
  channelName: '일반',
  displayName: '질문',
  shared: false,
  memoryMode: 'task',
  threadPerMessage: true,
  usage:
    '가벼운 질문은 여기서. 채널에 질문하면 스레드를 만들어 답해요. 깊은 조사가 필요하면 #리서치로. · 대화 초기화: /end',
  allowedTools: ['WebSearch', 'WebFetch', 'Read'],
  persona: [
    '너는 가벼운 질문에 빠르고 정확하게 답하는 어시스턴트다.',
    '',
    '규칙:',
    '- 핵심을 먼저, 간결하게. 불필요한 서론 없이.',
    '- 사실 확인이 필요하면 WebSearch로 확인하고 출처를 밝힌다.',
    '- 불확실한 것은 그렇다고 말한다.',
    '- 깊은 다출처 조사가 필요한 주제는 #리서치 채널을 안내한다.',
    '- 답변은 한국어.',
  ].join('\n'),
};

/**
 * 이력서 (Resume) — shared (per-user isolated threads), task-memory.
 * Writes Korean-optimized resumes and cover letters as markdown text.
 * Each session opens a new private thread.
 */
const resume: Bot = {
  id: 'resume',
  channelName: '이력서',
  displayName: '이력서',
  shared: true,
  threadPerMessage: true,
  threadNameFromMessage: true,
  threadNameWithTimestamp: true,
  memoryMode: 'task',
  usage:
    '이력서·자소서를 도와줘요. 누구의 것인지, 지원 직무·공고를 알려주면 구조화된 마크다운으로 작성합니다. 비공개 스레드에서 진행. · 대화 초기화: /end',
  allowedTools: ['Read', 'Write', 'WebFetch', 'WebSearch'],
  persona: [
    '너는 이력서·자기소개서 작성 비서다.',
    '',
    '진행:',
    '- 먼저 "누구의 이력서인지"와 "어떤 직무·회사에 지원하는지"를 파악한다.',
    '- 채용공고 URL이 있으면 WebFetch로 직무 요건을 확인해 강조점을 맞춘다.',
    '- 부족한 정보(학력·경력·성과 수치·기술스택)는 사용자에게 직접 묻는다.',
    '- 새로 알게 된 정보는 워크스페이스의 `profile.md`에 Write로 저장하고, 다음 대화에서 Read로 복원한다.',
    '',
    '결과물 — 항상 마크다운 텍스트:',
    '- 한국 채용 관행(직무 중심, 구체적 성과·수치, 군더더기 없는 문장)에 맞춘다.',
    '- 없는 경력·성과를 지어내지 않는다. 빈 곳은 추측 대신 사용자에게 되묻는다.',
    '- 섹션 예: 인적사항·요약·경력·프로젝트·기술스택·학력·자기소개서 문단.',
    '- AI 티가 나는 상투 문구("열정적으로 임하겠습니다" 등)를 피하고 구체적 동사·수치로 쓴다.',
    '',
    '응답: 한국어.',
  ].join('\n'),
};
```

- [ ] **Step 4: export 배열에 4봇 추가**

기존:
```ts
export const bots: readonly Bot[] = [planning, travel, saju, finance];
```

교체:
```ts
export const bots: readonly Bot[] = [planning, travel, saju, finance, research, counseling, ask, resume];
```

- [ ] **Step 5: 테스트 실행 — 통과 확인**

```bash
pnpm test 2>&1 | tail -20
```

Expected: 모든 테스트 PASS

- [ ] **Step 6: 타입체크**

```bash
pnpm typecheck
```

- [ ] **Step 7: 커밋**

```bash
git -C /Users/pedogunu/Projects/discord-butler add src/bots/registry.ts src/bots/registry.test.ts
git -C /Users/pedogunu/Projects/discord-butler commit -m "feat(bots): add research, counseling, ask, resume bots"
```

---

## Task 3: bridge — 엔진 폴백 체인

**Files:**
- Modify: `src/bridge.ts`

**Interfaces:**
- Consumes: `ButlerConfig.fallbackAgents: AgentKind[]` (Task 1)
- Consumes: `getBackend(kind: AgentKind): AgentBackend` from `./agents/index.js`

- [ ] **Step 1: bridge.ts import 업데이트**

기존:
```ts
import { resolveBackend, type AgentBackend, type AgentLaunch } from './agents/index.js';
```

교체:
```ts
import { getBackend, resolveBackend, type AgentBackend, type AgentLaunch } from './agents/index.js';
import type { AgentKind } from './agents/types.js';
```

- [ ] **Step 2: runTurn 리팩터링**

`runTurn` 메서드 전체를 아래로 교체 (142~243번 줄):

```ts
  /** The actual turn body, run under the per-key queue (see handleMessage). */
  private async runTurn(
    bot: Bot,
    key: string,
    text: string,
    cb: BridgeCallbacks,
    attachments: IncomingAttachment[],
  ): Promise<void> {
    const windowName = sanitizeKey(key);

    // 0. Session command: an explicit end command tears the window down (ending
    //    the conversation) without forwarding anything to claude. Windows are
    //    otherwise kept alive across turns, so this is how a user resets/closes.
    if (isEndCommand(text)) {
      const primaryBackend = resolveBackend(bot, this.config.defaultAgent);
      if (bot.flushOnEnd) await this.flushBeforeEnd(bot, key, windowName, primaryBackend);
      await this.tmux.killWindow(windowName);
      await this.sessions.remove(key);
      await cb.onReply(
        bot.flushOnEnd
          ? '🔚 데이터를 저장하고 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.'
          : '🔚 이 대화 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.',
      );
      return;
    }

    // 1. Build the engine chain: [primary, ...fallbacks] with duplicates removed.
    const primaryKind: AgentKind = bot.agent ?? this.config.defaultAgent;
    const engines: AgentKind[] = [
      primaryKind,
      ...this.config.fallbackAgents.filter((k) => k !== primaryKind),
    ];

    // 2. Workspace (once — idempotent; all three claude/kimi/glm backends write
    //    CLAUDE.md, so the workspace is backend-agnostic for our current set).
    const primaryBackend = getBackend(primaryKind);
    let cwd: string;
    try {
      cwd = await ensureWorkspace(this.config.dataDir, key, bot, this.hookScript, primaryBackend);
      await ensureTrusted(cwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await cb.onReply(`⚠️ 워크스페이스 초기화에 실패했어요 (${reason}).`);
      return;
    }

    // 3. Stage any uploaded attachments once (they live in the workspace).
    const attachNote = await this.stageAttachments(cwd, attachments);
    const base = text || (attachments.length ? '첨부한 파일을 확인해줘.' : '');
    const fullText = (base + attachNote).trim();
    if (!fullText) return;

    // 4. Try each engine in order. On timeout/error, kill the window and try
    //    the next engine. Announce when switching to a fallback.
    for (let i = 0; i < engines.length; i++) {
      const engineKind = engines[i];
      const backend = getBackend(engineKind);

      // Resolve how to launch this backend (binary + env).
      let launch: AgentLaunch;
      try {
        launch = backend.launch(this.config);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (i === engines.length - 1) {
          await cb.onReply(
            `⚠️ 에이전트 백엔드(${engineKind}) 설정 오류로 시작할 수 없어요 (${reason}).`,
          );
          return;
        }
        // Config error for this engine: skip to next (no window to kill).
        continue;
      }

      // Announce the fallback engine before the reply.
      if (i > 0) {
        await cb.onReply(`⚙️ ${engineKind}입니다.`);
      }

      try {
        const created = await this.tmux.ensureWindow(windowName, cwd, launch);
        await this.sessions.upsert(key, { window: windowName, cwd });
        if (created) {
          const ready = await this.tmux.waitUntilReady(windowName);
          if (!ready) {
            console.warn(
              `[bridge] agent REPL not ready in "${windowName}" within timeout; sending anyway.`,
            );
          }
        }

        const events = eventsFile(this.config.dataDir, key);
        const waitForStop = this.awaitNextStop(events, cb);
        await this.tmux.sendText(windowName, fullText);
        const replyText = await waitForStop;

        await this.sessions.touch(key);
        const { cleaned, files } = await this.extractOutgoingFiles(replyText, cwd);
        await cb.onReply(cleaned, files.length ? files : undefined);

        if (bot.memoryMode === 'companion') {
          await this.maybeRefreshCompanionMemory(key, windowName);
        }
        return; // success — done.
      } catch (err) {
        // Kill the stalled/errored window so the next engine starts fresh.
        await this.tmux.killWindow(windowName).catch(() => {});
        await this.sessions.remove(key).catch(() => {});

        if (i === engines.length - 1) {
          // All engines exhausted.
          const reason = err instanceof Error ? err.message : String(err);
          await cb.onReply(
            `⌛ 응답을 기다리는 동안 시간이 초과되었거나 오류가 발생했어요 (${reason}).`,
          );
        }
        // else: continue to next engine
      }
    }
  }
```

- [ ] **Step 3: 타입체크**

```bash
pnpm typecheck
```

Expected: 오류 없음. (`AgentKind` import 확인)

- [ ] **Step 4: 전체 테스트 실행**

```bash
pnpm test 2>&1 | tail -20
```

Expected: 모든 테스트 PASS (bridge 로직 테스트는 없지만 기존 테스트 회귀 없어야 함)

- [ ] **Step 5: 커밋**

```bash
git -C /Users/pedogunu/Projects/discord-butler add src/bridge.ts
git -C /Users/pedogunu/Projects/discord-butler commit -m "feat(bridge): add claude→kimi→glm fallback engine chain"
```

---

## Task 4: .env.example 업데이트

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: BUTLER_FALLBACK_AGENTS 항목 추가 + 모델 주석 업데이트**

`.env.example`의 `BUTLER_AGENT=` 줄 (26~27번 줄) 바로 아래에 삽입:

```
# Fallback engine chain when the primary agent fails or times out (comma-separated
# AgentKind). Tried in order; empty = no fallback. Example: kimi,glm
# Note: fallback engines also need their own auth tokens configured below.
BUTLER_FALLBACK_AGENTS=
```

그리고 kimi 섹션의 `KIMI_MODEL` 주석 (35번 줄) 업데이트:

기존:
```
#   KIMI_MODEL     — optional model id to pin (e.g. kimi-k2-...); empty = endpoint default.
```

교체:
```
#   KIMI_MODEL     — optional model id to pin (e.g. kimi-k2.6); empty = endpoint default.
#                    Note: kimi-k2 was discontinued 2026-05-25; use kimi-k2.6 or later.
```

그리고 glm 섹션의 `GLM_MODEL` 주석 (48번 줄) 업데이트:

기존:
```
#   GLM_MODEL     — optional model id to pin (e.g. glm-4.7); empty = endpoint default.
```

교체:
```
#   GLM_MODEL     — optional model id to pin (e.g. glm-5.2 or glm-5-turbo for speed);
#                   empty = endpoint default. Latest as of 2026-06: GLM-5.2.
```

- [ ] **Step 2: 커밋**

```bash
git -C /Users/pedogunu/Projects/discord-butler add .env.example
git -C /Users/pedogunu/Projects/discord-butler commit -m "chore: add BUTLER_FALLBACK_AGENTS to .env.example, update model hints"
```

---

## 최종 검증

- [ ] `pnpm typecheck` — 오류 없음
- [ ] `pnpm test` — 모든 테스트 PASS
- [ ] `pnpm build` — 빌드 성공

```bash
cd /Users/pedogunu/Projects/discord-butler && pnpm typecheck && pnpm test && pnpm build
```

---

## 사니타이즈 체크 (공개 레포)

커밋 전 개인정보 누출 확인:

```bash
grep -rniE '192\.168\.|yunsub|pedogunu|pickhealer|626062820|SEOYEON_DISCORD_ID' \
  /Users/pedogunu/Projects/discord-butler/src/ 2>/dev/null
```

Expected: 출력 없음 (신규 파일에 개인정보 없어야 함)
