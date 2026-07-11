import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { parseFileBlock, type OutgoingFile } from './discord/post.js';
import type { ButlerConfig } from './config.js';
import type { Bot } from './bots/types.js';
import { githubTokenEnv } from './bots/github-token.js';
import { redactPII } from './redact.js';
import { buildModelSwitchCommands, matchedEscalationTriggers, resolveModelTier } from './bots/model-escalation.js';
import { TmuxManager } from './tmux/manager.js';
import { SessionMapStore } from './persistence/session-map.js';
import { ensureWorkspace, eventsFile } from './claude/workspace.js';
import { ensureTrusted } from './claude/trust.js';
import { sanitizeKey } from './router.js';
import { KeyedQueue } from './keyed-queue.js';
import { getBackend, resolveBackend, type AgentBackend, type AgentLaunch } from './agents/index.js';
import type { AgentKind } from './agents/types.js';

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
  /**
   * A throttled, human-readable "what the bot is doing right now" line, derived
   * AUTOMATICALLY from the bot's tool calls (the PreToolUse hook → {@link toolProgressLabel}),
   * surfaced BEFORE the final reply. The handler shows it as a single status line that
   * updates in place. Dropped when unset (e.g. the flush awaiter passes no onProgress).
   */
  onProgress?: (message: string) => Promise<void> | void;
  /**
   * A claude-native permission prompt appeared (the model called a tool not on the
   * allowlist). The bridge CANNOT drive that arrow-key TUI menu, so left alone the
   * turn hangs until the idle timeout. When provided, this is invoked INSTEAD of
   * onNotification to auto-decline (send Escape) so the turn continues — the model
   * is told "no" and adapts to its allowed tools. Distinct from onApproval, which
   * is the gated-run.sh Approve/Deny flow for risky bots (a separate Approval event).
   */
  onPermissionPrompt?: () => Promise<void> | void;
  /**
   * A gated bot's gated-run.sh emitted an Approval event: a destructive command
   * (git push / issue create / PR comment / code execution) is blocked, waiting for
   * a Discord button to approve or deny it. The handler posts Approve/Deny buttons;
   * the click writes a decision file gated-run.sh is polling.
   */
  onApproval?: (cmd: string, key: string, reqId: string) => Promise<void> | void;
  /**
   * The in-flight turn was stopped by /interrupt (window + context kept alive). Invoked right
   * before runTurn returns on interrupt, so the awaiting handler can mark the request message
   * 🛑 (instead of the ✅ it would post on completion).
   */
  onInterrupted?: () => Promise<void> | void;
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
 * Bounds for the post-reply async-followup watcher (see {@link Bridge.armAsyncFollowup}).
 * Idle: give up if NO hook activity arrives for this long — the window is idle, no background
 * subagent is running. Max: hard backstop regardless of activity, so a wedged/looping
 * background subagent can't pin a watcher (and its file-tail poll) open indefinitely.
 */
const ASYNC_FOLLOWUP_IDLE_TIMEOUT_MS = 10 * 60_000;
const ASYNC_FOLLOWUP_MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * End-session command aliases. When the user's whole message (trimmed) is one of
 * these, the bridge kills the conversation's window and clears its session entry
 * instead of forwarding to claude — the next message starts a fresh conversation.
 */
const END_COMMANDS = new Set(['/end', '/exit', '/quit', '/reset', '/new', '/종료', '/끝', '/새대화', '/그만']);

/** Whether `text` is an explicit end-session command. */
export function isEndCommand(text: string): boolean {
  return END_COMMANDS.has(text.trim().toLowerCase());
}

/**
 * Interrupt command aliases. Unlike END_COMMANDS (which kills the window and drops the
 * session), these stop only the IN-FLIGHT claude turn and keep the window / context alive —
 * the next message just continues the same conversation. `/그만` is deliberately an END
 * command, not here, to keep "stop the turn" and "end the session" unambiguous.
 */
const INTERRUPT_COMMANDS = new Set(['/interrupt', '/stop', '/중단', '/멈춰', '/멈춤']);

/** Whether `text` is an explicit interrupt command (see {@link INTERRUPT_COMMANDS}). */
export function isInterruptCommand(text: string): boolean {
  return INTERRUPT_COMMANDS.has(text.trim().toLowerCase());
}

/**
 * Thrown to reject the in-flight {@link tailEventsForStop} awaiter when the user runs
 * /interrupt. The bridge sends `Escape` to stop claude AND proactively aborts this awaiter so
 * the per-key queue is released immediately — correct whether or not an ESC-interrupted Claude
 * Code fires its Stop hook (so no idle-timeout hang). runTurn treats it as a clean, silent
 * return (the handler already acked 🛑).
 */
export class InterruptError extends Error {
  constructor() {
    super('interrupted by /interrupt');
    this.name = 'InterruptError';
  }
}

/** Human-facing engine (backend) names for the {@link engineBanner}. */
const ENGINE_LABEL: Record<AgentKind, string> = {
  claude: 'Claude',
  kimi: 'Kimi',
  glm: 'GLM',
  codex: 'Codex',
};

