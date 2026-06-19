import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { parseFileBlock, type OutgoingFile } from './discord/post.js';
import type { ButlerConfig } from './config.js';
import type { Bot } from './bots/types.js';
import { TmuxManager } from './tmux/manager.js';
import { SessionMapStore } from './persistence/session-map.js';
import { ensureWorkspace, eventsFile } from './claude/workspace.js';
import { ensureTrusted } from './claude/trust.js';
import { sanitizeKey } from './router.js';

/** Absolute path to scripts/hook-emit.mjs (sibling of the repo root's scripts/). */
function hookScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ -> repo root -> scripts/hook-emit.mjs
  return resolve(here, '..', 'scripts', 'hook-emit.mjs');
}

/**
 * One normalized hook event as written by scripts/hook-emit.mjs.
 * `event` is the Claude Code hook event name (Stop | Notification | ...).
 */
export interface HookEvent {
  /** Hook event name passed as argv by the settings.json hook command. */
  event: string;
  /** ISO timestamp the emitter wrote this line. */
  ts: string;
  /** The raw hook payload Claude Code passed on stdin (shape varies by event). */
  payload: Record<string, unknown>;
}

/** A user-uploaded Discord attachment to stage into the workspace. */
export interface IncomingAttachment {
  /** Discord CDN URL to download. */
  url: string;
  /** Original filename (sanitized before writing). */
  name: string;
  /** MIME type, if Discord provided one. */
  contentType?: string;
}

/** Callbacks the bridge uses to talk back to Discord. */
export interface BridgeCallbacks {
  /** Deliver the assistant's completed reply text (+ any resolved file attachments). */
  onReply: (text: string, files?: OutgoingFile[]) => Promise<void> | void;
  /** Surface a permission/idle notification (e.g. as a Discord message/button). */
  onNotification?: (message: string, notificationType: string | undefined) => Promise<void> | void;
}

/**
 * Orchestrates a single Discord message → claude → reply round trip:
 *  1. ensure the conversation workspace (CLAUDE.md + hooks) exists,
 *  2. ensure a tmux window running `claude` in that cwd,
 *  3. register an awaiter that tails data/events/<key>.jsonl for the next Stop,
 *  4. send the user text via send-keys,
 *  5. resolve with the assistant's final message (or time out with a clear msg).
 *
 * Notification events seen while waiting are forwarded via onNotification.
 */
/**
 * Companion-mode rolling-memory cadence: after every N user turns, the bridge
 * sends the (kept-alive) claude a one-off instruction to fold the conversation
 * so far into a concise `memory.md`. This is a lightweight guard against context
 * overflow; Claude Code's own `/compact` is the real safety net.
 *
 * NOTE: minimal-by-design. We don't parse tokens or measure context — we just
 * nudge claude to checkpoint its running summary on a fixed cadence. memory.md
 * is loaded by claude as part of the workspace, so the summary persists even if
 * the window is later recycled.
 */
const COMPANION_MEMORY_EVERY_N_TURNS = 12;

/**
 * End-session command aliases. When the user's whole message (trimmed) is one of
 * these, the bridge kills the conversation's window and clears its session entry
 * instead of forwarding to claude — the next message starts a fresh conversation.
 */
const END_COMMANDS = new Set(['/end', '/exit', '/quit', '/reset', '/new', '/종료', '/끝', '/새대화', '/그만']);

/** Whether `text` is an explicit end-session command. */
function isEndCommand(text: string): boolean {
  return END_COMMANDS.has(text.trim().toLowerCase());
}

/** Sanitizes an attachment filename to a safe basename (no path traversal). */
function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[^\w.\-가-힣]+/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 120);
  return cleaned || 'attachment';
}

export class Bridge {
  private readonly tmux: TmuxManager;
  private readonly sessions: SessionMapStore;
  private readonly hookScript: string;

  constructor(private readonly config: ButlerConfig) {
    this.tmux = new TmuxManager(config.tmuxBin, config.claudeBin);
    this.sessions = new SessionMapStore(config.dataDir);
    this.hookScript = hookScriptPath();
  }

  /** The shared session-map store (the Discord handler caches thread ids here). */
  get sessionStore(): SessionMapStore {
    return this.sessions;
  }

