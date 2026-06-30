# discord-butler: 봇 추가 + 폴백 구조 — 설계 플랜 (2026-06-28)

## 범위

1. **새 봇 4개** — 리서치(research)·상담(counseling)·질문(ask)·이력서(resume)
2. **엔진 폴백 체인** — `BUTLER_FALLBACK_AGENTS` env var, bridge `runTurn` 순서 시도
3. **Pricing plan** — 백엔드 선택 가이드 (이 문서 하단)

모두 **순수 제거 방식(A안)**: 사설 인프라(NotebookLM MCP, html2pdf, profiles/, 서버 절대경로) 의존 없이,
discord-butler의 현재 `Bot` 타입 필드만 사용.

---

## 1. 새 봇 4개

### 공통 원칙

- `model`/`effort` 필드는 discord-butler에 아직 없으므로 생략 (전역 `BUTLER_AGENT` 따름)
- `redact`, `skillFiles`, `sharedRefs`, `mcpServers` 미사용
- 서버 절대경로(`~/<butler>/...` 류) 페르소나에서 완전 제거

---

### 1-A. 리서치 (research)

```ts
const research: Bot = {
  id: 'research',
  channelName: '리서치',
  displayName: '리서치',
  shared: false,
  memoryMode: 'task',
  threadPerMessage: true,
  usage: '질문을 입력하면 스레드를 만들어 거기서 답해요. 여러 출처를 교차 검증하고 핵심을 종합합니다. · 대화 초기화: /end',
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
    '지식 위키 — 누적(다출처 종합 답일 때):',
    '- 출력 원칙(최우선): 위키는 백그라운드 부산물이다. 매 턴 반드시 조사 결과 본문을 사용자에게 보여준다.',
    '- 순서(엄수): ① 웹 리서치 → ② 위키 쓰기(조용히, `./knowledge/wiki/` 하위) → ③ 맨 마지막에 조사 결과 출력.',
    '- 가벼운 단발 사실확인은 위키를 건드리지 않는다. 여러 출처를 엮어 종합한 답이면 위키에 쌓는다.',
  ].join('\n'),
};
```

**제거 내역**: NotebookLM MCP/Task 위임 로직, html2png.sh Bash, knowledge/ sharedRef, skillFiles,
서버 절대경로. `Task` allowedTools는 유지(향후 사용자가 MCP 붙일 때 subagent 경로 열어둠).

---

### 1-B. 상담 (counseling)

```ts
const counseling: Bot = {
  id: 'counseling',
  channelName: '상담',
  displayName: '상담',
  shared: true,
  threadPerMessage: true,
  threadNameFromMessage: true,
  threadNameWithTimestamp: true,
  memoryMode: 'companion',
  usage: '고민을 적으면 과학적 근거 위주로 상담해요. 채널에 말하면 본인만 보는 비공개 스레드가 열립니다. 위기 시 전문기관을 안내해요. · 대화 초기화: /end',
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
```

**제거 내역**: `redact: true`, `model`/`effort` 필드.

---

### 1-C. 질문 (ask)

```ts
const ask: Bot = {
  id: 'ask',
  channelName: '일반',
  displayName: '질문',
  shared: false,
  memoryMode: 'task',
  threadPerMessage: true,
  usage: '가벼운 질문은 여기서. 채널에 질문하면 스레드를 만들어 답해요. 깊은 조사가 필요하면 #리서치로. · 대화 초기화: /end',
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
```

---

### 1-D. 이력서 (resume)

```ts
const resume: Bot = {
  id: 'resume',
  channelName: '이력서',
  displayName: '이력서',
  shared: true,
  threadPerMessage: true,
  threadNameFromMessage: true,
  threadNameWithTimestamp: true,
  memoryMode: 'task',
  usage: '이력서·자소서를 도와줘요. 누구의 것인지, 지원 직무·공고를 알려주면 구조화된 마크다운으로 작성합니다. 비공개 스레드에서 진행. · 대화 초기화: /end',
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

**제거 내역**: profiles/sharedRef, templates/sharedRef, html2pdf.sh, `Bash(gh:*)`, skillFiles.
PDF 생성 없이 마크다운 텍스트 출력만.

---

### 레지스트리 exports 추가 순서

```ts
export const bots: readonly Bot[] = [planning, travel, saju, finance, research, counseling, ask, resume];
```

---

## 2. 폴백 구조

### 2-A. config.ts 변경

```ts
// 기존
defaultAgent: AgentKind;

// 추가
fallbackAgents: AgentKind[];  // BUTLER_FALLBACK_AGENTS=kimi,glm → ['kimi', 'glm']
```

파싱 로직:
```ts
const raw = process.env.BUTLER_FALLBACK_AGENTS ?? '';
fallbackAgents = raw
  .split(',')
  .map(s => s.trim())
  .filter(s => isAgentKind(s)) as AgentKind[];
```

### 2-B. bridge.ts 변경 (runTurn)

```ts
// 현재: 단일 backend 결정
const backend = resolveBackend(bot, config.defaultAgent);

// 변경 후: 폴백 체인
const primaryKind = bot.agent ?? config.defaultAgent;
const engines: AgentKind[] = [
  primaryKind,
  ...config.fallbackAgents.filter(k => k !== primaryKind),
];

