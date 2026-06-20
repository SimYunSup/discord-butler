import type { ButlerConfig } from '../config.js';
import type { AgentBackend, AgentLaunch } from './types.js';

/**
 * The default backend: the `claude` Claude Code CLI, launched with no extra env.
 *
 * Persona lives in `CLAUDE.md`; completion detection (Stop/Notification hooks),
 * folder trust, and the tool-permission allowlist all use Claude Code's native
 * machinery, which the shared workspace/trust modules already provision.
 */
export const claudeBackend: AgentBackend = {
  kind: 'claude',
  instructionsFile: 'CLAUDE.md',
  launch(config: ButlerConfig): AgentLaunch {
    return { bin: config.claudeBin, args: [], env: {} };
  },
};
