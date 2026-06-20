import type { ButlerConfig } from '../config.js';
import type { AgentBackend, AgentLaunch } from './types.js';

/**
 * Codex backend — the "plugin" path for issue #1.
 *
 * ⚠️ DISCLAIMER — EXPERIMENTAL / UNVERIFIED SCAFFOLD.
 * This backend has NOT been run end-to-end. It exists so the plugin path is wired
 * up as a starting point; treat it as a draft, not a supported backend. Two things
 * make it unverifiable by this project today:
 *   1. It needs a working `codex` CLI AND Codex auth — a paid ChatGPT plan
 *      (`codex login`) or an `OPENAI_API_KEY` billed per token. The maintainer has
 *      no Codex plan, so the delegation path can't actually be exercised here.
 *   2. Non-interactive plugin activation is unconfirmed. openai/codex-plugin-cc is
 *      normally enabled interactively (`/plugin install`, `/codex:setup`); here we
 *      attempt to load a LOCAL clone via `claude --plugin-dir <dir>`, which may not
 *      fully wire the plugin's hooks/commands without the setup step.
 *
 * WHAT THIS IS (and isn't): unlike a standalone Codex CLI backend, this keeps
 * Claude Code as the driving agent — so the Stop/Notification hooks (completion
 * detection), folder trust, and the `CLAUDE.md` persona all keep working unchanged,
 * with ZERO bridge changes. Codex is reached as a *delegate* (code review / heavy
 * tasks) via the plugin; it is NOT the model answering the user. If you want Codex
 * itself to be the brain, that's a different (standalone-CLI) backend whose
 * completion detection would use Codex's `notify`/`exec --json` (see the README
 * "Agent backends → Codex" section).
 *
 * Plugin: https://github.com/openai/codex-plugin-cc
 *   → clone it locally and point CODEX_PLUGIN_DIR at the clone.
 */
export const codexBackend: AgentBackend = {
  kind: 'codex',
  // Still Claude Code under the hood, so the per-conversation persona file is CLAUDE.md.
  instructionsFile: 'CLAUDE.md',
  launch(config: ButlerConfig): AgentLaunch {
    const { pluginDir } = config.codex;
    if (!pluginDir) {
      throw new Error(
        'Codex backend selected but CODEX_PLUGIN_DIR is not set. Clone ' +
          'openai/codex-plugin-cc locally and point CODEX_PLUGIN_DIR at it, and make ' +
          'sure the `codex` CLI is installed and authenticated (a paid Codex plan or ' +
          'OPENAI_API_KEY). See README "Agent backends → Codex". [experimental/unverified]',
      );
    }
    // Load the Codex plugin into the same `claude` process non-interactively.
    // NOTE: `--plugin-dir` non-interactive activation is unverified (see disclaimer).
    return { bin: config.claudeBin, args: ['--plugin-dir', pluginDir], env: {} };
  },
};
