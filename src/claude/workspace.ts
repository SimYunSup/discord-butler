import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Bot } from '../bots/types.js';
import type { AgentBackend } from '../agents/types.js';
import { readSkillContent } from './skills.js';

/**
 * Builds and returns the absolute working directory for a conversation key,
 * under `<dataDir>/conversations/<key>`. This is the cwd the tmux window's
 * `claude` instance runs in — file & session isolation per (bot × user).
 */
export function conversationDir(dataDir: string, key: string): string {
  return join(dataDir, 'conversations', key);
}

/** Absolute path to the events JSONL file for a conversation. */
export function eventsFile(dataDir: string, key: string): string {
  return join(dataDir, 'events', `${key}.jsonl`);
}

/**
 * Renders the per-conversation CLAUDE.md from the bot's persona + tool rules,
 * plus any injected skill content (pre-read by the caller; see ensureWorkspace).
 *
 * @param skillSections injected skill bodies, in registry order (already read).
 */
function renderClaudeMd(bot: Bot, skillSections: readonly string[]): string {
  const tools = bot.allowedTools.length ? bot.allowedTools.join(', ') : '(none)';
  const lines = [
    `# ${bot.displayName}`,
    '',
    bot.persona,
    '',
    '## 도구 규칙 (tool rules)',
    `- 사용 가능한 도구: ${tools}`,
    '- 허용 목록에 없는 도구나 파괴적 셸 명령은 사용하지 않는다.',
    '',
    '## 대화·입력 규칙 (중요)',
    '- 사용자는 디스코드 채팅 텍스트로만 답할 수 있다. claude 내장 화살표 선택 메뉴(`AskUserQuestion`)나 플랜 승인(`ExitPlanMode`) UI는 사용자에게 보이지 않으니 절대 쓰지 않는다.',
    '- 객관식으로 고르게 하는 편이 나을 때는, 답변 맨 끝에 아래 코드블록을 덧붙이면 디스코드 선택 메뉴(버튼식)로 표시된다(최대 25개 선택지). 사용자가 고른 값이 다음 메시지로 들어온다:',
    '  ```butler-select',
    '  - 선택지 1',
    '  - 선택지 2',
    '  ```',
    '- 자유 서술 답이 필요한 질문이면 위 블록 없이 일반 텍스트로만 묻는다. 한 턴은 반드시 텍스트(필요 시 + select 블록) 응답으로 끝맺고, 입력 대기 상태로 멈추지 않는다.',
    '',
    '## 응답 규칙',
    '- 한국어로 답한다.',
    '',
  ];

  if (skillSections.length) {
    lines.push(
      '## 적용 스킬',
      '아래 스킬 지침을 반드시 따른다. 각 스킬의 절차·규칙을 그대로 적용한다.',
      '',
    );
    for (const section of skillSections) {
      lines.push(section.trim(), '', '---', '');
    }
  }

  return lines.join('\n');
}

/**
 * Renders the `.mcp.json` body for a bot's MCP servers, substituting `${VAR}`
 * placeholders in any string value from process.env at write time. The result
 * is `{ "mcpServers": <substituted bot.mcpServers> }`.
 *
 * Substitution is recursive over arrays/objects/strings. A `${VAR}` with no
 * matching env var is left as-is (and warned), so a misconfiguration surfaces
 * loudly rather than silently writing an empty token.
 */
function renderMcpJson(mcpServers: Record<string, unknown>): string {
  const substituted = substituteEnv(mcpServers);
  return `${JSON.stringify({ mcpServers: substituted }, null, 2)}\n`;
}

/** Recursively substitutes `${VAR}` placeholders in string values from env. */
function substituteEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const env = process.env[name];
      if (env === undefined || env === '') {
        // NOTE: env var missing — leave the placeholder so the failure is visible
        // (e.g. NOTION_TOKEN not in --env-file). Don't write an empty secret.
        console.warn(`[workspace] .mcp.json: env var ${name} is unset; leaving "${match}".`);
        return match;
      }
      return env;
    });
  }
  if (Array.isArray(value)) return value.map(substituteEnv);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteEnv(v);
    }
    return out;
  }
  return value;
}

/**
 * Builds the `.claude/settings.json` for a conversation workspace.
 *
 * Registers Stop, Notification, and PreToolUse/PostToolUse hooks, all invoking
 * the shared `scripts/hook-emit.mjs` to append the event payload to
 * `data/events/<key>.jsonl`. The bridge tails that file to detect completion
 * (Stop), permission/idle prompts (Notification), and tool-call heartbeats
 * (PreToolUse/PostToolUse) that reset its idle deadline during active work.
 *
 * Also writes a permissions allowlist from the bot's allowedTools so safe bots
 * run without interactive prompts (위험봇은 추후 Notification 버튼 승인).
 *
 * @param hookScriptPath absolute path to scripts/hook-emit.mjs
 * @param eventsPath     absolute path to data/events/<key>.jsonl
 */