  /**
   * Handles one user message for a conversation.
   *
   * @param bot   owning bot
   * @param key   conversation key (router.conversationKey)
   * @param text  user's message text
   * @param cb    Discord callbacks (reply / notification)
   */
  async handleMessage(
    bot: Bot,
    key: string,
    text: string,
    cb: BridgeCallbacks,
    attachments: IncomingAttachment[] = [],
  ): Promise<void> {
    const windowName = sanitizeKey(key);

    // 0. Session command: an explicit end command tears the window down (ending
    //    the conversation) without forwarding anything to claude. Windows are
    //    otherwise kept alive across turns, so this is how a user resets/closes.
    if (isEndCommand(text)) {
      if (bot.flushOnEnd) await this.flushBeforeEnd(bot, key, windowName);
      await this.tmux.killWindow(windowName);
      await this.sessions.remove(key);
      await cb.onReply(
        bot.flushOnEnd
          ? '🔚 데이터를 저장하고 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.'
          : '🔚 이 대화 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.',
      );
      return;
    }

    // 1. Workspace (idempotent): persona + hooks written to disk.
    const cwd = await ensureWorkspace(this.config.dataDir, key, bot, this.hookScript);

    // 1b. Pre-trust the workspace in ~/.claude.json so claude doesn't block on the
    //     "Do you trust this folder?" prompt when it launches here.
    await ensureTrusted(cwd);

    // 2. tmux window running claude in that cwd. If we just created it, claude is
    //    still booting — wait for the REPL to be idle/ready before sending, or the
    //    first message lands during startup and is dropped (never submits).
    const created = await this.tmux.ensureWindow(windowName, cwd);
    await this.sessions.upsert(key, { window: windowName, cwd });
    if (created) {
      const ready = await this.tmux.waitUntilReady(windowName);
      if (!ready) {
        console.warn(`[bridge] claude REPL not ready in "${windowName}" within timeout; sending anyway.`);
      }
    }

    const events = eventsFile(this.config.dataDir, key);

    // 2b. Stage any uploaded attachments into the workspace so claude can Read
    //     them, and build a note listing their local paths.
    const attachNote = await this.stageAttachments(cwd, attachments);
    const base = text || (attachments.length ? '첨부한 파일을 확인해줘.' : '');
    const fullText = (base + attachNote).trim();
    if (!fullText) return; // nothing to send

    // 3. Start watching for the *next* Stop event BEFORE sending input, so we
    //    don't miss a fast reply. We seek to the current end of the events file
    //    and only consider events appended after this point.
    const waitForStop = this.awaitNextStop(events, cb);

    // 4. Inject the user's text.
    await this.tmux.sendText(windowName, fullText);

    // 5. Resolve with the final assistant message (or time out).
    let replyText: string;
    try {
      replyText = await waitForStop;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await cb.onReply(`⌛ 응답을 기다리는 동안 시간이 초과되었거나 오류가 발생했어요 (${reason}).`);
      return;
    }

    await this.sessions.touch(key);
    // Resolve any ```butler-file attachments (paths under the conversation cwd),
    // strip the block, and deliver text + files.
    const { cleaned, files } = await this.extractOutgoingFiles(replyText, cwd);
    await cb.onReply(cleaned, files.length ? files : undefined);

    // Windows are KEPT ALIVE across turns (all bots): conversation context
    // persists and we avoid a cold start (and its submit race) on every message.
    // A user ends a session explicitly via an end command (see step 0). Context
    // growth is bounded by Claude Code's own /compact and by ending the session.
    //
    // Companion-mode bots additionally checkpoint a rolling summary into
    // memory.md on a fixed turn cadence, so the gist survives a later reset.
    if (bot.memoryMode === 'companion') {
      await this.maybeRefreshCompanionMemory(key, windowName);
    }
  }

