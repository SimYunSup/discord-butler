import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The single tmux session that holds all butler conversation windows. */
export const BUTLER_SESSION = 'butler';

/**
 * Delay (ms) before the submitting Enter, SCALED to text length. The claude TUI
 * (Ink) ingests a literal paste asynchronously and proportionally to its size;
 * an Enter sent before the paste finishes rendering is dropped and the turn
 * never submits (observed live with a long multi-line paste). ~0.6s for short
 * messages, capped at 5s for large pastes.
 */
function submitDelayMs(text: string): number {
  return Math.min(600 + text.length * 2, 5000);
}

/** Promise-based delay. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pane-scraping heuristics for the claude REPL state. We avoid scraping for
 * REPLIES (hooks do that), but a little scraping is justified for the two things
 * hooks can't tell us: whether the REPL is up/idle (READY) and whether our
 * submission actually started a turn (WORKING).
 */
// Idle footer the interactive REPL prints once it's ready for input.
const READY_RE = /auto mode on|accept edits|bypass permissions|plan mode on|\? for shortcuts/i;
// The "do you trust this folder" gate (should be pre-accepted, but never type into it).
const TRUST_RE = /trust the files|do you trust/i;
// Shown while claude is actively processing a turn (so the message was submitted).
const WORKING_RE = /esc to interrupt|esc to cancel|\besc\b to|Thinking|Working|Synthesi|tokens|✶|✳|·\s*$/i;

/**
 * Drives tmux via the `tmux` CLI to manage one window per conversation.
 *
 * Layout: a single detached tmux session ("butler") whose windows are named by
 * the (sanitized) conversation key. Each window runs a `claude` instance whose
 * cwd is that conversation's working dir. The bridge injects user text via
 * `send-keys` and relies on Claude Code hooks (not pane scraping) for replies.
 */
export class TmuxManager {
  constructor(
    private readonly tmuxBin: string = 'tmux',
    private readonly claudeBin: string = 'claude',
  ) {}

