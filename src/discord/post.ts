import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  type Client,
  type SendableChannels,
  type TextChannel,
} from 'discord.js';

/** Discord hard limit on a single message's content length. */
const DISCORD_MAX = 2000;

/**
 * Splits text into <=2000-char chunks for Discord, preferring to break on
 * newlines so we don't slice mid-line where possible. Falls back to hard slices
 * for any single line longer than the limit.
 */
export function splitForDiscord(text: string, max = DISCORD_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    // A single line longer than max: hard-slice it.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Posts a possibly-long reply to a channel, split into Discord-sized chunks.
 * SuppressEmbeds keeps any links in the reply from expanding into preview cards
 * (the bot's answers are prose, not link shares — embeds just add clutter).
 */
export async function postChunked(channel: SendableChannels, text: string): Promise<void> {
  const body = text.trim() || '(빈 응답)';
  for (const chunk of splitForDiscord(body)) {
    await channel.send({ content: chunk, flags: MessageFlags.SuppressEmbeds });
  }
}

/** customId for the bot's choice select menu (resolved by channel+user at click). */
export const SELECT_CUSTOM_ID = 'butler-select';

/**
 * Parses a ```butler-select fenced block out of a reply. The bot emits this when
 * it wants the user to pick from options (instead of an un-driveable TUI menu).
 * Returns the options + the reply text with the block removed, or null if absent.
 * Discord caps menus at 25 options / 100-char labels, so we slice/truncate.
 */
export function parseSelectBlock(text: string): { cleaned: string; options: string[] } | null {
  const fence = /```butler-select\s*\n([\s\S]*?)```/i;
  const m = text.match(fence);
  if (!m) return null;
  const options = (m[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 25)
    .map((o) => o.slice(0, 100));
  if (options.length === 0) return null;
  return { cleaned: text.replace(fence, '').trim(), options };
}

/**
 * Posts a bot reply, rendering any ```butler-select block as a Discord select
 * menu. Without a block it's a normal chunked text post. The user's pick is fed
 * back as the next turn by the interactionCreate handler.
 */
/** A file the bridge wants Discord to deliver as an attachment. */
export interface OutgoingFile {
  name: string;
  data: Buffer;
}

/**
 * Parses a ```butler-file fenced block: each non-empty line is a file path the
 * bot wants attached to its Discord reply. The bridge resolves/validates/reads
 * the paths (it knows the conversation cwd + dataDir). Returns null if absent.
 *
 *   ```butler-file
 *   ./output/report.pdf
 *   ```
 *
 * The documented form is one bare path per line, but models sometimes improvise a
 * `path: …` / `name: …` key:value form, so we tolerate a leading `path:`/`file:`
 * prefix and drop metadata lines (`name:`/`title:`/…) rather than mistaking them
 * for filenames — otherwise the attachment silently vanishes and the turn can come
 * out empty.
 */
export function parseFileBlock(text: string): { cleaned: string; paths: string[] } | null {
  // Global: a reply may contain MULTIPLE butler-file blocks (the bot sometimes
  // emits one block per file). Collect paths from every block and strip them all.
  const fence = /```butler-file\s*\n([\s\S]*?)```/gi;
  const matches = [...text.matchAll(fence)];
  if (matches.length === 0) return null;
  const META_KEY = /^(name|title|caption|type|mime|desc|description|label)\s*:/i;
  const paths = matches
    .flatMap((m) => (m[1] ?? '').split('\n'))
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !META_KEY.test(l)) // drop `name:`/`title:`/… metadata lines
    .map((l) => {
      const kv = /^(?:path|file)\s*:\s*(.+)$/i.exec(l); // strip a `path:`/`file:` prefix
      return kv ? kv[1]!.trim() : l;
    })
    .filter(Boolean)
    .slice(0, 5);
  if (paths.length === 0) return null;
  return { cleaned: text.replace(fence, '').trim(), paths };
}

/**
 * Posts a bot reply: chunked text, an optional ```butler-select menu, and any
 * attachments the bridge resolved from a ```butler-file block.
 */
export async function postReply(
  channel: SendableChannels,
  text: string,
  files?: OutgoingFile[],
): Promise<void> {
  const parsed = parseSelectBlock(text);
  const body = (parsed ? parsed.cleaned : text).trim();
  const hasFiles = !!files?.length;
  // Post body text. If there's nothing at all (no body, menu, or files), still
  // emit the "(빈 응답)" placeholder via postChunked.
  if (body || (!parsed && !hasFiles)) await postChunked(channel, body);
  if (parsed) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(SELECT_CUSTOM_ID)
      .setPlaceholder('선택하세요')
      .addOptions(parsed.options.map((o) => ({ label: o, value: o })));
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
    await channel.send({ content: '아래에서 선택해 주세요:', components: [row] });
  }
  if (hasFiles) {
    await channel.send({ files: files!.map((f) => ({ attachment: f.data, name: f.name })) });
  }
}

/** customId prefixes for the gated-command approval buttons. */
const GATE_APPROVE = 'gate-approve';
const GATE_DENY = 'gate-deny';

/**
 * Posts Approve/Deny buttons for a gated command awaiting approval.
 *
 * When `mentionUserId` is given (owner-only gates — e.g. code execution, which
 * only the owner may approve), the message pings that user so they're called over
 * to approve instead of the request silently timing out. Self-approvable gates
 * (git push / issue create) pass no mention.
 */
export async function postApprovalButtons(
  channel: SendableChannels,
  cmd: string,
  key: string,
  reqId: string,
  mentionUserId?: string,
): Promise<void> {
  const suffix = `${key}:${reqId}`;
  const approve = new ButtonBuilder()
    .setCustomId(`${GATE_APPROVE}:${suffix}`)
    .setLabel('승인')
    .setStyle(ButtonStyle.Success);
  const deny = new ButtonBuilder()
    .setCustomId(`${GATE_DENY}:${suffix}`)
    .setLabel('거부')
    .setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(approve, deny);
  const shown = cmd.length > 1500 ? `${cmd.slice(0, 1500)}…` : cmd;
  const ping = mentionUserId ? `<@${mentionUserId}> ` : '';
  const ownerNote = mentionUserId ? ' (코드 실행은 소유자 승인이 필요해요)' : '';
  await channel.send({
    content: `${ping}🔐 **승인 필요**${ownerNote} — 실행할 명령:\n\`\`\`\n${shown}\n\`\`\``,
    components: [row],
    ...(mentionUserId ? { allowedMentions: { users: [mentionUserId] } } : {}),
  });
}

/** Parses a gate button customId → { kind, key, reqId }, or null if not one. */
export function parseGateButton(
  customId: string,
): { kind: 'approve' | 'deny'; key: string; reqId: string } | null {
  const m = customId.match(/^gate-(approve|deny):([^:]+):(.+)$/);
  if (!m) return null;
  return { kind: m[1] as 'approve' | 'deny', key: m[2]!, reqId: m[3]! };
}

/**
 * Finds the first GuildText channel named `name` across all cached guilds. Used
 * by the trigger webhook to post into a bot's channel without a message context.
 * Returns undefined if no such channel is cached.
 */
export function findTextChannelByName(client: Client, name: string): SendableChannels | undefined {
  for (const guild of client.guilds.cache.values()) {
    const ch = guild.channels.cache.find(
      (c): c is TextChannel => c.type === ChannelType.GuildText && c.name === name,
    );
    if (ch) return ch;
  }
  return undefined;
}
