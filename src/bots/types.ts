/**
 * Memory model for a bot's tmux window lifecycle.
 * - `task`: stateless. A window is spun up per request and killed when the reply
 *   is delivered; no context accumulates across messages.
 * - `companion`: rolling. The window is kept alive; long-term memory rolls into
 *   a `memory.md` and Claude Code `/compact` is the safety net.
 */
export type MemoryMode = 'task' | 'companion';

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
   * Whether this bot is shared across users (isolated per-user via private threads,
   * conversationKey = `${botId}__${userId}`) or personal (conversationKey = botId).
   */
  shared: boolean;
  /** Memory lifecycle for this bot's tmux windows. */
  memoryMode: MemoryMode;
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
   * When set, on an end-session command the bridge sends THIS prompt to the
   * (still-alive) window and waits for one Stop BEFORE killing it — so the bot
   * flushes pending state to disk on session end. Best-effort: a failure is
   * logged and the window is killed anyway.
   */
  flushOnEnd?: string;
}
