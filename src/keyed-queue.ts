/**
 * Serializes async tasks per key: tasks submitted with the same key run one at a
 * time, in submission order; tasks with different keys run concurrently.
 *
 * Why the bridge needs this: a Discord conversation maps to ONE claude tmux
 * window, and replies are detected by tailing a single per-conversation events
 * file for the next `Stop`. If two messages for the same conversation are handled
 * concurrently (user speaks twice in quick succession), both awaiters tail the
 * same file from overlapping offsets and BOTH resolve on the same `Stop` event —
 * posting the identical reply twice. Serializing per conversation key makes each
 * turn wait for the previous one to finish, so one `Stop` resolves exactly one
 * awaiter and send-keys never injects into a still-busy REPL.
 */
export class KeyedQueue {
  /** Per-key tail of the run chain (a settled-swallowing promise) for the LAST queued task. */
  private readonly tails = new Map<string, Promise<unknown>>();

  /**
   * Runs `task` after all previously-queued tasks for `key` have settled.
   * Returns the task's own result/rejection (the chain itself never rejects, so a
   * failing task does not block later same-key tasks).
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    // Run regardless of how the previous task settled (success OR failure).
    const result = prev.then(task, task) as Promise<T>;
    // The chain we store swallows outcomes so the next task always proceeds.
    const guard = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, guard);
    // Drop the entry once this is the tail and it has drained, so an always-on
    // process doesn't accumulate one Map entry per conversation forever.
    void guard.then(() => {
      if (this.tails.get(key) === guard) this.tails.delete(key);
    });
    return result;
  }
}
