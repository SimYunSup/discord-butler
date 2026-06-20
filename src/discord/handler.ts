import {
  ChannelType,
  Events,
  MessageFlags,
  type Channel,
  type Client,
  type GuildMember,
  type Message,
  type PrivateThreadChannel,
  type SendableChannels,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import type { Bot } from '../bots/types.js';
import { conversationKey, findBotForChannel } from '../router.js';
import { postChunked, postReply, SELECT_CUSTOM_ID } from './post.js';

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
  // Select-menu clicks (the bot's choice UI) → feed the picked option back as a turn.
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isStringSelectMenu() || interaction.customId !== SELECT_CUSTOM_ID) return;
    void handleSelect(interaction, bridge).catch((err) => {
      console.error('[handler] error while handling select interaction:', err);
    });
  });
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
      },
      [],
    );
  } finally {
    clearInterval(typingTimer);
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

  try {
    await bridge.handleMessage(
      bot,
      key,
      text,
      {
        onReply: (reply, files) => postReply(replyChannel, reply, files),
        onNotification: (notif, notifType) =>
          postChunked(replyChannel, `🔔 ${bot.displayName}: ${notif}${notifType ? ` [${notifType}]` : ''}`),
      },
      attachments,
    );
    if (botUserId) {
      void message.reactions.resolve('⏳')?.users.remove(botUserId).catch(() => undefined);
    }
    void message.react('✅').catch(() => undefined);
  } catch (err) {
    void message.react('⚠️').catch(() => undefined);
    throw err;
  } finally {
    clearInterval(typingTimer);
  }
}
