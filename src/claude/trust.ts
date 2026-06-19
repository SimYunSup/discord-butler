import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Claude Code's global config file (holds per-project trust state). */
const CLAUDE_JSON = join(homedir(), '.claude.json');

/**
 * Pre-marks a workspace directory as trusted in `~/.claude.json` so Claude Code
 * does NOT show the "Do you trust the files in this folder?" prompt when it is
 * launched there. Claude keys trust by absolute cwd:
 *   projects[<workspaceDir>].hasTrustDialogAccepted = true
 *
 * Best-effort read-modify-write of the shared global config: if the file is
 * missing or unparsable we start from an empty object, and we only touch the
 * single project key (preserving everything else). Must be called BEFORE the
 * tmux window launches `claude` in that dir.
 */
export async function ensureTrusted(workspaceDir: string): Promise<void> {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(CLAUDE_JSON, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }

  const rawProjects = data.projects;
  const projects: Record<string, unknown> =
    rawProjects && typeof rawProjects === 'object'
      ? (rawProjects as Record<string, unknown>)
      : {};
  data.projects = projects;

  const rawEntry = projects[workspaceDir];
  const entry: Record<string, unknown> =
    rawEntry && typeof rawEntry === 'object' ? (rawEntry as Record<string, unknown>) : {};

  if (entry.hasTrustDialogAccepted === true) return; // already trusted; no write

  entry.hasTrustDialogAccepted = true;
  projects[workspaceDir] = entry;

  await writeFile(CLAUDE_JSON, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
