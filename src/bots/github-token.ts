import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * One user's registered GitHub identity + PAT. Lives ONLY in
 * `<dataDir>/secrets/github/<userId>.json` (mode 0600), OUTSIDE any conversation
 * workspace — it is never symlinked in, and the token only ever flows to the
 * tmux window as env (see {@link githubTokenEnv}).
 */
export interface GitHubSecret {
  login: string;
  id: number;
  name: string;
  email: string;
  token: string;
  addedAt: string;
}

/**
 * GitHub noreply email (`<id>+<login>@users.noreply.github.com`). Using it as the
 * commit author avoids leaking a real address, stays compatible with GitHub's
 * "block command line pushes that expose my email" setting, and attributes
 * commits precisely.
 */
export function noreplyEmail(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

/**
 * Secret path OUTSIDE any workspace: `<dataDir>/secrets/github/<userId>.json`.
 * userId is Discord's authenticated numeric id, but we still sanitize it
 * conservatively (path-traversal defense).
 */
export function secretPath(dataDir: string, userId: string): string {
  const safe = userId.replace(/[^0-9A-Za-z_-]/g, '_');
  return join(dataDir, 'secrets', 'github', `${safe}.json`);
}

/**
 * Saves with dir 0700 + file 0600. writeFile's `mode` only applies on create, so
 * chmod enforces the mode on rewrite too.
 */
export async function saveGitHubSecret(
  dataDir: string,
  userId: string,
  secret: GitHubSecret,
): Promise<void> {
  const p = secretPath(dataDir, userId);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await chmod(dirname(p), 0o700).catch(() => {});
  await writeFile(p, `${JSON.stringify(secret, null, 2)}\n`, { mode: 0o600 });
  await chmod(p, 0o600);
}

/** Reads the registered secret. Missing/corrupt → undefined (never throws). */
export async function loadGitHubSecret(
  dataDir: string,
  userId: string,
): Promise<GitHubSecret | undefined> {
  try {
    return JSON.parse(await readFile(secretPath(dataDir, userId), 'utf8')) as GitHubSecret;
  } catch {
    return undefined;
  }
}

/** Deletes it. true if a file existed and was removed, false if there was none. */
export async function removeGitHubSecret(dataDir: string, userId: string): Promise<boolean> {
  const before = await loadGitHubSecret(dataDir, userId);
  if (!before) return false;
  await rm(secretPath(dataDir, userId), { force: true });
  return true;
}

/**
 * The env vars to inject into the tmux window at launch. undefined when no token
 * is registered (= the hard-gate signal: don't launch the window at all, so the
 * repo shell can never fall back to the host's `gh` login). GIT_AUTHOR/COMMITTER
 * override `git config`, so commit attribution is fixed by env alone (the persona
 * needs no `git config` step). The caller passes ONLY the message author's
 * Discord-authenticated id — it never parses the key to guess who the user is
 * (token-isolation model).
 */
export async function githubTokenEnv(
  dataDir: string,
  userId: string,
): Promise<Record<string, string> | undefined> {
  const s = await loadGitHubSecret(dataDir, userId);
  if (!s?.token) return undefined;
  const name = s.name || s.login;
  return {
    GH_TOKEN: s.token,
    GITHUB_TOKEN: s.token,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: s.email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: s.email,
  };
}
