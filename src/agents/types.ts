import type { ButlerConfig } from '../config.js';

/**
 * Which agent backend drives a conversation's tmux window.
 *
 * - `claude`: the default — the `claude` Claude Code CLI.
 * - `kimi`:   the SAME Claude Code CLI pointed at Moonshot's Anthropic-compatible
 *             endpoint via env (config-only; see {@link ./kimi.ts}).
 * - `codex`:  EXPERIMENTAL — the SAME Claude Code CLI with the openai/codex-plugin-cc
 *             plugin loaded so it can delegate to Codex (see {@link ./codex.ts}).
 *
 * A standalone (non-Claude) Codex CLI backend — where Codex itself is the agent —
 * would add another kind plus its own completion-signal source (Codex `notify` /
 * `exec --json`); see the README "Agent backends → Codex".
 */
export type AgentKind = 'claude' | 'kimi' | 'codex';

/** All known backend kinds (used to validate env/registry input). */
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'kimi', 'codex'];

/** Default backend when a bot doesn't specify one and no global override is set. */
export const DEFAULT_AGENT: AgentKind = 'claude';

/** Whether `value` is a known {@link AgentKind}. */
export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

/** The binary + args + extra environment used to launch a backend in a tmux window. */
export interface AgentLaunch {
  /** Binary the window execs (e.g. the `claude` CLI). */
  bin: string;
  /** CLI args passed to the binary (e.g. a future codex backend's `--plugin-dir`). */
  args: string[];
  /** Extra env vars exported into the launch shell before exec (may be empty). */
  env: Record<string, string>;
}

/**
 * An agent backend: the behaviors the bridge varies per agent.
 *
 * The Claude-family backends (`claude`, `kimi`) share Claude Code's machinery —
 * the Stop/Notification hooks (completion detection), folder trust, and the
 * `.claude/settings.json` permissions allowlist — so those live in the shared
 * workspace/trust modules and are deliberately NOT part of this interface. What
 * genuinely varies between them is the LAUNCH (binary + env) and the
 * per-conversation instructions filename.
 *
 * A future non-Claude backend (e.g. a standalone Codex CLI, which uses
 * `AGENTS.md` and has no Stop-hook equivalent) would extend this interface with
 * its own tool-config writer and completion-signal source.
 */
export interface AgentBackend {
  /** Stable kind id. */
  readonly kind: AgentKind;
  /** Per-conversation persona/instructions filename written into the workspace. */
  readonly instructionsFile: string;
  /**
   * Resolves how to launch this backend from runtime config. May throw with a
   * clear message if required config (e.g. an auth token) is missing.
   */
  launch(config: ButlerConfig): AgentLaunch;
}
