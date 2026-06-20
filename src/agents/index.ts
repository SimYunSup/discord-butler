import type { Bot } from '../bots/types.js';
import { claudeBackend } from './claude.js';
import { kimiBackend } from './kimi.js';
import { DEFAULT_AGENT, type AgentBackend, type AgentKind } from './types.js';

export * from './types.js';

/** Registry of available backends, keyed by kind. */
const BACKENDS: Record<AgentKind, AgentBackend> = {
  claude: claudeBackend,
  kimi: kimiBackend,
};

/** Returns the backend implementation for a kind. */
export function getBackend(kind: AgentKind): AgentBackend {
  return BACKENDS[kind];
}

/**
 * Resolves the backend a bot should use: the bot's own `agent` field if set,
 * else the global default (`BUTLER_AGENT`), else `claude`.
 */
export function resolveBackend(bot: Bot, defaultAgent: AgentKind = DEFAULT_AGENT): AgentBackend {
  return getBackend(bot.agent ?? defaultAgent);
}
