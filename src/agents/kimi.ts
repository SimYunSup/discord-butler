import type { ButlerConfig } from '../config.js';
import type { AgentBackend, AgentLaunch } from './types.js';

/**
 * Kimi (Moonshot) backend — the lightest path from issue #1: run the SAME
 * `claude` Claude Code CLI, but pointed at Moonshot's Anthropic-compatible
 * endpoint via env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, with an
 * optional `ANTHROPIC_MODEL`).
 *
 * Because the process is still Claude Code, the Stop/Notification hooks (so
 * completion detection is unchanged), folder trust, and the `CLAUDE.md` persona
 * all keep working — only the model provider differs. This is config-only; it
 * introduces no new completion mechanism.
 */
export const kimiBackend: AgentBackend = {
  kind: 'kimi',
  instructionsFile: 'CLAUDE.md',
  launch(config: ButlerConfig): AgentLaunch {
    const { baseUrl, authToken, model } = config.kimi;
    if (!authToken) {
      throw new Error(
        'Kimi backend selected but KIMI_AUTH_TOKEN is not set. Add your Moonshot ' +
          'API key to the env (KIMI_AUTH_TOKEN), or switch the bot/global agent.',
      );
    }
    const env: Record<string, string> = {
      // Point Claude Code at Moonshot's Anthropic-compatible API.
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
    };
    // Optional: pin a specific Kimi model (e.g. kimi-k2-...). Left unset → the
    // endpoint's default is used.
    if (model) env.ANTHROPIC_MODEL = model;
    return { bin: config.claudeBin, args: [], env };
  },
};
