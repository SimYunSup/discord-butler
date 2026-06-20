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

| `agent` | What it runs |
|---------|--------------|
| `claude` *(default)* | the `claude` Claude Code CLI |
| `kimi` | the **same** Claude Code CLI pointed at Moonshot's Anthropic-compatible endpoint via env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`) — set `KIMI_AUTH_TOKEN` (and optionally `KIMI_BASE_URL`/`KIMI_MODEL`) |

Because `kimi` is still Claude Code (only the model provider changes), the Stop/
Notification hooks, folder trust, and `CLAUDE.md` persona all keep working — it's
config-only. The `AgentBackend` interface (launch binary + args + env, plus the
instructions filename) leaves room for a future non-Claude backend (e.g. a
standalone Codex CLI, which would need its own completion-signal source).

## Layout

```
src/
  config.ts                 env load + validation
  router.ts                 channel → bot, conversationKey
  bridge.ts                 orchestrates workspace + tmux window + Stop-hook awaiter + reply
  http.ts                   optional localhost trigger webhook (POST /trigger/<botId>)
  bots/types.ts             the Bot type
  bots/registry.ts          the Bot Registry — add a bot here
  agents/                   pluggable agent backends (claude default, kimi) + resolver
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
