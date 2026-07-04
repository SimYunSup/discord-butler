# discord-butler

**English** · [한국어](README.ko.md)

A Discord "butler" platform where **each Discord channel is a bot**. Talk to a
channel in natural language and a dedicated **[Claude Code](https://www.anthropic.com/claude-code)
(`claude`) instance running inside a tmux window** answers, relaying the reply
back to Discord. Storage is plain **Markdown files** — no database.

A thin TypeScript bridge (discord.js) is the only long-running process: it routes
each message to the right bot, drives that bot's `claude` REPL in tmux, and posts
the completed reply back. Adding a bot is adding one config object.

## Bots included

| Bot | Channel | What it does | Memory |
|-----|---------|--------------|--------|
| 기획 (Planning) | `#기획` | Rough idea → structured plan / PRD / roadmap | task |
| 여행 (Travel) | `#여행` | Destination·dates·budget → day-by-day itinerary | task |
| 사주·점성 (Saju) | `#사주` | Korean saju + astrology daily readings; stores a birth chart per user (shared, per-user private threads). For fun / self-reflection. | companion |
| 금융 (Finance) | `#금융` | Evidence-first personal-finance/investment chat; persists a financial snapshot and updates it on session end. *Not investment advice.* | task |
| GitHub 이슈해결 (Issue solver) | `#github-이슈해결` | Reads an issue, clones the repo, fixes it on a branch, and opens a PR — all under **the user's own GitHub token**. `git push` / builds go through a Discord approval button. | companion |
| GitHub 이슈 만들기 (Issue creation) | `#github-이슈만들기` | Turns a rough description into a well-formed issue and files it (`gh issue create`, approval-gated). Never touches repo files. | task |
| GitHub 코드리뷰 (Code review) | `#github-코드리뷰` | Reviews a PR (deterministic [`sereview`](https://www.npmjs.com/package/sereview) packet, no API key) and attaches a `.md` report. Comment posting is approval-gated. | task |

The three GitHub bots share a per-user-token security model — see **[GitHub bots](#github-bots)** below.

## How it works

```
[Discord message]
   → Router            channel name → bot; conversationKey = botId (or botId__userId if shared)
   → Bridge
       → ensureWorkspace   data/conversations/<key>/ (CLAUDE.md persona + .claude/settings.json hooks)
       → TmuxManager       ensure a tmux window running `claude` in that cwd
       → tail              data/events/<key>.jsonl for the next Stop event
       → send-keys         inject the user's text into the claude REPL
   → Claude Code finishes the turn
       → Stop hook fires → scripts/hook-emit.mjs appends {"event":"Stop", payload:{ last_assistant_message }}
   → Bridge reads that line and posts the reply to Discord (split at 2000 chars)
```

- **Completion detection** uses a Claude Code **Stop** hook (not pane scraping);
  the payload carries `last_assistant_message`.
- **Permission / idle prompts** surface via a **Notification** hook.
- **Task bots** keep their window across turns and reset on `/end`; **companion
  bots** (사주) roll a `memory.md` summary periodically.
- **Shared bots** (사주) isolate each user in their own private thread + workspace.
- **Attachments**: images/files you upload are staged into the bot's workspace.
- **Select menus**: a bot can end a reply with a ` ```butler-select ` block to
  render Discord buttons; a ` ```butler-file ` block attaches a file from the
  conversation workspace.

## Agent backends

The agent that drives a conversation's tmux window is **pluggable** (see
`src/agents/`). Each bot can set an `agent` field, or a global default is set via
`BUTLER_AGENT` (default `claude`):

| `agent` | What it runs | Pricing |
|---------|--------------|---------|
| `claude` *(default)* | the `claude` Claude Code CLI | [Anthropic pricing](https://www.anthropic.com/pricing) |
| `kimi` | the **same** Claude Code CLI pointed at Moonshot's Anthropic-compatible endpoint via env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) — set `KIMI_AUTH_TOKEN` (and optionally `KIMI_BASE_URL`/`KIMI_MODEL`) | [Moonshot pricing](https://platform.moonshot.ai/) |
| `glm` | the **same** Claude Code CLI pointed at [Z.ai](https://z.ai)'s Anthropic-compatible endpoint via env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) — set `GLM_AUTH_TOKEN` (and optionally `GLM_BASE_URL`/`GLM_MODEL`; default base `https://api.z.ai/api/anthropic`, China override `https://open.bigmodel.cn/api/anthropic`) | [GLM Coding Plan pricing](https://z.ai/subscribe) |
| `codex` *(experimental)* | the **same** Claude Code CLI with [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) loaded (`--plugin-dir $CODEX_PLUGIN_DIR`) so it can delegate to Codex — **unverified**, needs a Codex plan; see [Codex](#codex) below | [OpenAI pricing](https://openai.com/chatgpt/pricing/) |

Because `kimi` and `glm` are still Claude Code (only the model provider changes),
the Stop/Notification hooks, folder trust, and `CLAUDE.md` persona all keep
working — both are config-only. The `AgentBackend` interface (launch binary +
args + env, plus the instructions filename) leaves room for a non-Claude backend.

### Codex

Two shapes exist for [#1](https://github.com/SimYunSup/discord-butler/issues/1)'s
Codex support. The **plugin path** (delegate to Codex from Claude Code) is
scaffolded as the experimental `codex` backend — see the table above and the ⚠️
note at the end of this section. The **standalone path** (Codex itself as the
agent) is fully mapped out but unimplemented: it can't be live-verified without a
paid Codex plan (`codex login` needs a ChatGPT
subscription, or an `OPENAI_API_KEY` billed per token), so per this repo's
"no unverified code" rule it stays a documented path until a contributor with
Codex access can implement **and** verify it. Every Claude-Code coupling point
has a Codex equivalent:

| Claude Code | Codex equivalent |
|---|---|
| `CLAUDE.md` persona | `AGENTS.md` (`backend.instructionsFile`) |
| `.claude/settings.json` tool allowlist | `approval_policy` + `sandbox_mode` in a per-workspace `.codex/config.toml`; unattended ⇒ `approval_policy = "never"`, `sandbox_mode = "workspace-write"` |
| folder trust in `~/.claude.json` (`src/claude/trust.ts`) | `[projects."<cwd>"] trust_level = "trusted"` in `config.toml` |
| **Stop hook → events JSONL** | **`notify` program**: `notify = ["node", "codex-notify.mjs"]` fires on `agent-turn-complete` with a JSON payload carrying `last-assistant-message`. Re-emit it as the same `{"event":"Stop", …}` line the bridge already tails ⇒ **the bridge is unchanged.** (Alt: `codex exec --json` emits NDJSON `turn.completed` events for a non-interactive, per-message architecture, with `codex exec resume` keeping companion memory.) |

So the open question from #1 — "completion detection without a Stop-hook
equivalent" — is **resolved**: Codex's `notify` (`agent-turn-complete`) is a near
1:1 analog of Claude Code's Stop hook, down to the `last-assistant-message` field.

A second, lighter path **is scaffolded** as the experimental `codex` agent
(`src/agents/codex.ts`): keep Claude Code as the driving agent (so **every**
existing hook keeps working) and load the official
[`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) plugin so it
can delegate review/heavy tasks to Codex via `/codex:review` & co. Point
`CODEX_PLUGIN_DIR` at a local clone of the plugin and set `BUTLER_AGENT=codex` (or a
bot's `agent: 'codex'`). This is *delegation, not an engine swap* — the user still
talks to Claude — and it rides the same Codex auth, so it needs a Codex plan.

> ⚠️ **Unverified.** It can't be run end-to-end here (no Codex plan), and
> non-interactive plugin activation via `--plugin-dir` (no `/plugin install` /
> `/codex:setup` prompt) is unconfirmed. Treat the `codex` backend as a draft
> scaffold, not a supported path — see the disclaimer in `src/agents/codex.ts`.

## GitHub bots

`#github-이슈해결`, `#github-이슈만들기`, `#github-코드리뷰` let **each user act under
their own GitHub identity**. There is no shared/host token — a user registers their
own PAT and every commit, PR, issue, and comment goes out as *them*.

**Onboarding.** Run the ephemeral slash command in Discord:

```
/github-token token:<your PAT>
```

- Use a **classic PAT** with the `repo` scope (org repos also need that token
  SSO-authorized for the org). The reply is ephemeral, so the token never lands in
  channel history.
- It's validated with `gh api user`, then stored at
  `$BUTLER_DATA_DIR/secrets/github/<discordUserId>.json` (mode `0600`, outside every
  conversation workspace). Remove it with `/github-token-remove`.
- With **no token registered the bot won't even launch** its window — a missing
  token can never silently fall back to the host's `gh` login.

**How the token flows.** At window launch the bridge injects that user's PAT +
`GIT_AUTHOR/COMMITTER_*` as the tmux window's env only (never a file in the
workspace, never symlinked). The conversation key embeds the Discord user id, so two
users can never share a window / workspace / token.

**The approval gate.** These bots' only shell is `scripts/gated-run.sh`. Read-only
commands (`gh issue view`, `git clone`, `git commit`) run immediately; **destructive
ones block** until a Discord **✅ 승인 / 🚫 거부** button decides:

| Command class | Who can approve |
|---|---|
| `git push`, `gh issue create`, `gh pr review/comment` | the **requesting user** (their own token) *or* the owner |
| Code execution (`npx`, `node`, `cargo test`, …) on `allowRepoCodeExec` bots | **owner only** — running a cloned repo's own code is an RCE vector, so the requester can't self-approve it |

The gate is a file handshake (an `Approval` event → the bridge posts buttons → the
click writes a decision file `gated-run.sh` is polling), with a 300 s timeout. On the
issue-creation bot code execution is not permitted at all (gh reads/creates only).

**Host setup (one-time).**

1. Invite the bot with the **`applications.commands`** OAuth scope, or the slash
   command won't appear.
2. Set `OWNER_DISCORD_ID` (approves code-execution gates).
3. Run **`gh auth setup-git`** once on the host so `git push` uses the per-window
   `GH_TOKEN` credential helper.
4. For code review, `sereview` is fetched on demand via `npx`; install it globally
   (`npm i -g sereview`) to avoid the round-trip.

## Layout

```
src/
  config.ts                 env load + validation
  router.ts                 channel → bot, conversationKey
  bridge.ts                 orchestrates workspace + tmux window + Stop-hook awaiter + reply
  http.ts                   optional localhost trigger webhook (POST /trigger/<botId>)
  bots/types.ts             the Bot type
  bots/registry.ts          the Bot Registry — add a bot here
  agents/                   pluggable agent backends (claude default, kimi, glm) + resolver
  discord/client.ts         discord.js client + ensure categories/channels on ready
  discord/handler.ts        messageCreate → router → bridge; shared-bot threads
  discord/post.ts           reply posting (chunking, select menus, file attachments)
  tmux/manager.ts           tmux new-session/window/send-keys via execFile
  claude/workspace.ts       writes per-conversation CLAUDE.md + .claude/settings.json hooks
  persistence/session-map.ts  conversationKey → tmux window mapping
  index.ts                  wiring + graceful shutdown
scripts/
  hook-emit.mjs             the tiny script Claude Code hooks invoke (stdin JSON → events JSONL)
data/                       (gitignored) per-conversation workspaces, events, session map
```

## Setup

Requires **Node ≥ 20**, **pnpm**, **tmux**, and **`claude`** (Claude Code CLI)
on PATH, with `claude` already authenticated (`claude` once, interactively).

```bash
pnpm install
cp .env.example .env        # then fill in DISCORD_TOKEN
pnpm typecheck
pnpm test
pnpm build && pnpm start    # or: pnpm dev
```

`.env` keys are documented in `.env.example`. Only `DISCORD_TOKEN` is required.

> **Running it on a dedicated box?** See [docs/self-hosting.md](docs/self-hosting.md)
> for a step-by-step bilingual (EN/KO) guide — from buying a mini PC (RAM/SSD) to a
> `systemd` service that restarts on reboot.

Invite the bot to your guild with **Manage Channels** so it can create the
categories and one channel per bot on first run. A long-lived tmux server must be
available (the bridge creates a single detached session and one window per
conversation).

## Adding a bot

Add one object to `src/bots/registry.ts`:

```ts
const mybot: Bot = {
  id: 'mybot',
  channelName: '내봇',
  displayName: '내 봇',
  shared: false,            // true → per-user private threads
  memoryMode: 'task',       // or 'companion'
  usage: '채널 토픽에 표시될 사용법',
  allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Write'],
  persona: ['시스템 프롬프트 …'].join('\n'),
};
// …then add `mybot` to the exported `bots` array.
```

The core reads the registry generically — no special-casing per bot.

## Notes

- Each conversation runs an isolated `claude` in its own working directory, so a
  user can never reach another conversation's files.
- Safe bots run with a tool allowlist (`.claude/settings.json`) and no
  interactive menus; nothing destructive is permitted by default.
- The 금융 / 사주 bots are general-purpose assistants — **not** professional
  financial, medical, or legal advice.

## License

MIT
