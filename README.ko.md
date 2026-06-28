# discord-butler

[English](README.md) · **한국어**

**Discord 채널 하나가 봇 하나**인 "비서단" 플랫폼입니다. 채널에 자연어로 말을 걸면, tmux
창 안에서 도는 전용 **[Claude Code](https://www.anthropic.com/claude-code) (`claude`)
인스턴스**가 답하고 그 답을 다시 Discord로 전달합니다. 저장소는 **순수 Markdown 파일** —
데이터베이스가 없습니다.

상시 떠 있는 프로세스는 얇은 TypeScript 브리지(discord.js) 하나뿐입니다. 메시지를 알맞은
봇으로 라우팅하고, 그 봇의 `claude` REPL을 tmux에서 구동하며, 완성된 답을 다시 게시합니다.
봇 추가 = 설정 객체 하나 추가.

## 포함된 봇

| 봇 | 채널 | 하는 일 | 메모리 |
|-----|---------|--------------|--------|
| 기획 | `#기획` | 거친 아이디어 → 구조화된 기획 / PRD / 로드맵 | task |
| 여행 | `#여행` | 목적지·기간·예산 → 일자별 일정 | task |
| 사주·점성 | `#사주` | 한국 사주 + 점성 데일리 리딩; 사용자별 사주 차트 저장(shared, 사용자별 비공개 스레드). 재미·자기성찰용. | companion |
| 금융 | `#금융` | 근거 우선 개인 재무·투자 상담; 재무 스냅샷을 저장하고 세션 종료 시 갱신. *투자 권유 아님.* | task |

## 동작 방식

```
[Discord 메시지]
   → Router            채널명 → 봇; conversationKey = botId (shared면 botId__userId)
   → Bridge
       → ensureWorkspace   data/conversations/<key>/ (CLAUDE.md 페르소나 + .claude/settings.json 훅)
       → TmuxManager       해당 cwd에서 `claude`를 띄운 tmux 창 보장
       → tail              data/events/<key>.jsonl 에서 다음 Stop 이벤트 대기
       → send-keys         사용자 입력을 claude REPL에 주입
   → Claude Code가 턴을 끝냄
       → Stop 훅 발생 → scripts/hook-emit.mjs 가 {"event":"Stop", payload:{ last_assistant_message }} 추가
   → Bridge가 그 줄을 읽어 Discord에 답 게시(2000자 단위로 분할)
```

- **완료 감지**는 Claude Code **Stop** 훅으로(화면 스크래핑 아님); payload에
  `last_assistant_message`가 담깁니다.
- **권한 / 입력 대기 알림**은 **Notification** 훅으로 표면화됩니다.
- **task 봇**은 턴 사이에 창을 유지하고 `/end` 시 초기화; **companion 봇**(사주)은 주기적으로
  `memory.md` 요약을 굴립니다.
- **shared 봇**(사주)은 각 사용자를 본인 비공개 스레드 + 워크스페이스로 격리합니다.
- **첨부**: 업로드한 이미지/파일은 봇 워크스페이스로 스테이징됩니다.
- **선택 메뉴**: 봇은 답 끝에 ` ```butler-select ` 블록으로 Discord 버튼을 띄우거나,
  ` ```butler-file ` 블록으로 대화 워크스페이스의 파일을 첨부할 수 있습니다.

## 에이전트 백엔드

대화의 tmux 창을 구동하는 에이전트는 **교체 가능**합니다(`src/agents/` 참고). 봇마다 `agent`
필드를 두거나, 전역 기본값을 `BUTLER_AGENT`로 지정합니다(기본 `claude`):

| `agent` | 무엇을 실행하나 | 가격 |
|---------|----------------|------|
| `claude` *(기본)* | `claude`(Claude Code CLI) | [Anthropic 가격](https://www.anthropic.com/pricing) |
| `kimi` | **같은** Claude Code CLI를 Moonshot의 Anthropic 호환 엔드포인트로 env(`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`)만 바꿔 실행 — `KIMI_AUTH_TOKEN`(선택 `KIMI_BASE_URL`/`KIMI_MODEL`) 설정 | [Moonshot 가격](https://platform.moonshot.ai/) |
| `glm` | **같은** Claude Code CLI를 [Z.ai](https://z.ai)의 Anthropic 호환 엔드포인트로 env(`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`)만 바꿔 실행 — `GLM_AUTH_TOKEN`(선택 `GLM_BASE_URL`/`GLM_MODEL`; 기본 base `https://api.z.ai/api/anthropic`, 중국 `https://open.bigmodel.cn/api/anthropic`) 설정 | [GLM Coding Plan 가격](https://z.ai/subscribe) |
| `codex` *(실험적)* | **같은** Claude Code CLI에 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)를 로드(`--plugin-dir $CODEX_PLUGIN_DIR`)해 Codex에 위임 — **미검증**, Codex 플랜 필요. 아래 [Codex](#codex) 참고 | [OpenAI 가격](https://openai.com/chatgpt/pricing/) |

`kimi`·`glm`은 여전히 Claude Code라(모델 제공자만 바뀜) Stop/Notification 훅·폴더 신뢰·`CLAUDE.md`
페르소나가 전부 그대로 동작합니다 — 둘 다 설정만으로 붙는 경로. `AgentBackend` 인터페이스(실행
바이너리 + args + env, 지침 파일명)는 비-Claude 백엔드를 위한 여지를 둡니다.

### Codex

이슈 [#1](https://github.com/SimYunSup/discord-butler/issues/1)의 Codex 지원에는 두 갈래가
있습니다. **플러그인 경로**(Claude Code에서 Codex로 위임)는 실험적 `codex` 백엔드로
스캐폴드돼 있습니다(`src/agents/codex.ts`) — Claude Code가 드라이버로 남아 **모든 훅이 그대로
동작**하고 Codex엔 리뷰/무거운 작업만 위임합니다. `CODEX_PLUGIN_DIR`을 플러그인 로컬 클론으로
가리키고 `BUTLER_AGENT=codex`(또는 봇의 `agent: 'codex'`)로 켭니다. *엔진 교체가 아니라
위임*이라 사용자는 여전히 Claude와 대화하며, 같은 Codex 인증을 쓰므로 Codex 플랜이 필요합니다.

> ⚠️ **미검증.** 여기선 end-to-end로 돌려볼 수 없고(Codex 플랜 없음), `--plugin-dir`로의
> 비대화 활성화(`/plugin install`·`/codex:setup` 없이)도 미확인입니다. `codex` 백엔드는 정식
> 지원이 아니라 초안 스캐폴드로 다루세요 — `src/agents/codex.ts`의 disclaimer 참고.
>
> **독립 경로**(Codex 자체가 에이전트)는 설계만 돼 있고 미구현입니다. Stop 훅 등가물이 없는
> 완료 감지는 Codex의 `notify`(`agent-turn-complete` 이벤트가 `last-assistant-message` 포함 →
> bridge가 tail하는 `{"event":"Stop", …}` JSONL로 재방출, **bridge 무변경**) 또는
> `codex exec --json`(NDJSON `turn.completed`)으로 풀립니다.

## 구조

```
src/
  config.ts                 env 로드 + 검증
  router.ts                 채널 → 봇, conversationKey
  bridge.ts                 워크스페이스 + tmux 창 + Stop 훅 awaiter + 답변 오케스트레이션
  http.ts                   선택적 localhost 트리거 웹훅 (POST /trigger/<botId>)
  bots/types.ts             Bot 타입
  bots/registry.ts          Bot Registry — 봇은 여기에 추가
  discord/client.ts         discord.js 클라이언트 + ready 시 카테고리/채널 보장
  discord/handler.ts        messageCreate → router → bridge; shared 봇 스레드
  discord/post.ts           답변 게시(분할, 선택 메뉴, 파일 첨부)
  tmux/manager.ts           execFile로 tmux new-session/window/send-keys
  claude/workspace.ts       대화별 CLAUDE.md + .claude/settings.json 훅 작성
  persistence/session-map.ts  conversationKey → tmux 창 매핑
  index.ts                  와이어링 + graceful shutdown
scripts/
  hook-emit.mjs             Claude Code 훅이 호출하는 작은 스크립트(stdin JSON → events JSONL)
data/                       (gitignore) 대화별 워크스페이스, 이벤트, 세션 맵
```

## 설치

**Node ≥ 20**, **pnpm**, **tmux**, 그리고 PATH 위의 **`claude`**(Claude Code CLI)가
필요하며, `claude`는 미리 인증돼 있어야 합니다(`claude`를 한 번 대화형으로 실행).

```bash
pnpm install
cp .env.example .env        # 그다음 DISCORD_TOKEN 채우기
pnpm typecheck
pnpm test
pnpm build && pnpm start    # 또는: pnpm dev
```

`.env` 키는 `.env.example`에 설명돼 있습니다. 필수는 `DISCORD_TOKEN` 하나뿐입니다.

> **전용 머신에서 돌리시나요?** 미니PC 구매(램/SSD)부터 재부팅 시 자동 재시작되는 `systemd`
> 서비스까지, 단계별 한국어·영어 가이드는 [docs/self-hosting.md](docs/self-hosting.md)를 보세요.

봇이 첫 실행 때 카테고리와 봇별 채널을 만들 수 있도록 **Manage Channels** 권한으로 길드에
초대하세요. tmux 서버가 상시 떠 있어야 합니다(브리지가 detached 세션 하나와 대화별 창
하나를 만듭니다).

## 봇 추가

`src/bots/registry.ts`에 객체 하나를 추가합니다:

```ts
const mybot: Bot = {
  id: 'mybot',
  channelName: '내봇',
  displayName: '내 봇',
  shared: false,            // true → 사용자별 비공개 스레드
  memoryMode: 'task',       // 또는 'companion'
  usage: '채널 토픽에 표시될 사용법',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
  persona: ['시스템 프롬프트 …'].join('\n'),
};
// …그다음 export된 `bots` 배열에 `mybot` 추가.
```

코어는 레지스트리를 일반적으로 읽습니다 — 봇별 특수 처리가 없습니다.

## 참고

- 각 대화는 자기 작업 디렉터리에서 격리된 `claude`로 돌아가므로, 한 사용자가 다른 대화의
  파일에 닿을 수 없습니다.
- 안전 봇은 도구 allowlist(`.claude/settings.json`)와 대화형 메뉴 없이 동작하며, 기본적으로
  파괴적 동작은 허용되지 않습니다.
- 금융 / 사주 봇은 범용 어시스턴트입니다 — 전문적인 **금융·의료·법률 자문이 아닙니다**.

## 라이선스

MIT