/**
 * A one-line **engine · model · effort** banner posted UP FRONT (its own message) at the
 * start of a conversation — and again whenever the answering engine or tier changes — so the
 * user always knows who/what is replying. Shown for EVERY engine including the primary
 * claude (🧠); fallback engines get ⚙️. `model`/`effort` are omitted when absent (only the
 * claude backend carries a tier). When a keyword bumped the tier ABOVE the bot's base this
 * turn, the banner names which trigger fired (`⬆️ 격상(트리거: …)`); symmetrically a reset
 * word that dropped a sticky escalation shows `⬇️ 격하(트리거: …)`. Exported for tests.
 */
export function engineBanner(
  engine: AgentKind,
  model?: string,
  effort?: string,
  escalatedTriggers?: string[],
  deescalatedTriggers?: string[],
): string {
  const icon = engine === 'claude' ? '🧠' : '⚙️';
  const parts = [`${icon} **${ENGINE_LABEL[engine]}**`];
  if (model) parts.push(`\`${model}\``);
  if (effort) parts.push(effort);
  if (escalatedTriggers && escalatedTriggers.length) parts.push(`⬆️ 격상(트리거: ${escalatedTriggers.join('·')})`);
  if (deescalatedTriggers && deescalatedTriggers.length) parts.push(`⬇️ 격하(트리거: ${deescalatedTriggers.join('·')})`);
  return parts.join(' · ');
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
  /** Serializes turns per conversation key (see handleMessage). */
  private readonly queue = new KeyedQueue();
  /**
   * Per-key AbortController for the turn currently blocked in awaitNextStop. /interrupt
   * aborts it to release the queue without killing the window (see {@link interrupt}).
   */
  private readonly inflight = new Map<string, AbortController>();
  /**
   * Per-key watcher for STRAY Stop events that arrive AFTER a turn's reply was already posted
   * — e.g. a research bot's Task subagents finish in the background and claude auto-resumes to
   * deliver follow-up answers. awaitNextStop only tails for the in-flight turn and stops the
   * moment it resolves, so without this a bot promising "완료되면 알려드릴게요" could never
   * deliver. Armed once per successful claude reply (see armAsyncFollowup); cancelled at the
   * top of the NEXT runTurn for the same key so it never races that turn's own awaitNextStop.
   */
  private readonly followupWatchers = new Map<string, AbortController>();

  constructor(private readonly config: ButlerConfig) {
    this.tmux = new TmuxManager(config.tmuxBin);
    this.sessions = new SessionMapStore(config.dataDir);
    this.hookScript = hookScriptPath();
  }

  /** The shared session-map store (the Discord handler caches thread ids here). */
  get sessionStore(): SessionMapStore {
    return this.sessions;
  }

  /** The butler data dir (used by the /github-token command to store secrets). */
  get dataDir(): string {
    return this.config.dataDir;
  }

  /**
   * /interrupt: stop the in-flight claude turn for `key` WITHOUT ending the session.
   *
   * Called from the Discord handler OUTSIDE the per-key queue — the queue is blocked by the
   * very turn we're stopping, so routing this through it would deadlock. Two things happen:
   * (1) `Escape` is sent to the window to interrupt claude's current turn, and (2) the blocked
   * awaitNextStop is proactively aborted so the queue is released immediately (window/context
   * stay alive; the next message continues the same conversation). Step 2 makes this correct
   * whether or not an ESC-interrupted Claude Code emits a Stop hook.
   *
   * `key` is the author-derived conversationKey, so a user can only ever interrupt their OWN
   * window (the isolation invariant is preserved).
   *
   * @returns true if a turn was actually in flight and aborted; false if nothing was running.
   */
  async interrupt(key: string): Promise<boolean> {
    const windowName = sanitizeKey(key);
    if (await this.tmux.windowExists(windowName)) {
      await this.tmux.sendKey(windowName, 'Escape');
    }
    const controller = this.inflight.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Handles one user message for a conversation.
   *
   * Turns are SERIALIZED per conversation key: if the user sends several messages
   * in quick succession, each waits for the previous turn to finish instead of
   * running concurrently. This is essential — every concurrent turn would tail the
   * same per-conversation events file and resolve on the next `Stop` it sees, so
   * overlapping turns all latch onto the SAME `Stop` event and post the identical
   * reply multiple times. Serializing also keeps send-keys from injecting text
   * into a still-busy claude REPL.
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
    opts: { authorId?: string } = {},
  ): Promise<void> {
    return this.queue.run(key, () => this.runTurn(bot, key, text, cb, attachments, opts.authorId));
  }

  /** The actual turn body, run under the per-key queue (see handleMessage). */
  private async runTurn(
    bot: Bot,
    key: string,
    text: string,
    cb: BridgeCallbacks,
    attachments: IncomingAttachment[],
    authorId?: string,
  ): Promise<void> {
    const windowName = sanitizeKey(key);

    // Cancel any stray-Stop watcher left over from the PREVIOUS turn on this key (see
    // followupWatchers) before it can race this turn's own awaitNextStop over the same events
    // file — both tail the same file, and if the watcher's Stop arrived first it would relay
    // THIS turn's answer as a bogus "background done" follow-up instead of the fresh reply.
    const staleFollowup = this.followupWatchers.get(key);
    if (staleFollowup) {
      staleFollowup.abort();
      this.followupWatchers.delete(key);
    }

    // 0. Session command: an explicit end command tears the window down (ending
    //    the conversation) without forwarding anything to claude. Windows are
    //    otherwise kept alive across turns, so this is how a user resets/closes.
    if (isEndCommand(text)) {
      const primaryBackend = resolveBackend(bot, this.config.defaultAgent);
      if (bot.flushOnEnd) await this.flushBeforeEnd(bot, key, windowName, primaryBackend);
      await this.tmux.killWindow(windowName);
      await this.sessions.remove(key);
      await cb.onReply(
        bot.flushOnEnd
          ? '🔚 데이터를 저장하고 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.'
          : '🔚 이 대화 세션을 종료했어요. 다음 메시지부터 새 대화로 시작합니다.',
      );
      return;
    }

    // 0b. perUserGitHubAuth bot: token isolation + not-registered hard-gate, decided
    //     BEFORE any window is launched.
    let githubEnv: Record<string, string> | undefined;
    if (bot.perUserGitHubAuth) {
      // Defensive author-match guard: the key already embeds the userId (router), so
      // another user can't produce the same key — but if an existing window's stored
      // authorId differs from the current author (legacy/bug), that would be entering
      // someone else's token window, so refuse unconditionally.
      const prior = await this.sessions.get(key);
      if (prior?.authorId && authorId && prior.authorId !== authorId) {
        await cb.onReply('⛔ 이 작업 공간은 다른 사용자의 것이에요. 본인 채널/스레드에서 다시 시도해 주세요.');
        return;
      }
      // Load ONLY the message author's own token. Not registered ⇒ don't launch the
      // window at all — gated-run/git never runs, so a repo shell can never fall back
      // to the host's `gh` login (the security core of the hard-gate).
      githubEnv = authorId ? await githubTokenEnv(this.config.dataDir, authorId) : undefined;
      if (!githubEnv) {
        await cb.onReply(
          '🔑 먼저 본인 GitHub 토큰을 등록해 주세요: `/github-token token:<PAT>` (응답은 본인만 보여요).\n' +
            '권장: **classic PAT** (`repo` scope). 조직 레포면 그 토큰을 조직용으로 SSO 인가하세요. ' +
            '(fine-grained PAT는 레포·조직마다 승인이 까다로워 classic을 권장합니다.)',
        );
        return;
      }
    }

    // 1. Build the engine chain: [primary, ...fallbacks] with duplicates removed.
    //    Gated bots (github/code-review) are pinned to `claude` — the approval gate,
    //    token injection, and Stop-hook completion detection assume it; a non-claude
    //    fallback engine would silently drop the injected env / gate wiring.
    const primaryKind: AgentKind = bot.agent ?? this.config.defaultAgent;
    const engines: AgentKind[] =
      bot.gatedShell || bot.perUserGitHubAuth
        ? ['claude']
        : [primaryKind, ...this.config.fallbackAgents.filter((kind) => kind !== primaryKind)];

    // 2. Workspace (once, idempotent): persona + hooks written to disk. Use the
    // backend that will actually run FIRST (engines[0]) so the instructions filename
    // matches — for a gated bot that's the pinned `claude`, not a global default.
    const primaryBackend = getBackend(engines[0]!);
    let cwd: string;
    try {
      cwd = await ensureWorkspace(this.config.dataDir, key, bot, this.hookScript, primaryBackend);
      await ensureTrusted(cwd);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await cb.onReply(`⚠️ 워크스페이스 초기화에 실패했어요 (${reason}).`);
      return;
    }

    // 3. Stage any uploaded attachments into the workspace once so every fallback
    //    engine sees the same local files.
    const attachNote = await this.stageAttachments(cwd, attachments);
    const base = text || (attachments.length ? '첨부한 파일을 확인해줘.' : '');
    const fullText = (base + attachNote).trim();
    if (!fullText) return;

    // Per-message model/effort escalation: resolve the tier from the user's raw text
    // (base = bot.model/effort; a matching trigger overrides). STICKY — an earlier
    // escalation carries forward: the sticky tier is the live window's tier recorded at the
    // end of the previous turn (session-map activeModel/activeEffort), so a triggerless
    // message keeps it instead of snapping back to the base; a de-escalation word resets it.
    // Only the claude backend emits `--model`/`--effort`; other backends ignore the tier.
    const priorEntry = await this.sessions.get(key);
    const tier = resolveModelTier(
      { model: bot.model, effort: bot.effort },
      bot.modelEscalation,
      text,
      { model: priorEntry?.activeModel, effort: priorEntry?.activeEffort },
    );

    // Banner markers: which keyword bumped the tier ABOVE the base this turn (⬆️), and
    // which reset word dropped a sticky escalation back to base (⬇️). Only announce an axis
    // that actually CHANGED (a match on a no-op axis, escalated==base, isn't shown).
    const matched = matchedEscalationTriggers(bot.modelEscalation, text);
    const escalatedTriggers = [
      ...new Set(
        [
          matched.model !== undefined && tier.model !== bot.model ? matched.model : undefined,
          matched.effort !== undefined && tier.effort !== bot.effort ? matched.effort : undefined,
        ].filter((t): t is string => t !== undefined),
      ),
    ];
    const deescalatedTriggers = [
      ...new Set(
        [
          matched.modelReset !== undefined && tier.model === bot.model && priorEntry?.activeModel !== bot.model
            ? matched.modelReset
            : undefined,
          matched.effortReset !== undefined && tier.effort === bot.effort && priorEntry?.activeEffort !== bot.effort
            ? matched.effortReset
            : undefined,
        ].filter((t): t is string => t !== undefined),
      ),
    ];
    // The banner is (re)posted only when this signature changes — conversation start, engine
    // change, and tier escalation up/down — so a stable-tier thread isn't spammed every turn.
    let lastBannerSig = priorEntry?.bannerSig;

    // 4. Try each engine in order. On timeout/error, kill the window and start the
    //    next engine fresh. Config errors skip to the next fallback.
    for (let i = 0; i < engines.length; i++) {
      const engineKind = engines[i]!;
      const backend = getBackend(engineKind);

      let launch: AgentLaunch;
      try {
        launch = backend.launch(this.config, tier);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (i === engines.length - 1) {
          await cb.onReply(
            `⚠️ 에이전트 백엔드(${engineKind}) 설정 오류로 시작할 수 없어요 (${reason}).`,
          );
          return;
        }
        continue;
      }

      // Per-conversation env for gated / perUserGitHubAuth bots (the 8 stock bots are
      // untouched — their launch env stays as the backend built it):
      //  - githubEnv: THIS user's PAT + GIT_AUTHOR/COMMITTER (commit attribution).
      //  - BUTLER_KEY/BUTLER_DATA_DIR: gated-run.sh reads the conversation key + data
      //    dir from env (not $PWD), so the approval events/approvals paths stay correct
      //    even when the bot runs a shell inside a cloned repo (work/<repo>).
      //  - GIT_CEILING_DIRECTORIES: stop git/gh from walking ABOVE the workspace to
      //    find a .git (the conversation dir sits inside this repo's tree; without a
      //    ceiling a stray `gh pr checkout` could hijack the platform repo's worktree).
      //  - BUTLER_ALLOW_CODE_EXEC: only for allowRepoCodeExec bots → gated-run keeps
      //    node/npx/etc. in its allowlist (still always gated, owner-only approval).
      if (bot.gatedShell || bot.perUserGitHubAuth) {
        launch.env = {
          ...launch.env,
          ...(githubEnv ?? {}),
          BUTLER_KEY: key,
          BUTLER_DATA_DIR: this.config.dataDir,
          GIT_CEILING_DIRECTORIES: dirname(cwd),
          ...(bot.allowRepoCodeExec ? { BUTLER_ALLOW_CODE_EXEC: '1' } : {}),
        };
      }

      // Engine·model·effort banner — UP FRONT, before the (slow) window boot, so the user
      // knows who/what is answering while they wait. Re-posted only when the tier signature
      // changes (start · engine change · escalation up/down). Only the claude backend carries
      // a model/effort tier; other backends ignore it, so their banner omits both (and the
      // escalation markers, which describe that tier).
      const bannerModel = engineKind === 'claude' ? tier.model : undefined;
      const bannerEffort = engineKind === 'claude' ? tier.effort : undefined;
      const bannerSig = `${engineKind}|${bannerModel ?? ''}|${bannerEffort ?? ''}`;
      if (bannerSig !== lastBannerSig) {
        await cb.onReply(
          engineBanner(
            engineKind,
            bannerModel,
            bannerEffort,
            engineKind === 'claude' ? escalatedTriggers : [],
            engineKind === 'claude' ? deescalatedTriggers : [],
          ),
        );
        lastBannerSig = bannerSig;
        await this.sessions.patch(key, { bannerSig });
      }

      try {
        const created = await this.tmux.ensureWindow(windowName, cwd, launch);
        // Mid-thread escalation: a freshly launched window already took the resolved
        // --model/--effort, but a REUSED (kept-alive) claude window can't take launch flags
        // — and a task-memory bot (no memory.md) would lose in-RAM context if torn down to
        // relaunch. Instead inject /model + /effort into the live REPL, only for the axes
        // that actually change vs. what's active (session-map).
        if (!created && engineKind === 'claude' && bot.modelEscalation) {
          const switches = buildModelSwitchCommands(
            { model: priorEntry?.activeModel, effort: priorEntry?.activeEffort },
            { model: tier.model, effort: tier.effort },
          );
          for (const cmd of switches) await this.tmux.sendText(windowName, cmd);
        }
        await this.sessions.upsert(key, {
          window: windowName,
          cwd,
          // Record the owner so later turns' author-match guard + gate self-approval work.
          ...(authorId ? { authorId } : {}),
          // Record the live model/effort so a later mid-thread turn injects only the diff
          // and a triggerless turn carries the sticky tier forward.
          ...(engineKind === 'claude' ? { activeModel: tier.model, activeEffort: tier.effort } : {}),
        });
        if (created) {
          const ready = await this.tmux.waitUntilReady(windowName);
          if (!ready) {
            console.warn(
              `[bridge] agent REPL not ready in "${windowName}" within timeout; sending anyway.`,
            );
          }
        }

        const events = eventsFile(this.config.dataDir, key);
        // Auto-decline un-answerable claude-native permission prompts (model reached
        // for a non-allowlisted tool): send Escape so the turn continues instead of
        // hanging until the idle timeout.
        const awaitCb: BridgeCallbacks = {
          ...cb,
          onPermissionPrompt: () => {
            console.warn(
              `[bridge] auto-declining permission prompt in "${windowName}" (off-allowlist tool)`,
            );
            return this.tmux.sendKey(windowName, 'Escape');
          },
        };
        // Register an AbortController so /interrupt can release this awaiter (and the queue)
        // without killing the window; cleared in the finally below.
        const abort = new AbortController();
        this.inflight.set(key, abort);
        let replyText: string;
        try {
          const waitForStop = this.awaitNextStop(events, awaitCb, undefined, abort.signal);
          await this.tmux.sendText(windowName, fullText);
          replyText = await waitForStop;
        } finally {
          this.inflight.delete(key);
        }

        await this.sessions.touch(key);
        const { cleaned, files } = await this.extractOutgoingFiles(replyText, cwd);
        // Guard the silent empty reply: if there's no text AND no attachment, don't
        // post a bare blank. If the reply tried to attach a file (butler-file block
        // present) but none survived, say WHY so the user isn't left with a blank.
        let finalText = cleaned;
        if (!finalText.trim() && !files.length) {
          finalText = /```butler-file/i.test(replyText)
            ? '⚠️ 파일을 첨부하려 했지만 전송하지 못했어요 (경로가 작업공간 밖이거나 파일이 없음). 파일을 `./output/` 아래에 저장한 뒤 다시 시도해 주세요.'
            : '⚠️ 빈 응답을 받았어요. 다시 한 번 요청해 주세요.';
        }
        // PII masking (redact:true bots). scope 'post' masks the delivered body
        // (awaited); scope 'log' (default) leaves the reply intact and just flags PII
        // on the server-log observation surface off the reply path.
        finalText = await this.applyRedact(bot, key, finalText);
        await cb.onReply(finalText, files.length ? files : undefined);

        if (bot.memoryMode === 'companion') {
          await this.maybeRefreshCompanionMemory(key, windowName);
        }
        // Window stays alive — arm a bounded watcher for a stray LATER Stop (a background Task
        // subagent finishing after this reply already went out; see followupWatchers). Only
        // claude carries the Task-subagent/background-resume capability this covers.
        if (engineKind === 'claude') {
          this.armAsyncFollowup(bot, key, cwd, events, cb);
        }
        return;
      } catch (err) {
        // /interrupt stopped this turn: keep the window + context alive (do NOT kill), signal
        // the handler so it marks the request message 🛑, then return without a fallback.
        if (err instanceof InterruptError) {
          await cb.onInterrupted?.();
          return;
        }
        await this.tmux.killWindow(windowName).catch(() => {});
        await this.sessions.remove(key).catch(() => {});

        if (i === engines.length - 1) {
          const reason = err instanceof Error ? err.message : String(err);
          await cb.onReply(
            `⌛ 응답을 기다리는 동안 시간이 초과되었거나 오류가 발생했어요 (${reason}).`,
          );
        }
      }
    }
  }

  /**
   * Best-effort pre-end flush: if the conversation window is alive, send the
   * bot's flushOnEnd prompt and wait for one Stop so the bot can persist state
   * before the window is killed. Any failure (no window, timeout) is logged and
   * swallowed — ending must never be blocked by a failed flush.
   */
  private async flushBeforeEnd(
    bot: Bot,
    key: string,
    windowName: string,
    backend: AgentBackend,
  ): Promise<void> {
    if (!bot.flushOnEnd) return;
    try {
      if (!(await this.tmux.windowExists(windowName))) return;
      const cwd = await ensureWorkspace(this.config.dataDir, key, bot, this.hookScript, backend);
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
   * PII masking for a `redact:true` bot's OUTBOUND reply (src/redact.ts). Never
   * throws — a redaction failure must never drop a reply, so any error returns the
   * original text.
   *
   * - `'post'`: mask the discord-bound body itself → awaited before delivery (public
   *   bots only). Returns the masked text.
   * - `'log'` (default): the reply stays ORIGINAL (a counselor needs the real
   *   details); we compute the masked copy OFF the reply path (non-blocking, Ollama
   *   latency hidden) and just log the hit count on the server observation surface.
   */
  private async applyRedact(bot: Bot, key: string, text: string): Promise<string> {
    if (!bot.redact || !text) return text;
    const scope = bot.redactScope ?? 'log';
    if (scope === 'post') {
      try {
        const { text: masked } = await redactPII(text);
        return masked;
      } catch (err) {
        console.error(`[redact] ${key}: masking failed (delivering original):`, err);
        return text;
      }
    }
    // 'log': off the reply path so Ollama latency never delays the user.
    void redactPII(text)
      .then(({ hits }) => {
        if (hits > 0) {
          console.warn(
            `[redact] ${key}: masked ${hits} PII item(s) in observation copy ` +
              '(scope=log; user reply & workspace files unchanged)',
          );
        }
      })
      .catch(() => {});
    return text;
  }

  /**
   * Resolves a ```butler-file block in `text` into Discord attachments. Each path
   * is resolved against the conversation cwd and MUST stay under dataDir OR this
   * conversation's own Claude Code scratchpad (no cross-conversation/host-path
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
    // Claude Code hands each bot a private scratchpad at
    // <tmp>/claude-<uid>/<encoded-cwd>/<uuid>/scratchpad, where <encoded-cwd> is the
    // cwd with every non-alphanumeric char turned into '-'. A bot naturally writes
    // generated files (PNGs, PDFs) there, so allow attaching from it too — the
    // encoded-cwd is unique to THIS conversation, so this can't reach another
    // conversation's files or arbitrary host paths.
    const encodedCwd = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const MAX_BYTES = 24 * 1024 * 1024; // Discord upload ceiling headroom
    const files: OutgoingFile[] = [];
    for (const p of parsed.paths) {
      try {
        const abs = resolve(cwd, p);
        const underData = abs === root || abs.startsWith(`${root}/`);
        const underOwnScratch = abs.includes('/claude-') && abs.includes(`/${encodedCwd}/`);
        if (!underData && !underOwnScratch) {
          console.warn(`[bridge] butler-file outside dataDir/scratchpad, skipped: ${p}`);
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
   * Starts a detached watcher for stray Stop events arriving on `key`'s events file AFTER its
   * turn already replied — see {@link followupWatchers}. Fire-and-forget: does not block the
   * caller (the queue must release immediately). Relays every stray Stop until idle/max
   * timeout, or until the next runTurn on the same key aborts it.
   */
  private armAsyncFollowup(bot: Bot, key: string, cwd: string, eventsPath: string, cb: BridgeCallbacks): void {
    const controller = new AbortController();
    this.followupWatchers.set(key, controller);
    void this.runAsyncFollowup(bot, key, cwd, eventsPath, cb, controller.signal).finally(() => {
      if (this.followupWatchers.get(key) === controller) this.followupWatchers.delete(key);
    });
  }

  /**
   * Waits (bounded) for stray Stop events beyond the turn that already replied and relays EACH
   * one to Discord as an unsolicited follow-up. A background job finishes in stages (e.g. N
   * parallel review subagents completing at different moments), so claude auto-resumes and
   * emits a Stop per stage; every one must reach the user, not just the first. Uses the tail's
   * streaming mode (a single continuous tail, so no Stop is dropped between completions) and
   * gives up silently on idle/max timeout (most turns never produce a stray Stop) or on abort.
   */
  private async runAsyncFollowup(
    bot: Bot,
    key: string,
    cwd: string,
    eventsPath: string,
    cb: BridgeCallbacks,
    signal: AbortSignal,
  ): Promise<void> {
    // Serialize deliveries so two Stops arriving close together still post in arrival order
    // (delivery is async — redact + upload — so a later one could otherwise resolve first).
    let deliverChain: Promise<void> = Promise.resolve();
    try {
      await tailEventsForStop(
        eventsPath,
        { onReply: () => {}, onNotification: cb.onNotification },
        {
          idleTimeoutMs: ASYNC_FOLLOWUP_IDLE_TIMEOUT_MS,
          maxTimeoutMs: ASYNC_FOLLOWUP_MAX_TIMEOUT_MS,
          onStop: (text) => {
            if (!text.trim()) return;
            deliverChain = deliverChain
              .then(async () => {
                const { cleaned, files } = await this.extractOutgoingFiles(text, cwd);
                const finalText = await this.applyRedact(bot, key, cleaned);
                if (!finalText.trim() && !files.length) return; // nothing to deliver
                await cb.onReply(`📎 (백그라운드 완료)\n\n${finalText}`, files.length ? files : undefined);
              })
              .catch((err) => console.error(`[bridge] async followup deliver failed (${key}):`, err));
          },
        },
        signal,
      );
    } catch {
      // idle/max timeout or interrupted — no (further) stray completion; stop watching.
    }
    // The tail has settled; drain any in-flight delivery so a Stop that landed just before the
    // idle cutoff still reaches Discord before we return.
    await deliverChain;
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
   * Awaits the next Stop event on the conversation's events file. Delegates to
   * the exported {@link tailEventsForStop} with this bridge's idle + absolute
   * deadlines.
   *
   * @param maxTimeoutMs absolute backstop (defaults to the reply timeout); a flush
   *   turn passes a smaller cap so a wedged flush can't hang /end.
   */
  private awaitNextStop(
    eventsPath: string,
    cb: BridgeCallbacks,
    maxTimeoutMs: number = this.config.replyTimeoutMs,
    signal?: AbortSignal,
  ): Promise<string> {
    return tailEventsForStop(
      eventsPath,
      cb,
      {
        idleTimeoutMs: this.config.idleTimeoutMs,
        maxTimeoutMs,
      },
      signal,
    );
  }

  /**
   * Records a decision for a gated command (from a Discord button click) to
   * <dataDir>/approvals/<key>.<reqId>.decision, which gated-run.sh is polling.
   */
  async writeApprovalDecision(
    key: string,
    reqId: string,
    decision: 'approve' | 'deny',
  ): Promise<void> {
    const dir = join(this.config.dataDir, 'approvals');
    await mkdir(dir, { recursive: true });
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
    await writeFile(join(dir, `${safe(key)}.${safe(reqId)}.decision`), decision, 'utf8');
  }

  /**
   * Whether a gated request needs OWNER approval (not requester self-approval).
   * gated-run.sh drops a `<key>.<reqId>.owner` marker for code-execution commands
   * (node/npx/deno/bun) on an allowRepoCodeExec bot — running a cloned repo's own
   * code is an RCE vector on the host, so even a perUserGitHubAuth requester must NOT
   * self-approve it. Absent marker (e.g. git push) ⇒ normal self-approval rules.
   */
  async requiresOwnerApproval(key: string, reqId: string): Promise<boolean> {
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
    const marker = join(this.config.dataDir, 'approvals', `${safe(key)}.${safe(reqId)}.owner`);
    return (await stat(marker).catch(() => undefined)) !== undefined;
  }
}

/**
 * Minimum gap between two relayed progress updates (a Discord message edit each). A busy
 * turn fires many PreToolUse hooks per second; without this the status line would edit far
 * past Discord's rate limit. 4s keeps it live but well under the cap.
 */
const PROGRESS_THROTTLE_MS = 4_000;

/** Runaway backstop on progress edits per turn (the 4s throttle keeps a normal turn far under). */
const MAX_PROGRESS_PER_TURN = 300;

/**
 * Maps a Claude Code tool name to a short Korean "지금 하는 일" phrase for the live progress
 * status line. MCP tools collapse by server. An unmapped tool falls back to a generic
 * "작업 중" so a new tool never shows a raw internal name. Exported for tests.
 */
export function toolProgressLabel(toolName: string): string {
  if (toolName.startsWith('mcp__notion__')) return 'Notion 읽고 정리하는 중';
  if (toolName.startsWith('mcp__')) return '외부 도구 사용하는 중';
  switch (toolName) {
    case 'WebFetch':
      return '웹 자료 가져오는 중';
    case 'WebSearch':
      return '웹 검색 중';
    case 'Read':
      return '파일 읽는 중';
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return '파일 작성하는 중';
    case 'Bash':
      return '명령 실행 중';
    case 'Task':
    case 'Agent':
      return '하위 작업 병렬 실행 중';
    case 'Glob':
    case 'Grep':
      return '자료 검색 중';
    case 'ToolSearch':
      return '도구 찾는 중';
    default:
      return '작업 중';
  }
}

/** Deadlines for {@link tailEventsForStop}. */
export interface TailOptions {
  /** Reject after this long with NO hook activity (heartbeats reset it). */
  idleTimeoutMs: number;
  /** Reject after this long regardless of activity (absolute backstop). */
  maxTimeoutMs: number;
  /** Poll cadence for the file tail (ms). Default 250. */
  pollMs?: number;
  /**
   * Streaming mode for the async-followup watcher: when provided, EACH Stop is handed to this
   * callback and tailing CONTINUES (instead of resolving on the first Stop). The promise then
   * settles only on idle/max timeout or abort — so a background job that emits several Stops
   * over time (N parallel subagents finishing at different moments) has every completion
   * relayed, not just the first. A single continuous tail means no Stop is dropped in the gap
   * between two separate awaiters.
   */
  onStop?: (text: string) => void;
}

/**
 * Tails the events JSONL for the next Stop event and resolves with the
 * assistant's final message text. Forwards any Notification events seen along
 * the way via the callback.
 *
 * Two deadlines guard the wait:
 *  - an IDLE deadline that rejects only after `idleTimeoutMs` with NO hook
 *    activity — any parsed event (Stop / Notification / PreToolUse / PostToolUse)
 *    resets it, so an actively-working bot never times out; and
 *  - an absolute `maxTimeoutMs` backstop that rejects regardless of activity.
 *
 * An `idle_prompt` Notification means claude is sitting idle / wedged (e.g. after
 * an API error). It must NOT reset the idle deadline — otherwise a wedged turn
 * would never reject via the idle path — and it is not surfaced to Discord (the
 * user IS the input source). PreToolUse/PostToolUse are heartbeats: they reset
 * the idle deadline but are not surfaced either.
 *
 * Implementation: record the file's current size, then poll for growth and parse
 * only newly-appended complete lines. (A polling tail keeps this dependency-free
 * and robust to the file not existing yet.)
 */
export function tailEventsForStop(
  eventsPath: string,
  cb: BridgeCallbacks,
  opts: TailOptions,
  signal?: AbortSignal,
): Promise<string> {
  const pollMs = opts.pollMs ?? 250;

  return new Promise<string>((resolvePromise, rejectPromise) => {
    let offset = 0;
    let carry = '';
    let inode: number | undefined;
    let settled = false;
    let pollTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    // Live-progress throttle state (see the PreToolUse branch): the last label we relayed
    // and when, plus a runaway per-turn cap. Reset per awaiter (per turn).
    let progressCount = 0;
    let lastProgressLabel = '';
    let lastProgressAt = 0;

    // /interrupt aborts this awaiter → reject with InterruptError so runTurn returns cleanly.
    const onAbort = (): void => finish(() => rejectPromise(new InterruptError()));

    const cleanup = (): void => {
      if (pollTimer) clearTimeout(pollTimer);
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    // (Re)arm the idle deadline; any activity calls this to push it back.
    const resetIdle = (): void => {
      if (settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(() => rejectPromise(new Error(`no Stop hook: idle ${opts.idleTimeoutMs}ms`)));
      }, opts.idleTimeoutMs);
    };
    // Absolute backstop: fires regardless of activity.
    const maxTimer = setTimeout(() => {
      finish(() => rejectPromise(new Error(`no Stop hook: exceeded max ${opts.maxTimeoutMs}ms`)));
    }, opts.maxTimeoutMs);

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let evt: HookEvent;
      try {
        evt = JSON.parse(trimmed) as HookEvent;
      } catch {
        return; // ignore malformed/partial lines
      }
      // An idle_prompt Notification (claude wedged / waiting on input) must NOT
      // reset the idle deadline; every other event counts as activity.
      const isIdlePrompt =
        evt.event === 'Notification' && evt.payload?.notification_type === 'idle_prompt';
      if (!isIdlePrompt) resetIdle();
      if (evt.event === 'PreToolUse') {
        // Auto-progress: turn this tool call into a throttled "지금 하는 일" line. Relay only
        // when the label CHANGES and ≥ PROGRESS_THROTTLE_MS has passed — a run of the same
        // tool collapses to one line, a burst of different tools is rate-limited (each relay
        // is a Discord edit). Never resolves the turn (only Stop does); resetIdle ran above.
        const toolName = typeof evt.payload.tool_name === 'string' ? evt.payload.tool_name : '';
        const label = toolName ? toolProgressLabel(toolName) : '';
        const now = Date.now();
        if (
          label &&
          label !== lastProgressLabel &&
          now - lastProgressAt >= PROGRESS_THROTTLE_MS &&
          progressCount < MAX_PROGRESS_PER_TURN
        ) {
          lastProgressLabel = label;
          lastProgressAt = now;
          progressCount++;
          void cb.onProgress?.(label);
        }
        return;
      }
      // Heartbeats: consumed only to reset the idle deadline (done above); not surfaced.
      if (evt.event === 'PostToolUse') return;
      if (evt.event === 'Notification') {
        const message =
          typeof evt.payload.message === 'string' ? evt.payload.message : '권한/입력 대기';
        const notificationType =
          typeof evt.payload.notification_type === 'string'
            ? evt.payload.notification_type
            : undefined;
        // `idle_prompt` is not actionable for the Discord user; drop it (stuck turns
        // still surface via the idle/absolute deadlines above).
        if (notificationType === 'idle_prompt') return;
        // A claude-native permission prompt is un-answerable from Discord (no way to
        // drive the TUI menu). If the caller wired an auto-decliner, use it so the
        // turn doesn't hang; otherwise fall back to surfacing the notification.
        if (notificationType === 'permission_prompt' && cb.onPermissionPrompt) {
          void cb.onPermissionPrompt();
          return;
        }
        void cb.onNotification?.(message, notificationType);
        return;
      }
      if (evt.event === 'Approval') {
        // A gated-run.sh command is blocked awaiting approval. Surface it (the handler
        // posts Approve/Deny buttons); the wait continues — approval activity resets
        // the idle deadline via resetIdle() above, so a pending gate never times out
        // on idle alone (the absolute maxTimeout still backstops it).
        const p = evt.payload;
        const cmd = typeof p.cmd === 'string' ? p.cmd : '';
        const gateKey = typeof p.key === 'string' ? p.key : '';
        const reqId = typeof p.reqId === 'string' ? p.reqId : '';
        if (cmd && gateKey && reqId) void cb.onApproval?.(cmd, gateKey, reqId);
        return;
      }
      if (evt.event === 'Stop') {
        if (opts.onStop) {
          // Streaming mode: relay this Stop and KEEP tailing for further ones (the idle
          // deadline was already reset above). Only idle/max/abort settles us.
          opts.onStop(extractAssistantText(evt.payload));
          return;
        }
        finish(() => resolvePromise(extractAssistantText(evt.payload)));
      }
    };

    const poll = async (): Promise<void> => {
      if (settled) return;
      try {
        const s = await stat(eventsPath).catch(() => undefined);
        if (s) {
          // The events file shrank or was rotated out from under us. The daily cleanup daemon
          // rotates events/*.jsonl with `tail -n N > tmp; mv tmp ev` (new inode, smaller file
          // that still RETAINS the last N lines). Our offset is now past the new EOF, so
          // `s.size > offset` would never be true again — every later turn for this
          // conversation would hang until the idle timeout. Re-anchor to the CURRENT EOF (not
          // 0): jumping to 0 would re-read retained lines and could re-resolve a stale Stop
          // from a prior turn. We only want Stops appended AFTER the rotation.
          if (s.size < offset || (inode !== undefined && s.ino !== inode)) {
            offset = s.size;
            carry = '';
          }
          inode = s.ino;
        }
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
        // transient FS error; keep polling until a deadline fires.
      }
      if (!settled) pollTimer = setTimeout(() => void poll(), pollMs);
    };

    // /interrupt aborts this awaiter (rejects with InterruptError). Handle an already-aborted
    // signal synchronously before any polling starts.
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    // Arm the idle deadline, seek to end-of-file (so we only see events appended
    // from now on), and start polling. The deadlines above fire if no Stop arrives.
    resetIdle();
    void (async () => {
      try {
        const s = await stat(eventsPath);
        offset = s.size;
        inode = s.ino;
      } catch {
        offset = 0; // file not created yet; start from the beginning when it appears.
      }
      void poll();
    })();
  });
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
