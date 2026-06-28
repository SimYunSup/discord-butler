import type { ButlerConfig } from '../config.js';
import type { AgentBackend, AgentLaunch } from './types.js';

/**
 * GLM (Z.ai / Zhipu) backend — same shape as the Kimi backend: run the SAME
 * `claude` Claude Code CLI, but pointed at Z.ai's Anthropic-compatible endpoint
 * via env (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, with an optional
 * `ANTHROPIC_MODEL`).
 *
 * Z.ai is the one provider besides Anthropic and Moonshot that exposes an
 * Anthropic-compatible API, so GLM drops into the same config-only path: the
 * Stop/Notification hooks (completion detection), folder trust, and the
 * `CLAUDE.md` persona all keep working — only the model provider changes. It
 * introduces no new completion mechanism. See {@link ./kimi.ts}.
 */
export const glmBackend: AgentBackend = {
  kind: 'glm',
  instructionsFile: 'CLAUDE.md',
  launch(config: ButlerConfig): AgentLaunch {
    const { baseUrl, authToken, model } = config.glm;
    if (!authToken) {
      throw new Error(
        'GLM backend selected but GLM_AUTH_TOKEN is not set. Add your Z.ai ' +
          'API key to the env (GLM_AUTH_TOKEN), or switch the bot/global agent.',
      );
    }
    const env: Record<string, string> = {
      // Point Claude Code at Z.ai's Anthropic-compatible API.
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: authToken,
    };
    // Optional: pin a specific GLM model (e.g. glm-4.7). Left unset → the
    // endpoint's default is used.
    if (model) env.ANTHROPIC_MODEL = model;
    return { bin: config.claudeBin, args: [], env };
  },
};
