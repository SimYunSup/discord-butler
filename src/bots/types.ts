import type { AgentKind } from '../agents/types.js';

/**
 * Memory model for a bot's tmux window lifecycle.
 * - `task`: stateless. A window is spun up per request and killed when the reply
 *   is delivered; no context accumulates across messages.
 * - `companion`: rolling. The window is kept alive; long-term memory rolls into
 *   a `memory.md` and Claude Code `/compact` is the safety net.
 */
export type MemoryMode = 'task' | 'companion';

/**
 * Model/effort escalation: the user's raw text is matched on two INDEPENDENT axes
 * that compose. A model trigger bumps the model; an effort trigger bumps the effort;
 * a message hitting both reaches the top (e.g. "opus" + "deep" → Opus xhigh). Matching
 * is a case-insensitive substring test. Applied at window-launch time (a fresh window
 * takes the resolved `--model`/`--effort`); see {@link ./model-escalation.ts}.
 *
 * STICKY: an escalation, once triggered, CARRIES FORWARD to later messages in the same
 * conversation with no trigger — the resolved tier is persisted in session-map and reused
 * as the next turn's starting point. The de-escalation triggers below are how a user drops
 * back to the base without opening a new thread.
 */
export interface ModelEscalation {
  /** Case-insensitive substrings; ANY match bumps the model to {@link escalatedModel}. */
  modelTriggers: string[];
  /** Model alias/id to switch to when a {@link modelTriggers} entry matches (e.g. 'opus'). */
  escalatedModel: string;
  /** Case-insensitive substrings; ANY match bumps the effort to {@link escalatedEffort}. */
  effortTriggers: string[];
  /** Effort level to switch to when an {@link effortTriggers} entry matches (e.g. 'xhigh'). */
  escalatedEffort: string;
  /**
   * Optional de-escalation (reset) words for the MODEL axis: a case-insensitive substring
   * match drops the model back to the bot's base {@link Bot.model}, overriding both the
   * sticky carry-over and any escalation trigger in the SAME message (an explicit "go back"
   * wins). Omit ⇒ the model stays escalated until the thread ends. Independent of effort.
   */
  modelResetTriggers?: string[];
  /** Effort-axis de-escalation words. See {@link modelResetTriggers}. */
  effortResetTriggers?: string[];
}

/**
 * A bot definition. Adding a new bot to the platform = adding one of these to
 * the registry (plus, eventually, its tools/MCP config). The shared core does
 * not special-case any bot.
 */
