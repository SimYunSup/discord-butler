import type { Bot } from '../bots/types.js';

/**
 * Renders the `/설명` detail card for a bot: the operational knobs a user would want to
 * know — model/effort, escalation & de-escalation triggers, memory mode, and capabilities.
 * Deliberately NOT the raw persona (internal instructions). Pure (no Discord I/O) so it can
 * be unit-tested; the handler wraps the result in an ephemeral reply.
 */
export function renderBotExplainer(bot: Bot): string {
  const lines: string[] = [`📖 **#${bot.channelName}** · ${bot.displayName}`, ''];

  // 모델 · effort. undefined model = the CLI default (no --model); show 기본.
  const modelPart = bot.model ? `\`${bot.model}\`` : '기본';
  lines.push(`🧠 모델  ${modelPart}${bot.effort ? ` · effort ${bot.effort}` : ''}`);

  // 격상 / 격하 — only when the bot has an escalation config.
  const esc = bot.modelEscalation;
  if (esc) {
    // Many bots use the SAME trigger words for both axes — any of them bumps model AND
    // effort. Merge those into one line instead of printing the (long) list twice.
    if (esc.modelTriggers.length && sameWords(esc.modelTriggers, esc.effortTriggers)) {
      lines.push(`⬆️ 격상  ${quoteList(esc.modelTriggers)} → 모델 ${esc.escalatedModel} + effort ${esc.escalatedEffort}`);
    } else {
      const up: string[] = [];
      if (esc.modelTriggers.length) up.push(`${quoteList(esc.modelTriggers)} → 모델 ${esc.escalatedModel}`);
      if (esc.effortTriggers.length) up.push(`${quoteList(esc.effortTriggers)} → effort ${esc.escalatedEffort}`);
      if (up.length) lines.push(`⬆️ 격상  ${up.join(' · ')}`);
    }

    const down: string[] = [];
    if (esc.modelResetTriggers?.length) down.push(quoteList(esc.modelResetTriggers));
    if (esc.effortResetTriggers?.length) down.push(quoteList(esc.effortResetTriggers));
    const uniqDown = [...new Set(down)];
    if (uniqDown.length) lines.push(`⬇️ 격하  ${uniqDown.join(' · ')} → 기본으로`);
  }

  lines.push(
    bot.memoryMode === 'companion'
      ? '🧵 메모리  companion — 대화 맥락을 이어가요(스레드 안 후속 질문이 앞 답을 참조).'
      : '🧵 메모리  task — 매 대화가 독립적이에요(이전 맥락이 쌓이지 않음).',
  );

  lines.push(`🛠 기능  ${summarizeCapabilities(bot.allowedTools)}`);

  lines.push('───', '공통 명령  `/설명` · `/end`(또는 `/새대화`·`/reset`)');
  return lines.join('\n');
}

/** Whether two trigger lists hold the same words (order-insensitive). */
function sameWords(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((w) => setB.has(w));
}

/** Quotes each trigger and joins with `·`, capping a long list with `외 N개`. */
function quoteList(triggers: readonly string[], max = 5): string {
  const shown = triggers.slice(0, max).map((t) => `"${t}"`);
  const rest = triggers.length - shown.length;
  return rest > 0 ? `${shown.join('·')} 외 ${rest}개` : shown.join('·');
}

/**
 * Turns a bot's `allowedTools` (Claude Code tool names / `Bash(cmd:*)` / `mcp__server__*`)
 * into a short human-readable capability summary. Order-stable + de-duped; empty ⇒ a
 * conversation-only bot.
 */
export function summarizeCapabilities(allowedTools: readonly string[]): string {
  const caps: string[] = [];
  const add = (c: string): void => {
    if (!caps.includes(c)) caps.push(c);
  };
  for (const tool of allowedTools) {
    if (tool.startsWith('mcp__notion__')) add('Notion');
    else if (tool === 'WebSearch' || tool === 'WebFetch') add('웹 검색·자료');
    else if (tool === 'Read') add('파일 읽기');
    else if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') add('파일 작성');
    else if (/^Bash\(/.test(tool)) add('셸 명령');
    else if (tool.startsWith('mcp__')) add('외부 연동');
  }
  return caps.length ? caps.join(' · ') : '대화·글쓰기';
}