function renderSettingsJson(bot: Bot, hookScriptPath: string, eventsPath: string): string {
  // The hook command pipes hook stdin into our emitter, passing the target
  // events file and the event name as argv. `node` is assumed on PATH (the
  // bridge process is itself node); hook-emit.mjs reads JSON from stdin.
  // Use an ABSOLUTE node path. A bare `node` fails at runtime: claude runs hooks
  // under a non-interactive shell where fnm's node is not on PATH. process.execPath
  // is the running bridge's own node binary (absolute), which always resolves.
  const nodeBin = process.execPath;
  const command = (eventName: string): string =>
    `${JSON.stringify(nodeBin)} ${JSON.stringify(hookScriptPath)} ${JSON.stringify(eventsPath)} ${eventName}`;

  const settings = {
    // Safe-bot allowlist: tools the bot may use without prompting. Anything not
    // listed still prompts (and surfaces via the Notification hook).
    permissions: {
      allow: bot.allowedTools,
      // Interactive tools the Discord bridge CANNOT drive: AskUserQuestion renders
      // an arrow-key TUI menu and ExitPlanMode a plan-approval prompt. Either one
      // leaves the turn waiting for navigation that never comes (no Stop → timeout).
      // Denied here so claude asks in plain text instead (which the bridge relays).
      // Plus any per-bot denyTools (silently blocked, no prompt).
      deny: ['AskUserQuestion', 'ExitPlanMode', ...(bot.denyTools ?? [])],
    },
    hooks: {
      // Fires when the assistant finishes a turn → carries last_assistant_message.
      Stop: [
        {
          hooks: [{ type: 'command', command: command('Stop') }],
        },
      ],
      // Fires on permission prompts / idle waiting → carries message + notification_type.
      Notification: [
        {
          hooks: [{ type: 'command', command: command('Notification') }],
        },
      ],
      // Heartbeats: fire on every tool call so the bridge's idle deadline resets
      // while the bot is actively working (long research/coding tasks). Not surfaced
      // to Discord — the bridge consumes them only to tell "working" from "wedged".
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('PreToolUse') }] }],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: command('PostToolUse') }] }],
    },
  };

  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Ensures a conversation workspace exists on disk and is fully provisioned:
 *   <conversationDir>/
 *     <instructionsFile>        (persona + tool rules + "respond in Korean" + skills;
 *                                CLAUDE.md for the Claude-family backends)
 *     .claude/settings.json     (Stop + Notification hooks → hook-emit.mjs, allowlist)
 *     .mcp.json                 (bot.mcpServers, ${VAR}-substituted, mode 0600) — if any
 *
 * Idempotent: safe to call on every message. Returns the conversation dir.
 *
 * @param dataDir         butler data root
 * @param key             conversation key
 * @param bot             owning bot definition
 * @param hookScriptPath  absolute path to scripts/hook-emit.mjs
 * @param backend         the agent backend (decides the instructions filename)
 */
export async function ensureWorkspace(
  dataDir: string,
  key: string,
  bot: Bot,
  hookScriptPath: string,
  backend: AgentBackend,
): Promise<string> {
  const cwd = conversationDir(dataDir, key);
  const claudeDir = join(cwd, '.claude');
  const eventsPath = eventsFile(dataDir, key);

  // Make sure the conversation dir, its .claude dir, and the events dir exist.
  await mkdir(claudeDir, { recursive: true });
  await mkdir(join(dataDir, 'events'), { recursive: true });

  // Read any injected skill bodies (in registry order). A missing/unreadable
  // skill file is skipped (warned) rather than breaking provisioning.
  const skillSections: string[] = [];
  for (const file of bot.skillFiles ?? []) {
    const content = await readSkillContent(file);
    if (content) skillSections.push(content);
  }

  await writeFile(join(cwd, backend.instructionsFile), renderClaudeMd(bot, skillSections), 'utf8');
  await writeFile(
    join(claudeDir, 'settings.json'),
    renderSettingsJson(bot, hookScriptPath, eventsPath),
    'utf8',
  );

  // Shared reference data (profiles / knowledge) SYMLINKED into the workspace so
  // the bot can Read it with a relative path inside its cwd AND have updates
  // (e.g. the resume bot enriching a profile) persist back to the canonical
  // dataDir source — visible to every conversation. Idempotent: ignore EEXIST.
  for (const ref of bot.sharedRefs ?? []) {
    const target = join(dataDir, ref); // absolute source under dataDir
    const link = join(cwd, ref);
    try {
      await symlink(target, link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        console.warn(`[workspace] could not link shared ref "${ref}" into ${cwd}:`, err);
      }
    }
  }

  // Per-bot MCP servers → workspace .mcp.json (Claude Code auto-loads it). Write
  // with mode 0600 since substituted values may contain secrets (e.g. tokens).
  if (bot.mcpServers && Object.keys(bot.mcpServers).length > 0) {
    const mcpPath = join(cwd, '.mcp.json');
    await writeFile(mcpPath, renderMcpJson(bot.mcpServers), { mode: 0o600 });
    // writeFile's `mode` only applies on create; chmod enforces 0600 on rewrite.
    await chmod(mcpPath, 0o600);
  }

  return cwd;
}