export interface Bot {
  /** Stable identifier. Used as the personal-conversation key and tmux window prefix. */
  id: string;
  /** Discord channel name this bot owns (created under the category if missing). */
  channelName: string;
  /** Human-facing display name. */
  displayName: string;
  /**
   * System prompt / persona, written verbatim into the per-conversation CLAUDE.md.
   * Should describe role, tone, and rules in the language the bot replies in.
   */
  persona: string;
  /**
   * Tools this bot is allowed to use, written into the conversation's
   * `.claude/settings.json` permissions allowlist (e.g. ['WebSearch', 'WebFetch']).
   */
  allowedTools: string[];
  /**
   * Tools to explicitly DENY (silently blocked, no interactive prompt), merged into
   * the settings.json deny list on top of the always-denied interactive tools
   * (AskUserQuestion/ExitPlanMode). Use to stop a weak model from reaching for a
   * tool that would derail the turn — e.g. denying the `Task`/`Agent` subagent so a
   * model can't delegate to a context-less child.
   */
  denyTools?: string[];
  /**
   * Base model alias/id this bot's claude REPL launches with (`--model`), e.g.
   * 'opus' / 'sonnet' / 'haiku'. Omitted → the user's default model (no flag).
   * A matching {@link modelEscalation} trigger can override this per turn.
   */
  model?: string;
  /**
   * Base reasoning effort this bot launches with (`--effort`), e.g. 'low' /
   * 'medium' / 'high' / 'xhigh'. Omitted → no flag.
   */
  effort?: string;
  /**
   * Optional model/effort escalation matched on the user's text. An escalation is
   * STICKY — it carries across later triggerless messages in the same thread until a
   * {@link ModelEscalation.modelResetTriggers}/{@link ModelEscalation.effortResetTriggers}
   * de-escalation word (or thread end) drops it back to the base.
   */
  modelEscalation?: ModelEscalation;
  /**
   * Whether this bot is shared across users (isolated per-user via private threads,
   * conversationKey = `${botId}__${userId}`) or personal (conversationKey = botId).
   */
  shared: boolean;
  /** Memory lifecycle for this bot's tmux windows. */
  memoryMode: MemoryMode;
  /**
   * Which agent backend drives this bot's tmux windows. Defaults (when unset) to
   * the global default from `BUTLER_AGENT` (itself defaulting to `'claude'`).
   * - `'claude'`: the Claude Code CLI.
   * - `'kimi'`:   the same Claude Code CLI pointed at Moonshot's Anthropic-compatible
   *               endpoint via env (requires KIMI_AUTH_TOKEN; see .env.example).
   * - `'codex'`:  EXPERIMENTAL/UNVERIFIED — the same Claude Code CLI with the
   *               openai/codex-plugin-cc plugin loaded so it can delegate to Codex
   *               (requires CODEX_PLUGIN_DIR + a Codex plan; see src/agents/codex.ts).
   */
  agent?: AgentKind;
  /**
   * Short usage guide shown as the Discord channel's TOPIC (description), so a
   * user sees how to use the bot at the top of the channel. Plain text, ~1-2
   * sentences (Discord topic max 1024 chars).
   */
  usage?: string;
  /**
   * When true, only the owner (process.env.OWNER_DISCORD_ID) may use this bot;
   * messages from anyone else are politely declined. For personal/sensitive bots
   * (finance, inbox triage, deploy).
   */
  ownerOnly?: boolean;
  /**
   * When set, only the Discord user whose id equals process.env[allowedUserIdEnv]
   * may use this bot; everyone else (including the owner) is declined. If that env
   * var is unset/empty, NO ONE can use it (locked) — used to pre-create a bot for a
   * user who hasn't joined the guild yet (gate it to a specific Discord user id).
   */
  allowedUserIdEnv?: string;
  /**
   * Explicit Discord category name override. Without it the category is derived
   * (ownerOnly → 소유자 전용, shared → 공용 상담·서류, else → 개인 비서단). Use to place a
   * per-user (shared) bot under a different category — e.g. the saju bot is
   * `shared` (per-user charts) but lives under 「개인 비서단」.
   */
  category?: string;
  /**
   * For SHARED bots: name each user's private thread after that user's FIRST
   * message (the question), truncated, instead of the default "displayName ·
   * username". Lets threads be told apart by topic. (e.g. the resume bot.)
   */
  threadNameFromMessage?: boolean;
  /**
   * For SHARED bots: prefix each per-user thread's name with a short KST timestamp
   * ("MM-DD HH:mm · …") at creation time, so threads can be told apart by when they
   * were opened. With `threadNameFromMessage` this yields a 날짜-시간-제목 title.
   * Reflects CREATION time only — a reused thread keeps its stamp until the session
   * ends (an end command clears the cached thread, so the next message opens a
   * fresh, freshly-stamped one).
   */
  threadNameWithTimestamp?: boolean;
  /**
   * For PERSONAL bots: every message in the parent channel starts its OWN public
   * thread (anchored to the message, named from it), and the reply + any follow-ups
   * live in that thread. Each thread is an isolated conversation (key includes the
   * thread id). Keeps a busy channel tidy — one thread per question.
   * Mutually exclusive with `shared` (which uses per-USER private threads).
   */
  threadPerMessage?: boolean;
  /**
   * Optional MCP server definitions, written verbatim into the workspace's
   * `.mcp.json` as `{ "mcpServers": <this> }`. String values may contain
   * `${VAR}` placeholders, substituted from process.env at write time (so
   * secrets like NOTION_TOKEN are never hardcoded in the registry).
   *
   * Example: `{ notion: { command: 'npx', args: [...], env: { NOTION_TOKEN: '${NOTION_TOKEN}' } } }`
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Optional skill/markdown files whose CONTENT is injected into the workspace
   * CLAUDE.md (under a "## 적용 스킬" section) so the per-conversation claude
   * obeys them. Paths are absolute, or repo-root-relative (resolved against the
   * repo root). A `.skill` file is a ZIP archive; its inner `SKILL.md` entry is
   * extracted and injected.
   */
  skillFiles?: string[];
  /**
   * Optional shared reference paths (dataDir-relative dirs or files, e.g.
   * 'profiles' or 'knowledge/style-guide.md') SYMLINKED into each conversation
   * workspace on provisioning, so the bot's claude can Read them with a relative
   * path inside its (trusted) cwd AND have writes persist back to the canonical
   * dataDir source (visible to every conversation). Use for cross-conversation
   * reference/state data: ④ resume reads+enriches 'profiles', ① newsletter reads
   * 'knowledge' (style guide), 금융 reads+updates 'finance' (재무현황.md).
   */
  sharedRefs?: string[];
  /**
   * When set, this bot may be invoked by the HTTP trigger webhook (opt-in).
   * The string is the default prompt sent when a trigger arrives with no body
   * prompt (e.g. the weather bot's morning-briefing prompt). Personal bots only.
   */
  triggerPrompt?: string;
  /**
   * When true, a {@link triggerPrompt} run posts its reply into a NEW thread off the
   * bot's channel (named after the bot + date) instead of the channel itself — keeps a
   * recurring push (e.g. the weekly finance briefing) tidy. Only affects triggered runs;
   * normal in-channel messages are unaffected. No-op if the channel can't hold threads.
   */
  triggerInThread?: boolean;
  /**
   * When true, this bot only answers in its MAIN channel if it is @-mentioned
   * (tagged). Inside its own thread (threadPerMessage) it answers normally without a
   * tag. For a shared, chatty channel where the bot shouldn't reply to every message.
   * Default (unset) = answer every message in the channel, as before.
   */
  requireMention?: boolean;
  /**
   * When set, on an end-session command the bridge sends THIS prompt to the
   * (still-alive) window and waits for one Stop BEFORE killing it — so the bot
   * flushes pending state to disk on session end. Best-effort: a failure is
   * logged and the window is killed anyway.
   */
  flushOnEnd?: string;
  /**
   * Risky bot whose ONLY shell access is scripts/gated-run.sh (set in allowedTools
   * via the `{{SCRIPTS_DIR}}` placeholder). Destructive commands (push / repo
   * create / issue create / PR comment / code execution) block until a Discord
   * button approves them (events + data/approvals/ handshake). Forces the `claude`
   * backend (no fallback engines) since the gate + token injection assume it.
   */
  gatedShell?: boolean;
  /**
   * Per-user GitHub identity bot. When true, the bridge injects THIS user's stored
   * PAT (data/secrets/github/<userId>.json) into the tmux window's env at launch
   * (GH_TOKEN/GIT_*), and HARD-GATES the launch when no token is registered (so a
   * missing token can never fall back to the host's gh login). Pairs with `shared`
   * (the conversationKey embeds the userId, so two users can never share a window /
   * workspace / token). Approval buttons for these bots route to the requesting
   * user for self-approvable gates (see canApproveGate).
   */
  perUserGitHubAuth?: boolean;
  /**
   * Allow this (gated) bot to run code-execution shells (node/npx/deno/bun/cargo…)
   * in addition to gh/git. The bridge injects `BUTLER_ALLOW_CODE_EXEC=1` into the
   * window so gated-run.sh keeps those bins in its allowlist. They still ALWAYS hit
   * the Discord approval gate, and — because running a cloned repo's own code is an
   * RCE vector on the host — that approval is OWNER-ONLY even on a perUserGitHubAuth
   * bot (the requester can NOT self-approve code execution; see canApproveGate +
   * gated-run.sh's `.owner` marker). git push / issue approvals stay self-approvable.
   * Intended for issue-solving + code-review, which legitimately need builds/tests.
   * Leave unset for issue-creation (no execution).
   */
  allowRepoCodeExec?: boolean;
  /**
   * PII-masking bot (sensitive 상담 등). When true the bridge runs the redact filter
   * (src/redact.ts) on this bot's OUTBOUND reply. Scope is controlled by
   * {@link redactScope} (default 'log'). Off ⇒ the redact filter never touches this
   * bot (100% unchanged).
   */
  redact?: boolean;
  /**
   * How far redaction reaches when {@link redact} is true:
   * - `'log'` (default): the user reply and workspace files stay ORIGINAL; only the
   *   masked copy on the platform's observation surface (server console) is affected,
   *   computed OFF the reply path so Ollama latency never delays the reply. Preserves
   *   private-thread utility (a counselor needs the real details in the reply).
   * - `'post'`: the discord-bound reply body itself is masked (public-channel bots
   *   only; unsuitable for 상담). Inbound text to claude is never masked either way.
   */
  redactScope?: 'log' | 'post';
}
