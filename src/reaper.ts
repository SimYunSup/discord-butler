import type { SessionEntry, SessionMap, SessionMapStore } from './persistence/session-map.js';
import type { TmuxManager, TmuxWindowInfo } from './tmux/manager.js';

/** Default cutoff: reap a conversation whose window has been idle at least this long. */
export const DEFAULT_MAX_IDLE_MS = 5 * 60 * 60 * 1000; // 5h
/** Default sweep cadence. */
export const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30m

/**
 * Pure: keys of conversations whose last activity is older than `maxIdleMs`.
 * Entries with an empty/unparsable timestamp are skipped — we never reap on bad data.
 */
export function idleSessionKeys(map: SessionMap, now: number, maxIdleMs: number): string[] {
  return Object.entries(map)
    .filter(([, e]) => {
      const t = Date.parse(e.lastActivityIso);
      return Number.isFinite(t) && now - t > maxIdleMs;
    })
    .map(([key]) => key);
}

/** Pure: tmux window names that have no session-map entry (orphans to kill). */
export function orphanWindowNames(map: SessionMap, windows: readonly TmuxWindowInfo[]): string[] {
  const tracked = new Set(Object.values(map).map((entry) => entry.window).filter(Boolean));
  return windows.filter((w) => !tracked.has(w.name)).map((w) => w.name);
}

/**
 * Pure: keys whose backing window is gone or dead — no window recorded, the tmux
 * window vanished, tmux marked the pane dead, or the agent process exited and the
 * pane fell back to a bare shell. These are cleaned up regardless of idle time.
 */
export function deadSessionKeys(map: SessionMap, windows: readonly TmuxWindowInfo[]): string[] {
  const byName = new Map(windows.map((w) => [w.name, w]));
  return Object.entries(map)
    .filter(([, entry]) => {
      if (!entry.window) return true;
      const window = byName.get(entry.window);
      if (!window) return true;
      return window.dead || window.command === 'bash' || window.command === 'zsh' || window.command === 'sh';
    })
    .map(([key]) => key);
}

export interface ReaperDeps {
  sessions: SessionMapStore;
  tmux: TmuxManager;
  /** Idle cutoff (ms). Defaults to {@link DEFAULT_MAX_IDLE_MS} (5h). */
  maxIdleMs?: number;
  /** Sweep interval (ms). Defaults to {@link DEFAULT_INTERVAL_MS} (30m). */
  intervalMs?: number;
  /** Best-effort: announce the reap in the conversation's channel/thread. */
  notify?: (key: string, entry: SessionEntry) => Promise<void> | void;
}

/**
 * Periodically cleans up tmux windows + session-map entries. Each sweep: (1) drops
 * DEAD sessions (window gone or the agent process exited to a bare shell), (2) kills
 * ORPHAN windows with no session-map entry, and (3) reaps IDLE sessions past the
 * cutoff — killing the window, posting a heads-up (best-effort), and dropping the
 * entry — so an abandoned/wedged window can't linger as a ghost. Runs once on start
 * and then every intervalMs. Returns a stop() to clear the timer. The sweep is
 * best-effort and never throws out of the timer.
 */
export function startReaper(deps: ReaperDeps): () => void {
  const maxIdleMs = deps.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const sweep = async (): Promise<void> => {
    const map = await deps.sessions.read();
    const windows = await deps.tmux.listWindowDetails();
    // 1) Dead sessions: window gone or agent process exited. Kill (if any) + drop entry.
    const deadKeys = deadSessionKeys(map, windows);
    for (const key of deadKeys) {
      const entry = map[key];
      if (entry?.window) {
        try {
          await deps.tmux.killWindow(entry.window);
        } catch (err) {
          console.error(`[reaper] dead ${key}: kill failed:`, err);
        }
      }
      await deps.sessions.remove(key);
    }
    // 2) Orphan windows: tmux windows with no session-map entry — kill them.
    const orphans = orphanWindowNames(map, windows);
    for (const windowName of orphans) {
      try {
        await deps.tmux.killWindow(windowName);
      } catch (err) {
        console.error(`[reaper] orphan ${windowName}: kill failed:`, err);
      }
    }
    // 3) Idle sessions past the cutoff (excluding ones already handled as dead).
    const stale = idleSessionKeys(map, Date.now(), maxIdleMs);
    for (const key of stale.filter((key) => !deadKeys.includes(key))) {
      const entry = map[key]!;
      try {
        if (entry.window) await deps.tmux.killWindow(entry.window);
        if (deps.notify) await deps.notify(key, entry);
      } catch (err) {
        console.error(`[reaper] ${key}: reap step failed:`, err);
      }
      await deps.sessions.remove(key);
    }
    if (deadKeys.length) {
      console.log(`[reaper] dropped ${deadKeys.length} dead session-map entr${deadKeys.length === 1 ? 'y' : 'ies'}: ${deadKeys.join(', ')}`);
    }
    if (orphans.length) {
      console.log(`[reaper] killed ${orphans.length} orphan tmux window(s): ${orphans.join(', ')}`);
    }
    if (stale.length) {
      console.log(`[reaper] reaped ${stale.length} idle session(s): ${stale.join(', ')}`);
    }
  };

  const timer = setInterval(() => {
    void sweep().catch((err) => console.error('[reaper] sweep failed:', err));
  }, intervalMs);
  timer.unref?.();
  void sweep().catch((err) => console.error('[reaper] initial sweep failed:', err));
  return () => clearInterval(timer);
}