  /** Runs a tmux subcommand. Resolves stdout; rejects on non-zero exit. */
  private async tmux(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.tmuxBin, args);
    return stdout;
  }

  /**
   * Runs a tmux subcommand but treats a non-zero exit as a boolean false rather
   * than throwing. Used for `has-session` / window-existence checks where tmux
   * signals "no" via exit code.
   */
  private async tmuxOk(args: string[]): Promise<boolean> {
    try {
      await execFileAsync(this.tmuxBin, args);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the shared butler tmux session exists. */
  async sessionExists(): Promise<boolean> {
    return this.tmuxOk(['has-session', '-t', BUTLER_SESSION]);
  }

  /**
   * Whether a window named `windowName` exists in the butler session.
   * Lists window names and checks membership (exact match).
   */
  async windowExists(windowName: string): Promise<boolean> {
    if (!(await this.sessionExists())) return false;
    let out: string;
    try {
      out = await this.tmux([
        'list-windows',
        '-t',
        BUTLER_SESSION,
        '-F',
        '#{window_name}',
      ]);
    } catch {
      return false;
    }
    return out.split('\n').some((name) => name.trim() === windowName);
  }

  /**
   * Ensures a window for `windowName` exists, running `claude` in `cwd`.
   *
   * - Creates the shared butler session (detached, first window) if absent.
   * - Otherwise creates a new named window.
   * In both cases the window's shell starts in `cwd` and launches `claude`.
   *
   * Idempotent: if the window already exists, does nothing.
   *
   * @returns true if a new window was created, false if it already existed.
   */
  async ensureWindow(windowName: string, cwd: string): Promise<boolean> {
    if (await this.windowExists(windowName)) return false;

    // The shell command the new window runs: cd into cwd, then exec claude so
    // the claude process replaces the shell (window closes when claude exits).
    // TODO(live): verify `claude` launches into its interactive REPL here and
    // that the workspace's .claude/settings.json hooks load. On the server,
    // `claude /login` (subscription auth) must have been run once beforehand.
    const launch = `cd ${shellQuote(cwd)} && exec ${shellQuote(this.claudeBin)}`;

    if (await this.sessionExists()) {
      await this.tmux([
        'new-window',
        '-t',
        BUTLER_SESSION,
        '-n',
        windowName,
        '-c',
        cwd,
        launch,
      ]);
    } else {
      // First window of a brand-new detached session is named directly.
      await this.tmux([
        'new-session',
        '-d',
        '-s',
        BUTLER_SESSION,
        '-n',
        windowName,
        '-c',
        cwd,
        launch,
      ]);
    }
    return true;
  }

  /** Captures the visible pane text of a window (best-effort; '' on any error). */
  async capturePane(windowName: string): Promise<string> {
    try {
      return await this.tmux(['capture-pane', '-t', `${BUTLER_SESSION}:${windowName}`, '-p']);
    } catch {
      return '';
    }
  }

  /**
   * Waits until the window's `claude` REPL is up and idle (ready to accept a
   * message). A freshly-launched claude shows a startup banner for a few seconds;
   * sending text/Enter during that window is dropped and the turn never submits
   * (the dominant cause of "no Stop hook" timeouts). We poll the pane for the
   * idle footer the REPL prints once it's interactive, and bail (false) on
   * timeout so the caller can send anyway rather than hang forever.
   */
  async waitUntilReady(windowName: string, timeoutMs = 90_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pane = await this.capturePane(windowName);
      if (READY_RE.test(pane) && !TRUST_RE.test(pane)) {
        // The idle footer can appear a beat before the input box fully settles
        // (welcome screen still painting). A short settle avoids racing it.
        await delay(1500);
        return true;
      }
      await delay(500);
    }
    return false;
  }

  /**
   * Sends a line of user text to the conversation's claude REPL, then Enter.
   *
   * We send the text and the Enter keypress as two separate `send-keys` calls so
   * that the literal text (which may itself contain characters tmux would
   * interpret as key names) is delivered with `-l` (literal), and Enter is sent
   * as the named key.
   *
   * After the Enter we CONFIRM submission: a busy or just-woken TUI sometimes
   * drops the Enter, leaving the text sitting unsubmitted in the input box (claude
   * stays idle → no Stop → timeout). If we don't see the "working" indicator
   * shortly after, we re-send Enter (a few attempts). An extra Enter on an
   * already-submitted/idle prompt is harmless (claude ignores an empty submit).
   *
   * @param windowName target window
   * @param text       the user's message (single logical submission)
   */
  async sendText(windowName: string, text: string): Promise<void> {
    const target = `${BUTLER_SESSION}:${windowName}`;
    // -l sends the buffer literally (no key-name interpretation).
    await this.tmux(['send-keys', '-t', target, '-l', text]);
    // Wait (scaled to text length) before Enter so the TUI finishes ingesting
    // the paste — otherwise the Enter is dropped and the turn never submits.
    await delay(submitDelayMs(text));
    await this.tmux(['send-keys', '-t', target, 'Enter']);

    // Submit confirmation: poll for the working indicator; if absent, the Enter
    // didn't take — nudge it again. Bounded so we never block the turn.
    for (let attempt = 0; attempt < 3; attempt++) {
      await delay(700);
      const pane = await this.capturePane(windowName);
      if (WORKING_RE.test(pane)) return; // claude is processing → submitted.
      await this.tmux(['send-keys', '-t', target, 'Enter']);
    }
  }

  /** Kills a conversation's window (task-mode cleanup after a reply). */
  async killWindow(windowName: string): Promise<void> {
    if (!(await this.windowExists(windowName))) return;
    await this.tmux(['kill-window', '-t', `${BUTLER_SESSION}:${windowName}`]);
  }

  /** Tears down the whole butler session (graceful shutdown helper). */
  async killSession(): Promise<void> {
    if (!(await this.sessionExists())) return;
    await this.tmux(['kill-session', '-t', BUTLER_SESSION]);
  }
}

/** Single-quotes a string for safe interpolation into a /bin/sh command. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
