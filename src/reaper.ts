import type { SessionEntry, SessionMap, SessionMapStore } from './persistence/session-map.js';
import type { TmuxManager } from './tmux/manager.js';

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
 * Periodically reaps conversations whose tmux window has sat idle past the cutoff:
 * kill the window, post a heads-up (best-effort), and drop the session-map entry —
 * so a long-abandoned window can't linger as a ghost (and a wedged turn surfaces to
 * the user instead of hanging silently). Returns a stop() to clear the timer. The
 * sweep is best-effort and never throws out of the timer.
 */
export function startReaper(deps: ReaperDeps): () => void {
  const maxIdleMs = deps.maxIdleMs ?? DEFAULT_MAX_IDLE_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;

  const sweep = async (): Promise<void> => {
    const map = await deps.sessions.read();
    const stale = idleSessionKeys(map, Date.now(), maxIdleMs);
    for (const key of stale) {
      const entry = map[key]!;
      try {
        if (entry.window) await deps.tmux.killWindow(entry.window);
        if (deps.notify) await deps.notify(key, entry);
      } catch (err) {
        console.error(`[reaper] ${key}: reap step failed:`, err);
      }
      await deps.sessions.remove(key);
    }
    if (stale.length) {
      console.log(`[reaper] reaped ${stale.length} idle session(s): ${stale.join(', ')}`);
    }
  };

  const timer = setInterval(() => {
    void sweep().catch((err) => console.error('[reaper] sweep failed:', err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
