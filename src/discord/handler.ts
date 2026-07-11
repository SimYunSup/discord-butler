import {
  ChannelType,
  Events,
  MessageFlags,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
  type Message,
  type PrivateThreadChannel,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { isEndCommand, type Bridge } from '../bridge.js';
import type { Bot } from '../bots/types.js';
import { bots } from '../bots/registry.js';
import { conversationKey, findBotForChannel } from '../router.js';
import { handleChatInputCommand } from './commands.js';
import { renderBotExplainer } from './bot-explainer.js';
import {
  parseGateButton,
  postApprovalButtons,
  postChunked,
  postReply,
  SELECT_CUSTOM_ID,
} from './post.js';

/**
 * Resolves the channel name used for routing. For a thread, routing matches the
 * parent channel's name; for a normal channel, its own name.
 */
function routingChannelNameForChannel(ch: Channel): string | null {
  if (ch.isThread()) return ch.parent?.name ?? null;
  if ('name' in ch && typeof ch.name === 'string') return ch.name;
  return null;
}

function routingChannelName(message: Message): string | null {
  return routingChannelNameForChannel(message.channel);
}

/** Short note posted into a freshly-created private thread. */
const THREAD_WELCOME = '여기 비공개 스레드에서 이어가요. 이 스레드의 대화는 본인과 봇만 볼 수 있어요.';

/**
 * Short KST timestamp for thread-name prefixes: `MM-DD HH:mm` (e.g. "06-20 14:30").
 * Built via Intl.formatToParts so it is locale-order-independent; `hourCycle:'h23'`
 * keeps midnight as "00", not "24".
 */
function threadTimestamp(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const v = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${v('month')}-${v('day')} ${v('hour')}:${v('minute')}`;
}

/**
 * For a shared bot, resolves the PRIVATE thread this user's conversation lives
 * in, creating it if necessary, and ensures the user is a member.
 *
 * Isolation guarantees (defense in depth — the conversationKey already isolates
 * each user at the bridge/workspace level since it is derived from the message
 * AUTHOR's id):
 *  - The thread is created as a private thread with invitable:false; only the
 *    author + bot are added.
 *  - We look the thread up by the cached id in the session map (keyed by the
 *    author's conversationKey), so we never hand one user another user's thread.
 *
 * @returns the user's private thread, or undefined if creation failed.
 */
async function ensureUserThread(
  parent: TextChannel,
  member: GuildMember,
  key: string,
  bridge: Bridge,
  customName?: string,
  withTimestamp = false,
): Promise<PrivateThreadChannel | undefined> {
  const sessions = bridge.sessionStore;

  // 1. Try the cached thread id for THIS user's conversation key.
  const cached = await sessions.get(key);
  if (cached?.threadId) {
    const existing = parent.threads.cache.get(cached.threadId) ?? (await fetchThread(parent, cached.threadId));
    if (existing && existing.type === ChannelType.PrivateThread && !existing.archived) {
      return existing as PrivateThreadChannel;
    }
  }

  // 2. Create a fresh private thread for this user.
  const displayName = member.displayName || member.user.username;
  const fallback = `${displayName} · ${member.user.username}`;
  const baseName = customName && customName.trim() ? customName.trim() : fallback;
  // Optional KST timestamp PREFIX (bot.threadNameWithTimestamp): "MM-DD HH:mm · <name>",
  // so a prompt-named thread becomes 날짜-시간-제목. Truncate the whole to Discord's
  // 100-char limit — the short prefix survives, only the tail is cut.
  const name = (withTimestamp ? `${threadTimestamp()} · ${baseName}` : baseName).slice(0, 100);
  let thread: PrivateThreadChannel;
  try {
    // We pass type: PrivateThread at runtime; the static return type widens to
    // the public|private union (AllowedThreadTypeForTextChannel), so narrow it.
    const created = await parent.threads.create({
      name,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `discord-butler: per-user private thread (${key})`,
    });
    thread = created as PrivateThreadChannel;
  } catch (err) {
    // TODO(live): private threads require the guild boost level / permission set
    // that allows them; if creation fails, the parent must enable private threads
    // (or grant the bot Manage Threads + Create Private Threads).
    console.error('[handler] failed to create private thread:', err);
    return undefined;
  }

  try {
    await thread.members.add(member.id);
  } catch (err) {
    console.error('[handler] failed to add user to private thread:', err);
  }

  await sessions.patch(key, { threadId: thread.id });
  await thread.send(THREAD_WELCOME).catch(() => undefined);
  return thread;
}

/** Best-effort fetch of a thread by id under a parent channel. */
async function fetchThread(parent: TextChannel, threadId: string): Promise<PrivateThreadChannel | undefined> {
  try {
    const fetched = await parent.threads.fetch(threadId);
    return fetched && fetched.type === ChannelType.PrivateThread
      ? (fetched as PrivateThreadChannel)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the channel a shared bot should reply in, isolating the user:
 *
 * - Message in the shared PARENT channel (GuildText): find or create the user's
 *   PRIVATE thread, add the user, and route this first turn into the thread.
 * - Message already in a private thread under the shared channel: reply there.
 *
 * Returns the sendable reply channel, or undefined if isolation couldn't be set
 * up (e.g. private threads unavailable) — the caller then bails out.
 */
async function resolveSharedReplyChannel(
  message: Message,
  channel: SendableChannels,
  bot: Bot,
  key: string,
  bridge: Bridge,
): Promise<SendableChannels | undefined> {
  // Already inside a private thread under the shared channel → reply here. The
  // conversationKey (author-derived) guarantees this is the author's own
  // conversation even if the thread membership were somehow shared.
  if (channel.isThread()) {
    if (channel.type !== ChannelType.PrivateThread) return undefined; // not our isolation thread
    return channel;
  }

  // In the shared parent channel: spin up / reuse the author's private thread.
  if (channel.type !== ChannelType.GuildText) return undefined;
  const parent = channel as TextChannel;
  const member = message.member ?? (await parent.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) {
    console.error('[handler] could not resolve guild member for shared-bot message.');
    return undefined;
  }
  // For bots that opt in, name the thread after the user's first message (the
  // question), truncated; otherwise ensureUserThread falls back to name·username.
  const threadName = bot.threadNameFromMessage ? message.content.trim().slice(0, 90) : undefined;
  return ensureUserThread(parent, member, key, bridge, threadName, bot.threadNameWithTimestamp);
}

/**
 * Registers the messageCreate handler:
 *  - ignores bots/self,
 *  - finds the bot owning the channel (via router); ignores if none,
 *  - for shared bots, routes into a per-user private thread (isolation),
 *  - hands the message text to the bridge, posting replies/notifications back.
 */
export function registerHandler(client: Client, bridge: Bridge): void {
  client.on(Events.MessageCreate, (message) => {
    void handleMessage(message, bridge).catch((err) => {
      console.error('[handler] error while handling message:', err);
    });
  });
  client.on(Events.InteractionCreate, (interaction) => {
    // Slash commands: /설명 is per-channel (needs bot routing); /github-token* are
    // ephemeral token onboarding.
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === '설명') {
        void handleSessionCommand(interaction, bridge).catch((err) =>
          console.error('[handler] error while handling session command:', err),
        );
        return;
      }
      void handleChatInputCommand(interaction, bridge).catch((err) =>
        console.error('[handler] error while handling chat-input command:', err),
      );
      return;
    }
    // Select-menu clicks (the bot's choice UI) → feed the picked option back as a turn.
    if (interaction.isStringSelectMenu() && interaction.customId === SELECT_CUSTOM_ID) {
      void handleSelect(interaction, bridge).catch((err) => {
        console.error('[handler] error while handling select interaction:', err);
      });
      return;
    }
    // Gated-command Approve/Deny buttons (risky GitHub bots).
    if (interaction.isButton() && parseGateButton(interaction.customId)) {
      void handleGateButton(interaction, bridge).catch((err) => {
        console.error('[handler] error while handling gate button:', err);
      });
    }
  });
}

/**
 * Whether `clickerId` may decide a gated command for conversation `key`.
 *
 * - The owner (OWNER_DISCORD_ID) may always approve.
 * - For a perUserGitHubAuth bot, the REQUESTING user (the window's stored authorId)
 *   may self-approve their own push/issue/comment — they act under their own token.
 * - Code-execution gates (requireOwner, marked by gated-run.sh) are OWNER-ONLY even
 *   on a perUserGitHubAuth bot: the requester must not self-approve running a cloned
 *   repo's code (RCE on the host).
 *
 * botId is the part of the key before `__` (router's conversationKey scheme).
 */
export function canApproveGate(
  key: string,
  clickerId: string,
  ownerId: string | undefined,
  authorId: string | undefined,
  requireOwner = false,
): boolean {
  if (ownerId && clickerId === ownerId) return true;
  if (requireOwner) return false;
  const botId = key.split('__')[0] ?? key;
  const bot = bots.find((b) => b.id === botId);
  if (bot?.perUserGitHubAuth && authorId && clickerId === authorId) return true;
  return false;
}

/**
 * Handles a click on a gated-command Approve/Deny button. Writes the decision file
 * gated-run.sh is polling, then disables the buttons. Owner may always decide; a
 * perUserGitHubAuth requester may decide their OWN (non-code-exec) gate.
 */
async function handleGateButton(interaction: ButtonInteraction, bridge: Bridge): Promise<void> {
  const parsed = parseGateButton(interaction.customId);
  if (!parsed) return;
  const entry = await bridge.sessionStore.get(parsed.key);
  const requireOwner = await bridge.requiresOwnerApproval(parsed.key, parsed.reqId);
  if (
    !canApproveGate(
      parsed.key,
      interaction.user.id,
      process.env.OWNER_DISCORD_ID,
      entry?.authorId,
      requireOwner,
    )
  ) {
    await interaction
      .reply({
        content: requireOwner
          ? '코드 실행은 소유자만 승인할 수 있어요.'
          : '승인 권한이 없어요 (요청자 본인 또는 소유자만).',
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => undefined);
    return;
  }
  await bridge.writeApprovalDecision(parsed.key, parsed.reqId, parsed.kind);
  const label = parsed.kind === 'approve' ? '✅ 승인됨 — 실행합니다.' : '🚫 거부됨 — 중단합니다.';
  await interaction.update({ content: label, components: [] }).catch(() => undefined);
}

/**
 * Handles a click on the bot's choice select menu: resolves the owning bot +
 * conversation (by the interaction's channel + user, same routing as a message),
 * acks the interaction (collapsing the menu), then runs the chosen option as the
 * next turn — replies post back into the same channel/thread.
 */
async function handleSelect(interaction: StringSelectMenuInteraction, bridge: Bridge): Promise<void> {
  const choice = interaction.values[0];
  const channel = interaction.channel;
  if (!choice || !channel || !channel.isSendable()) {
    await interaction.deferUpdate().catch(() => undefined);
    return;
  }
  const bot = findBotForChannel(routingChannelNameForChannel(channel));
  if (!bot) {
    await interaction.deferUpdate().catch(() => undefined);
    return;
  }
  if (bot.ownerOnly && interaction.user.id !== process.env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: '이 비서는 소유자 전용이에요.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  if (bot.allowedUserIdEnv) {
    const allowedId = process.env[bot.allowedUserIdEnv];
    if (!allowedId || interaction.user.id !== allowedId) {
      await interaction.reply({ content: '이 비서는 지정된 사용자 전용이에요.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
      return;
    }
  }
  // conversationKey is the interacting USER's — same isolation as messages.
  const key = conversationKey(bot, interaction.user.id);
  // Ack within Discord's 3s window: collapse the menu and echo the choice.
  await interaction.update({ content: `선택: **${choice}**`, components: [] }).catch(() => undefined);

  const typing = (): void => void channel.sendTyping().catch(() => undefined);
  typing();
  const typingTimer = setInterval(typing, 8000);
  try {
    await bridge.handleMessage(
      bot,
      key,
      choice,
      {
        onReply: (reply, files) => postReply(channel, reply, files),
        onNotification: (notif, notifType) =>
          postChunked(channel, `🔔 ${bot.displayName}: ${notif}${notifType ? ` [${notifType}]` : ''}`),
        onApproval: async (cmd, gateKey, reqId) => {
          // Owner-only gates (code execution) ping the owner so they come approve.
          const ownerOnly = await bridge.requiresOwnerApproval(gateKey, reqId);
          await postApprovalButtons(channel, cmd, gateKey, reqId, ownerOnly ? process.env.OWNER_DISCORD_ID : undefined);
        },
      },
      [],
      { authorId: interaction.user.id },
    );
  } finally {
    clearInterval(typingTimer);
  }
}

/**
 * Handles a per-channel session slash command (currently `/설명`): resolves the owning bot
 * from the interaction's channel, applies the same access gate as a message (ownerOnly +
 * allowedUserIdEnv), then replies ephemerally with the bot's detail card. Read-only — no
 * bridge turn is run.
 */
async function handleSessionCommand(
  interaction: ChatInputCommandInteraction,
  _bridge: Bridge,
): Promise<void> {
  const channel = interaction.channel;
  const bot = channel ? findBotForChannel(routingChannelNameForChannel(channel)) : undefined;
  if (!channel || !channel.isSendable() || !bot) {
    await interaction
      .reply({ content: '여기서는 쓸 수 없는 명령이에요. 비서 채널/스레드에서 사용해 주세요.', flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
    return;
  }
  if (bot.ownerOnly && interaction.user.id !== process.env.OWNER_DISCORD_ID) {
    await interaction.reply({ content: '이 비서는 소유자 전용이에요.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
    return;
  }
  if (bot.allowedUserIdEnv) {
    const allowedId = process.env[bot.allowedUserIdEnv];
    if (!allowedId || interaction.user.id !== allowedId) {
      await interaction
        .reply({ content: '이 비서는 지정된 사용자 전용이에요.', flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }
  }
  if (interaction.commandName === '설명') {
    await interaction
      .reply({ content: renderBotExplainer(bot), flags: MessageFlags.Ephemeral })
      .catch(() => undefined);
  }
}

async function handleMessage(message: Message, bridge: Bridge): Promise<void> {
  // Ignore bots (including ourselves) to avoid loops.
  if (message.author.bot) return;
  const text = message.content.trim();
  // Image/file attachments the user uploaded — staged into the workspace so the
  // bot's claude can Read them. (url is a Discord CDN link, fetched by the bridge.)
  const attachments = [...message.attachments.values()].map((a) => ({
    url: a.url,
    name: a.name || 'attachment',
    contentType: a.contentType ?? undefined,
  }));
  // Ignore truly empty messages (no text AND no attachments).
  if (!text && attachments.length === 0) return;

  const channelName = routingChannelName(message);
  const bot = findBotForChannel(channelName);
  if (!bot) return; // not a butler channel — ignore.

  // Owner-only bots: politely decline anyone but the configured owner.
  if (bot.ownerOnly && message.author.id !== process.env.OWNER_DISCORD_ID) {
    await message.reply('이 비서는 소유자 전용이에요.').catch(() => undefined);
    return;
  }
  // allowedUserIdEnv bots: only that user may use it; unset env ⇒ locked (no one).
  if (bot.allowedUserIdEnv) {
    const allowedId = process.env[bot.allowedUserIdEnv];
    if (!allowedId || message.author.id !== allowedId) {
      await message.reply('이 비서는 지정된 사용자 전용이에요.').catch(() => undefined);
      return;
    }
  }

  const channel = message.channel;
  if (!channel.isSendable()) return;

  // Determine the reply channel + the thread id that scopes this conversation.
  // conversationKey is ALWAYS derived from the message author → a user can never
  // be routed into another user's tmux window / workspace, regardless of which
  // channel or thread the message arrived in.
  let replyChannel: SendableChannels = channel;
  let threadId: string | undefined;

  if (bot.shared) {
    // --- Shared-bot private-thread routing ---
    // For a shared bot, isolate each user in their own private thread under the
    // shared parent channel.
    const resolved = await resolveSharedReplyChannel(
      message,
      channel,
      bot,
      conversationKey(bot, message.author.id),
      bridge,
    );
    if (!resolved) return; // couldn't establish an isolated thread; bail (logged).
    replyChannel = resolved;
  } else if (bot.threadPerMessage) {
    // --- Per-question public-thread routing ---
    // Each new question in the parent channel starts its OWN public thread,
    // anchored to the message; the reply + follow-ups live there. Each thread is
    // an isolated conversation (its id further-scopes the author-derived key).
    if (channel.isThread()) {
      // Follow-up inside an existing question-thread → continue here.
      replyChannel = channel;
      threadId = channel.id;
    } else if (channel.type === ChannelType.GuildText) {
      // New question in the parent channel → start a public thread from this message.
      const name = (text.slice(0, 90) || bot.displayName).trim();
      try {
        const thread = await message.startThread({ name, autoArchiveDuration: 1440 });
        replyChannel = thread;
        threadId = thread.id;
      } catch (err) {
        console.error('[handler] failed to start per-question thread; replying in channel:', err);
      }
    }
  }

  // conversationKey is ALWAYS derived from the author (invariant). threadId (when
  // present) only FURTHER-scopes threadPerMessage bots to one conversation per thread.
  const key = conversationKey(bot, message.author.id, threadId);

  // --- Status surface: ⏳/✅/⚠️ reactions + typing ---
  // The channel TOPIC is reserved for the bot's usage guide, so progress is shown
  // only via reactions (not rate-limited) and the typing indicator.
  const botUserId = message.client.user?.id;
  void message.react('⏳').catch(() => undefined);

  // Keep the typing indicator alive while claude works (it expires after ~10s).
  const typing = (): void => void replyChannel.sendTyping().catch(() => undefined);
  typing();
  const typingTimer = setInterval(typing, 8000);

  // Live progress: a SINGLE status line ("⏳ 지금: <라벨>…") the bridge feeds from the bot's
  // tool calls (PreToolUse hook → toolProgressLabel, throttled). We edit it in place as the
  // label changes and DELETE it when the turn finishes — the real answer follows via onReply.
  // The message location is persisted to session-map the moment it's created, so a bridge
  // crash/restart mid-turn doesn't strand it: the next boot sweeps and deletes the orphan
  // (see client.ts). Edits serialize through a chain so overlapping awaits can't post twice.
  let progressMsg: Message | undefined;
  let progressChain: Promise<void> = Promise.resolve();
  const pushProgress = (label: string): Promise<void> => {
    progressChain = progressChain
      .then(async () => {
        const content = `⏳ 지금: ${label}…`;
        if (!progressMsg) {
          progressMsg = await replyChannel
            .send({ content, flags: MessageFlags.SuppressEmbeds })
            .catch(() => undefined);
          if (progressMsg) {
            await bridge.sessionStore
              .patch(key, { progressMsg: { channelId: replyChannel.id, messageId: progressMsg.id } })
              .catch(() => undefined);
          }
        } else {
          await progressMsg.edit({ content }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return progressChain;
  };
  const finalizeProgress = async (): Promise<void> => {
    await progressChain.catch(() => undefined);
    if (progressMsg) {
      await progressMsg.delete().catch(() => undefined);
      await bridge.sessionStore.clearProgressMsg(key).catch(() => undefined);
      progressMsg = undefined;
    }
  };

  try {
    await bridge.handleMessage(
      bot,
      key,
      text,
      {
        onReply: (reply, files) => postReply(replyChannel, reply, files),
        onProgress: (label) => pushProgress(label),
        onNotification: (notif, notifType) =>
          postChunked(replyChannel, `🔔 ${bot.displayName}: ${notif}${notifType ? ` [${notifType}]` : ''}`),
        onApproval: async (cmd, gateKey, reqId) => {
          // Owner-only gates (code execution) ping the owner so they come approve.
          const ownerOnly = await bridge.requiresOwnerApproval(gateKey, reqId);
          await postApprovalButtons(replyChannel, cmd, gateKey, reqId, ownerOnly ? process.env.OWNER_DISCORD_ID : undefined);
        },
      },
      attachments,
      { authorId: message.author.id },
    );
    if (botUserId) {
      void message.reactions.resolve('⏳')?.users.remove(botUserId).catch(() => undefined);
    }
    void message.react('✅').catch(() => undefined);
    // A typed /end inside a thread closes that thread. The bridge already reset the
    // session above; closing (archive+lock) stops Discord auto-unarchiving the same
    // thread on the next message, so the user gets a fresh thread instead.
    if (isEndCommand(text)) await closeThread(replyChannel, 'discord-butler: /end로 대화를 종료했어요');
  } catch (err) {
    void message.react('⚠️').catch(() => undefined);
    throw err;
  } finally {
    // Delete the progress status line (the answer/error stands on its own), draining any
    // pending edit first so the delete can't race a late edit.
    await finalizeProgress();
    clearInterval(typingTimer);
  }
}

/**
 * Closes a thread by archiving AND locking it. Archiving alone is a soft close — Discord
 * auto-unarchives on the next message, resurrecting the SAME thread (and its
 * conversationKey). Locking blocks that: a non-manager can't post in a locked thread, so
 * instead of reopening the old thread they get a fresh one from the parent channel
 * (thread reuse skips archived threads). This is deliberate — both /end ("start over,
 * don't carry the old record forward") and the idle reaper (session already reaped, old
 * thread is dead) want a new thread on the next message, not the stale one revived. Both
 * flags go in one atomic edit; best-effort, a failure just leaves the thread open. NOTE:
 * users with Manage Threads (e.g. the guild owner) can still post in a locked thread, so
 * this is a soft guard for regular members.
 */
export async function closeThread(channel: SendableChannels, reason: string): Promise<void> {
  if (!channel.isThread()) return;
  try {
    await channel.edit({ archived: true, locked: true, reason });
  } catch (err) {
    console.error('[handler] failed to close thread:', err);
  }
}
