import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
 * Concurrency: different conversations run their turns concurrently, and each
 * mutation is a read-modify-write of the WHOLE map — so two turns racing would
 * lose-update each other. We therefore serialize every mutation through a single
 * in-process lock ({@link mutate}) and publish each write atomically (temp file +
 * rename), so a concurrent reader (or a crash mid-write) never sees a torn file.
 *
 * Note: this is plain application code (not a constrained workflow script), so
 * `new Date()` is fine here.
 */
export class SessionMapStore {
  private readonly path: string;
  /**
   * Tail of the serialized mutation chain. Each {@link mutate} appends to it so
   * read-modify-write sequences never interleave across conversations.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, 'session-map.json');
  }

  /** Reads the full map. Returns {} if the file is missing OR unparseable. */
  async read(): Promise<SessionMap> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    try {
      return JSON.parse(raw) as SessionMap;
    } catch (err) {
      // A corrupt/torn map must NOT crash the whole bridge (read() is on the hot
      // path of every turn). Treat it as empty; the next mutation rewrites it cleanly
      // (and atomically, so torn writes no longer happen going forward).
      console.error('[session-map] corrupt session-map.json, treating as empty:', err);
      return {};
    }
  }

  /** Looks up one conversation's entry. */
  async get(key: string): Promise<SessionEntry | undefined> {
    const map = await this.read();
    return map[key];
  }

  /**
   * Runs `fn` under the per-store lock: read the full map, let `fn` mutate it in
   * place, then write it back atomically. Serializing the whole read-modify-write
   * is what prevents two concurrent turns (different keys) from losing each other's
   * update. One mutation throwing does not wedge later ones — the chain is kept
   * alive while the returned promise still rejects to this caller.
   */
  private mutate(fn: (map: SessionMap) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const map = await this.read();
      fn(map);
      await this.write(map);
    });
    this.writeChain = run.catch(() => {});
    return run;
  }

  /**
   * Upserts a conversation entry and stamps lastActivityIso to now. Merges over
   * any existing entry so optional fields (threadId, turnCount) are preserved.
   */
  async upsert(
    key: string,
    entry: Partial<Omit<SessionEntry, 'lastActivityIso'>> & Pick<SessionEntry, 'window' | 'cwd'>,
  ): Promise<void> {
    await this.mutate((map) => {
      map[key] = { ...map[key], ...entry, lastActivityIso: new Date().toISOString() };
    });
  }

  /**
   * Sets/updates arbitrary fields on an entry (creating a sparse entry if the
   * conversation has no tmux window yet, e.g. recording a thread id before the
   * first turn). Stamps lastActivityIso.
   */
  async patch(key: string, fields: Partial<SessionEntry>): Promise<void> {
    await this.mutate((map) => {
      const existing = map[key] ?? { window: '', cwd: '', lastActivityIso: '' };
      map[key] = { ...existing, ...fields, lastActivityIso: new Date().toISOString() };
    });
  }

  /** Updates only the lastActivityIso timestamp for an existing entry. */
  async touch(key: string): Promise<void> {
    await this.mutate((map) => {
      const existing = map[key];
      if (!existing) return;
      existing.lastActivityIso = new Date().toISOString();
    });
  }

  /** Removes a conversation entry (e.g. when its window is killed). */
  async remove(key: string): Promise<void> {
    await this.mutate((map) => {
      delete map[key];
    });
  }

  private async write(map: SessionMap): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    // Atomic publish: write a temp file then rename over the target. rename(2) is
    // atomic within a filesystem, so a concurrent reader (or a crash mid-write) sees
    // either the old map or the new one — never a half-written file.
    const tmp = `${this.path}.tmp.${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    await rename(tmp, this.path);
  }
}