  /**
   * Best-effort pre-end flush: if the conversation window is alive, send the
   * bot's flushOnEnd prompt and wait for one Stop so the bot can persist state
   * before the window is killed. Any failure (no window, timeout) is logged and
   * swallowed — ending must never be blocked by a failed flush.
   */
  private async flushBeforeEnd(bot: Bot, key: string, windowName: string): Promise<void> {
    if (!bot.flushOnEnd) return;
    try {
      if (!(await this.tmux.windowExists(windowName))) return;
      const cwd = await ensureWorkspace(this.config.dataDir, key, bot, this.hookScript);
      await ensureTrusted(cwd);
      const events = eventsFile(this.config.dataDir, key);
      const noop: BridgeCallbacks = { onReply: () => {}, onNotification: () => {} };
      // A flush is a quick "save then reply 저장완료" turn; cap the wait well below
      // the normal reply timeout so a wedged flush can't make /end hang for minutes.
      const flushTimeoutMs = Math.min(this.config.replyTimeoutMs, 120_000);
      const waitForStop = this.awaitNextStop(events, noop, flushTimeoutMs);
      await this.tmux.sendText(windowName, bot.flushOnEnd);
      await waitForStop;
    } catch (err) {
      console.error('[bridge] flushBeforeEnd failed (ending anyway):', err);
    }
  }

  /**
   * Resolves a ```butler-file block in `text` into Discord attachments. Each path
   * is resolved against the conversation cwd and MUST stay under dataDir (no
   * exfiltration). Missing / oversized / out-of-bounds files are skipped (logged).
   * Returns the text with the block removed and the readable files.
   */
  private async extractOutgoingFiles(
    text: string,
    cwd: string,
  ): Promise<{ cleaned: string; files: OutgoingFile[] }> {
    const parsed = parseFileBlock(text);
    if (!parsed) return { cleaned: text, files: [] };
    const root = resolve(this.config.dataDir);
    const MAX_BYTES = 24 * 1024 * 1024; // Discord upload ceiling headroom
    const files: OutgoingFile[] = [];
    for (const p of parsed.paths) {
      try {
        const abs = resolve(cwd, p);
        if (abs !== root && !abs.startsWith(`${root}/`)) {
          console.warn(`[bridge] butler-file outside dataDir, skipped: ${p}`);
          continue;
        }
        const s = await stat(abs);
        if (!s.isFile() || s.size === 0 || s.size > MAX_BYTES) {
          console.warn(`[bridge] butler-file skipped (size/type): ${p} (${s.size}B)`);
          continue;
        }
        files.push({ name: basename(abs), data: await readFile(abs) });
      } catch (err) {
        console.warn(`[bridge] butler-file read failed (${p}):`, err);
      }
    }
    return { cleaned: parsed.cleaned, files };
  }

  /**
   * Increments the companion turn counter and, every
   * {@link COMPANION_MEMORY_EVERY_N_TURNS} turns, sends a one-off instruction to
   * fold the conversation so far into `<cwd>/memory.md`.
   *
   * Fire-and-forget by design: we do NOT await a Stop for this bookkeeping turn
   * (the user already has their reply; the next user message will queue normally
   * behind claude finishing this). Best-effort — failures are logged, not raised.
   */
  private async maybeRefreshCompanionMemory(key: string, windowName: string): Promise<void> {
    try {
      const entry = await this.sessions.get(key);
      const turn = (entry?.turnCount ?? 0) + 1;
      await this.sessions.patch(key, { turnCount: turn });
      if (turn % COMPANION_MEMORY_EVERY_N_TURNS !== 0) return;

      const instruction = [
        '[시스템] 대화 맥락 유지를 위한 요청입니다. 사용자에게 답하지 말고,',
        '지금까지의 대화 핵심(사용자 상황·합의된 사실·진행 중인 주제·다음 할 일)을',
        '간결한 불릿으로 정리해 워크스페이스의 memory.md 파일에 갱신해 주세요.',
        '기존 memory.md가 있으면 덮어쓰지 말고 최신 상태로 통합하세요.',
      ].join(' ');
      await this.tmux.sendText(windowName, instruction);
    } catch (err) {
      console.error('[bridge] companion memory refresh failed:', err);
    }
  }

