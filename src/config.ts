import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { AGENT_KINDS, DEFAULT_AGENT, isAgentKind, type AgentKind } from './agents/types.js';

/**
 * Validated runtime configuration for the butler bridge.
 * Loaded once at startup; fails fast with a clear error if required env is missing.
 */
export interface ButlerConfig {
  /** Discord bot token. */
  discordToken: string;
  /** Absolute path to the data dir holding conversations/, events/, session-map.json. */
  dataDir: string;
  /** Path (or bare name) of the `claude` Claude Code CLI binary. */
  claudeBin: string;
  /** Path (or bare name) of the `tmux` binary. */
  tmuxBin: string;
  /** How long the bridge waits for a Stop hook before timing out a reply (ms). Absolute backstop. */
  replyTimeoutMs: number;
  /** Idle window (ms): reject only after this long with no hook activity (heartbeats reset it). */
  idleTimeoutMs: number;
  /** localhost HTTP trigger server port (BUTLER_HTTP_PORT, default 8787). */
  httpPort: number;
  /** Shared secret for the trigger webhook; if empty, the server is disabled. */
  triggerToken: string;
  /** Default agent backend for bots that don't set their own (BUTLER_AGENT). */
  defaultAgent: AgentKind;
  /**
   * Kimi (Moonshot) backend settings. Only consulted when a bot — or the global
   * default — selects the `kimi` agent. `authToken` empty means Kimi is not
   * configured (selecting it then fails with a clear error).
   */
  kimi: {
    /** Moonshot's Anthropic-compatible base URL (ANTHROPIC_BASE_URL). */
    baseUrl: string;
    /** Moonshot API key (ANTHROPIC_AUTH_TOKEN). */
    authToken: string;
    /** Optional model id to pin (ANTHROPIC_MODEL); empty → endpoint default. */
    model: string;
  };
}

/** Absolute path to the repo root (one level up from src/). */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> repo root
  return resolve(here, '..');
}

/**
 * Reads and validates configuration from process.env.
 * @throws if DISCORD_TOKEN is missing or empty.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ButlerConfig {
  const discordToken = env.DISCORD_TOKEN?.trim();
  if (!discordToken) {
    throw new Error(
      'DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in ' +
        '(get the token from the Discord Developer Portal → your app → Bot → Reset Token).',
    );
  }

  const dataDir = env.BUTLER_DATA_DIR?.trim()
    ? resolve(env.BUTLER_DATA_DIR.trim())
    : resolve(repoRoot(), 'data');

  // Absolute backstop for one reply (the idle window below is the real guard).
  const replyTimeoutRaw = env.BUTLER_REPLY_TIMEOUT_MS?.trim();
  const replyTimeoutMs = replyTimeoutRaw ? Number.parseInt(replyTimeoutRaw, 10) : 3_600_000;
  if (!Number.isFinite(replyTimeoutMs) || replyTimeoutMs <= 0) {
    throw new Error(`BUTLER_REPLY_TIMEOUT_MS must be a positive integer; got "${replyTimeoutRaw}".`);
  }
  // Idle window: reject only after this long with NO hook activity (PreToolUse/
  // PostToolUse heartbeats keep an actively-working bot alive indefinitely).
  const idleTimeoutRaw = env.BUTLER_IDLE_TIMEOUT_MS?.trim();
  const idleTimeoutMs = idleTimeoutRaw ? Number.parseInt(idleTimeoutRaw, 10) : 1_800_000; // 30 min
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new Error(`BUTLER_IDLE_TIMEOUT_MS must be a positive integer; got "${idleTimeoutRaw}".`);
  }

  const httpPortRaw = env.BUTLER_HTTP_PORT?.trim();
  const httpPort = httpPortRaw ? Number.parseInt(httpPortRaw, 10) : 8787;
  if (!Number.isFinite(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error(`BUTLER_HTTP_PORT must be an integer 0–65535; got "${httpPortRaw}".`);
  }
  const triggerToken = env.BUTLER_TRIGGER_TOKEN?.trim() ?? '';

  const agentRaw = env.BUTLER_AGENT?.trim();
  if (agentRaw && !isAgentKind(agentRaw)) {
    throw new Error(`BUTLER_AGENT must be one of: ${AGENT_KINDS.join(', ')}; got "${agentRaw}".`);
  }
  const defaultAgent: AgentKind = agentRaw && isAgentKind(agentRaw) ? agentRaw : DEFAULT_AGENT;

  const kimi = {
    // Moonshot's documented Anthropic-compatible endpoint (override per region,
    // e.g. https://api.moonshot.cn/anthropic). Trailing slash not required.
    baseUrl: env.KIMI_BASE_URL?.trim() || 'https://api.moonshot.ai/anthropic',
    authToken: env.KIMI_AUTH_TOKEN?.trim() || '',
    model: env.KIMI_MODEL?.trim() || '',
  };

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
    kimi,
  };
}