let lastError: unknown;
for (const engineKind of engines) {
  try {
    if (engineKind !== primaryKind) {
      // 폴백 엔진 사용 알림 (답변 전 한 줄)
      await cb.onReply(`⚙️ ${engineKind}입니다.`);
    }
    return await this.runWithEngine(engineKind, bot, key, text, cb, attachments);
  } catch (err) {
    lastError = err;
    // setup 에러(workspace 생성 실패 등)는 다음 엔진도 실패하므로 즉시 throw
    if (isSetupError(err)) throw err;
  }
}
throw lastError;
```

**폴백 트리거 조건**: awaiter timeout(기본 5분) 또는 claude 프로세스 비정상 종료.  
**폴백 안 함**: workspace 생성 실패, Discord 권한 에러 등 setup 에러.  
**companion 봇**: 폴백 창도 같은 `key`로 기존 창 재활용(맥락 유지).

### 2-C. .env.example 추가

```
# Fallback engine chain when the primary agent fails (comma-separated AgentKind).
# Leave empty to disable fallback.
BUTLER_FALLBACK_AGENTS=
```

---

## 3. Pricing Plan — 백엔드 선택 가이드

### 최신 모델 현황 (2026-06-28 기준)

| 백엔드 | 최신 모델 | 출시 | 특징 |
|---|---|---|---|
| `claude` | Claude Opus 4.8 / Sonnet 4.6 | 2025–2026 | 최고 한국어 품질, Anthropic 과금 |
| `kimi` | kimi-k2.6 | 2026-04-20 | 1T MoE, 32B 활성, kimi-k2 단종(2026-05-25) |
| `glm` | GLM-5.2 | 2026-06-16 | 1M 컨텍스트, agentic 특화, Anthropic-compatible |

> kimi-k2(구형)는 2026-05-25 공식 단종. `kimi` backend의 `KIMI_MODEL` 기본값을 `kimi-k2.6`으로 업데이트 필요.  
> glm.ts의 `GLM_MODEL` 기본값을 `glm-5.2`(또는 `glm-5-turbo` 속도 우선 시)로 업데이트 필요.

### 봇별 추천 백엔드

| 봇 | 추천 1차 | 이유 |
|---|---|---|
| 리서치 | `claude` | 한국어 합성·인용 품질이 결과물에 직결 |
| 이력서 | `claude` | 문장 품질·세밀한 맞춤이 중요 |
| 상담 | `claude` | 공감·뉘앙스 처리 |
| 질문 | `kimi` | 단순 QA는 kimi로도 충분, 비용 ↓ |
| 기획 | `kimi` | 구조화 출력이라 모델 차이 작음 |
| 여행 | `kimi` | 정보 조합, 문체보다 정확도 중심 |
| 사주 | `glm` | 패턴 반복, 최저가로 충분 |
| 금융 | `claude` | 수치·제도 정확성 필수 |

### 폴백 체인 추천 셋업

```
# 표준 (비용 최적화 + 고가용성)
BUTLER_AGENT=claude
BUTLER_FALLBACK_AGENTS=kimi,glm

# claude 단독 (폴백 없음)
BUTLER_FALLBACK_AGENTS=

# kimi 우선 (claude를 폴백으로, 비용 최소화)
BUTLER_AGENT=kimi
BUTLER_FALLBACK_AGENTS=claude
```

### 봇별 agent 필드 오버라이드

특정 봇을 항상 저가 모델로 고정하려면 레지스트리에 명시:

```ts
const saju: Bot = {
  // ...
  agent: 'glm',  // 이 봇만 GLM 우선
};
```

미지정 시 `BUTLER_AGENT` 전역 기본값을 따르고, 실패 시 `BUTLER_FALLBACK_AGENTS` 체인으로.

### kimi·glm 필수 env 설정

```
# kimi (Moonshot)
KIMI_AUTH_TOKEN=sk-...
KIMI_MODEL=kimi-k2.6          # 구형 kimi-k2는 단종됨
# KIMI_BASE_URL=               # 기본값 사용 권장

# glm (Z.ai)
GLM_AUTH_TOKEN=...
GLM_MODEL=glm-5.2             # 또는 glm-5-turbo (속도 우선)
# GLM_BASE_URL=                # 기본값 사용 권장
```

---

## 구현 순서

1. `src/config.ts` — `fallbackAgents` 파싱 추가
2. `src/bots/types.ts` — 필드 변경 없음 (기존 타입 그대로)
3. `src/bots/registry.ts` — 봇 4개 추가
4. `src/bridge.ts` — `runTurn` 폴백 체인 추가
5. `src/agents/kimi.ts` · `src/agents/glm.ts` — 기본 모델명 업데이트
6. `.env.example` — `BUTLER_FALLBACK_AGENTS` 항목 추가
7. `README.md` — 봇 표·에이전트 표 업데이트

**테스트**: `pnpm typecheck` + `pnpm test` (registry uniqueness + bridge fallback 경로).

---

*Sources: [Model List - Kimi API Platform](https://platform.kimi.ai/docs/models) · [Kimi K2.6 — OpenRouter](https://openrouter.ai/moonshotai/kimi-k2.6) · [Z.ai GLM-5.2 release](https://docs.z.ai/release-notes/new-released) · [GLM Coding Plan](https://z.ai/subscribe)*