  /**
   * Downloads user-uploaded attachments into `<cwd>/attachments/` so the bot's
   * claude can Read them, and returns a note (appended to the message) listing
   * their workspace-relative paths. Best-effort: a failed download is skipped.
   */
  private async stageAttachments(cwd: string, attachments: IncomingAttachment[]): Promise<string> {
    if (!attachments.length) return '';
    const dir = join(cwd, 'attachments');
    await mkdir(dir, { recursive: true });
    const saved: string[] = [];
    for (const att of attachments) {
      try {
        const res = await fetch(att.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const safe = sanitizeFileName(att.name);
        await writeFile(join(dir, safe), buf);
        saved.push(`./attachments/${safe}${att.contentType ? ` (${att.contentType})` : ''}`);
      } catch (err) {
        console.error(`[bridge] attachment download failed (${att.name}):`, err);
      }
    }
    if (!saved.length) return '';
    return `\n\n[첨부파일 ${saved.length}개 — Read 도구로 열어볼 수 있어요]\n${saved.map((s) => `- ${s}`).join('\n')}`;
  }

  /**
   * Tails the events JSONL for the next Stop event and resolves with the
   * assistant's final message text. Forwards any Notification events seen along
   * the way via the callback. Rejects on timeout.
   *
   * Implementation: record the file's current size, then poll for growth and
   * parse only newly-appended complete lines. (A polling tail keeps this
   * dependency-free and robust to the file not existing yet.)
   */
  private awaitNextStop(
    eventsPath: string,
    cb: BridgeCallbacks,
    timeoutMs: number = this.config.replyTimeoutMs,
  ): Promise<string> {
    const pollMs = 250;

    return new Promise<string>((resolvePromise, rejectPromise) => {
      let offset = 0;
      let carry = '';
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      // Arm the timeout up front; finish() clears it.
      const deadline = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        rejectPromise(new Error(`no Stop hook within ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        clearTimeout(deadline);
        fn();
      };

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let evt: HookEvent;
        try {
          evt = JSON.parse(trimmed) as HookEvent;
        } catch {
          return; // ignore malformed/partial lines
        }
        if (evt.event === 'Notification') {
          const message =
            typeof evt.payload.message === 'string' ? evt.payload.message : '권한/입력 대기';
          const notificationType =
            typeof evt.payload.notification_type === 'string'
              ? evt.payload.notification_type
              : undefined;
          // `idle_prompt` fires when claude sits idle waiting for input (e.g. a turn
          // that errored out and never produced a Stop). It is NOT actionable for the
          // Discord user (they ARE the input source) and would otherwise spam the
          // channel every idle interval while an awaiter hangs. Stuck turns still
          // surface via the reply timeout, so drop these.
          if (notificationType === 'idle_prompt') return;
          void cb.onNotification?.(message, notificationType);
          return;
        }
        if (evt.event === 'Stop') {
          finish(() => resolvePromise(extractAssistantText(evt.payload)));
        }
      };

      const poll = async (): Promise<void> => {
        if (settled) return;
        try {
          const s = await stat(eventsPath).catch(() => undefined);
          if (s && s.size > offset) {
            const fh = await open(eventsPath, 'r');
            try {
              const length = s.size - offset;
              const buf = Buffer.alloc(length);
              await fh.read(buf, 0, length, offset);
              offset = s.size;
              carry += buf.toString('utf8');
              const parts = carry.split('\n');
              carry = parts.pop() ?? ''; // last element may be a partial line
              for (const part of parts) handleLine(part);
            } finally {
              await fh.close();
            }
          }
        } catch {
          // transient FS error; keep polling until timeout.
        }
        if (!settled) timer = setTimeout(() => void poll(), pollMs);
      };

      // Seek to end-of-file (so we only see events appended from now on) and
      // start polling. The timeout above fires if no Stop arrives in time.
      void (async () => {
        try {
          const s = await stat(eventsPath);
          offset = s.size;
        } catch {
          offset = 0; // file not created yet; start from the beginning when it appears.
        }
        void poll();
      })();
    });
  }
}

/**
 * Extracts the assistant's final message text from a Stop hook payload.
 *
 * Claude Code's Stop hook stdin includes `last_assistant_message` (a string),
 * which we prefer. If absent, we fall back to a `transcript_path` note — the
 * bridge cannot synchronously parse the transcript here, so we surface a clear
 * placeholder rather than guessing.
 */
function extractAssistantText(payload: Record<string, unknown>): string {
  const last = payload.last_assistant_message;
  if (typeof last === 'string' && last.trim()) return last;
  // TODO(live): if `last_assistant_message` is unavailable on the server's
  // Claude Code build, read the last assistant entry from `transcript_path`
  // (JSONL) instead. Validate which field the installed version emits.
  return '(빈 응답이거나 last_assistant_message를 읽지 못했어요.)';
}
