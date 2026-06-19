import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** One conversation's tmux/Claude mapping entry. */
export interface SessionEntry {
  /** tmux window name (== sanitized conversation key). */
  window: string;
  /** Working directory the claude instance runs in (the conversation folder). */
  cwd: string;
  /** ISO timestamp of the last message activity for this conversation. */
  lastActivityIso: string;
  /**
   * For shared bots: the Discord private-thread id this conversation lives in.
   * Cached so the handler can re-find a user's thread without scanning members.
   * Absent for personal bots (they reply in-channel).
   */
  threadId?: string;
  /**
   * Rolling turn counter for companion-mode bots. Incremented per user turn;
   * drives the periodic memory.md refresh nudge. Absent for task-mode bots.
   */
  turnCount?: number;
}

/** The whole session map: conversationKey → entry. */
export type SessionMap = Record<string, SessionEntry>;

/**
 * Reads/writes `data/session-map.json`, the conversationKey → {window, cwd,
 * lastActivityIso} mapping. This is the file the bridge consults to know which
 * tmux window backs which conversation across restarts.
 *
 * Note: this is plain application code (not a constrained workflow script), so
 * `new Date()` is fine here.
 */
export class SessionMapStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, 'session-map.json');
  }

  /** Reads the full map. Returns {} if the file does not yet exist. */
  async read(): Promise<SessionMap> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as SessionMap;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  /** Looks up one conversation's entry. */
  async get(key: string): Promise<SessionEntry | undefined> {
    const map = await this.read();
    return map[key];
  }

  /**
   * Upserts a conversation entry and stamps lastActivityIso to now. Merges over
   * any existing entry so optional fields (threadId, turnCount) are preserved.
   * Read-modify-write; fine for our low-concurrency single-process bridge.
   */
  async upsert(
    key: string,
    entry: Partial<Omit<SessionEntry, 'lastActivityIso'>> & Pick<SessionEntry, 'window' | 'cwd'>,
  ): Promise<void> {
    const map = await this.read();
    map[key] = { ...map[key], ...entry, lastActivityIso: new Date().toISOString() };
    await this.write(map);
  }

  /**
   * Sets/updates arbitrary fields on an entry (creating a sparse entry if the
   * conversation has no tmux window yet, e.g. recording a thread id before the
   * first turn). Stamps lastActivityIso.
   */
  async patch(key: string, fields: Partial<SessionEntry>): Promise<void> {
    const map = await this.read();
    const existing = map[key] ?? { window: '', cwd: '', lastActivityIso: '' };
    map[key] = { ...existing, ...fields, lastActivityIso: new Date().toISOString() };
    await this.write(map);
  }

  /** Updates only the lastActivityIso timestamp for an existing entry. */
  async touch(key: string): Promise<void> {
    const map = await this.read();
    const existing = map[key];
    if (!existing) return;
    existing.lastActivityIso = new Date().toISOString();
    await this.write(map);
  }

  /** Removes a conversation entry (e.g. when its window is killed). */
  async remove(key: string): Promise<void> {
    const map = await this.read();
    if (!(key in map)) return;
    delete map[key];
    await this.write(map);
  }

  private async write(map: SessionMap): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }
}
