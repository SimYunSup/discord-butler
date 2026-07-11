import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type CategoryChannel,
  type Guild,
  type TextChannel,
} from 'discord.js';
import {
  bots,
  OWNER_CATEGORY_NAME,
  PERSONAL_CATEGORY_NAME,
  SHARED_CATEGORY_NAME,
} from '../bots/registry.js';
import type { Bot } from '../bots/types.js';
import type { SessionMapStore } from '../persistence/session-map.js';
import { registerGuildCommands } from './commands.js';
import { buildChannelTopic } from './channel-topic.js';

/**
 * Creates the discord.js Client with the intents the butler needs:
 * - Guilds:        receive guild/channel state.
 * - GuildMessages: receive messageCreate events.
 * - MessageContent: read message text (privileged — must be enabled in the
 *   Developer Portal under Bot → Privileged Gateway Intents).
 */
export function createClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    // The default REST request timeout is 15s — too short for file uploads
    // (butler-file attachments) over a slow upstream, which abort with
    // "DOMException [AbortError]". Give uploads room + extra retries.
    rest: { timeout: 60_000, retries: 5 },
  });
}

/** Finds an existing category by name, or creates it. */
async function ensureCategory(guild: Guild, name: string, reason: string): Promise<CategoryChannel> {
  const existing = guild.channels.cache.find(
    (c): c is CategoryChannel => c.type === ChannelType.GuildCategory && c.name === name,
  );
  if (existing) return existing;
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason,
  });
  console.log(`[discord] created category "${name}" in guild ${guild.name}`);
  return created;
}

/** Category a bot's channel belongs under: explicit override → owner-only → shared → personal. */
function categoryNameForBot(bot: Bot): string {
  if (bot.category) return bot.category;
  if (bot.ownerOnly) return OWNER_CATEGORY_NAME;
  if (bot.shared) return SHARED_CATEGORY_NAME;
  return PERSONAL_CATEGORY_NAME;
}

/**
 * Ensures one GuildText channel per bot exists under `category`. For an existing
 * channel, reparents it to `category` (so re-categorized bots move) and syncs the
 * topic to the usage guide. Missing channels are created.
 */
async function ensureBotChannels(
  guild: Guild,
  category: CategoryChannel,
  catBots: Bot[],
): Promise<void> {
  for (const bot of catBots) {
    const existing = guild.channels.cache.find(
      (c): c is TextChannel => c.type === ChannelType.GuildText && c.name === bot.channelName,
    );
    if (existing) {
      if (existing.parentId !== category.id) {
        await existing.setParent(category.id, { lockPermissions: false }).catch((err) => {
          console.error(`[discord] failed to reparent #${bot.channelName}:`, err);
        });
        console.log(`[discord] moved #${bot.channelName} → "${category.name}"`);
      }
      const topic = buildChannelTopic(bot);
      if (existing.topic !== topic) {
        await existing.setTopic(topic).catch((err) => {
          console.error(`[discord] failed to set topic on #${bot.channelName}:`, err);
        });
      }
      continue;
    }
    await guild.channels.create({
      name: bot.channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: buildChannelTopic(bot),
      reason: `discord-butler: channel for bot ${bot.id}`,
    });
    console.log(`[discord] created channel "#${bot.channelName}" for bot ${bot.id}`);
  }
}

/**
 * Ensures categories + a text channel per bot in a guild. Bots are grouped into
 * three categories: 「개인 비서단」(personal), 「공용 상담·서류」(shared, per-user
 * private threads), 「소유자 전용」(owner-only). A category is created only if it
 * has at least one bot. Idempotent; logs what it creates/moves.
 */
async function ensureChannels(guild: Guild): Promise<void> {
  const byCategory = new Map<string, Bot[]>();
  for (const bot of bots) {
    const cat = categoryNameForBot(bot);
    const list = byCategory.get(cat);
    if (list) list.push(bot);
    else byCategory.set(cat, [bot]);
  }
  for (const [catName, catBots] of byCategory) {
    const category = await ensureCategory(guild, catName, `discord-butler: ${catName}`);
    await ensureBotChannels(guild, category, catBots);
  }
}

/**
 * Deletes progress status messages left orphaned by a bridge stop/crash mid-turn. Each live
 * turn persists its "⏳ 지금: …" message location to session-map (see the handler); on a clean
 * finish the handler deletes it and clears the pointer, but a crash/restart skips that — so on
 * the next boot every entry that still carries a `progressMsg` points at a stranded line. We
 * fetch each and delete it (the bot's own message → no special perms), then clear the pointer.
 * Best-effort: a missing channel/message just clears the (now-dead) pointer.
 */
async function sweepStaleProgress(client: Client, store: SessionMapStore): Promise<void> {
  let map: Awaited<ReturnType<SessionMapStore['read']>>;
  try {
    map = await store.read();
  } catch {
    return;
  }
  const stale = Object.entries(map).filter(([, e]) => e.progressMsg);
  if (!stale.length) return;
  let deleted = 0;
  for (const [key, entry] of stale) {
    const pm = entry.progressMsg!;
    const channel = await client.channels.fetch(pm.channelId).catch(() => null);
    if (channel && channel.isTextBased() && 'messages' in channel) {
      const ok = await channel.messages
        .delete(pm.messageId)
        .then(() => true)
        .catch(() => false);
      if (ok) deleted++;
    }
    await store.clearProgressMsg(key).catch(() => undefined);
  }
  if (deleted) console.log(`[discord] swept ${deleted} orphaned progress message(s) from a prior run`);
}

/**
 * Wires up the client: on ready, ensures categories/channels across all guilds.
 * The caller attaches the message handler and logs in. `sessionStore`, when given, triggers
 * a one-time sweep of progress status messages orphaned by a prior crash/restart.
 */
export function initClient(client: Client, sessionStore?: SessionMapStore): void {
  client.once(Events.ClientReady, async (ready) => {
    console.log(`[discord] logged in as ${ready.user.tag}`);
    if (sessionStore) {
      await sweepStaleProgress(ready, sessionStore).catch((err) =>
        console.error('[discord] stale-progress sweep failed:', err),
      );
    }
    // The guild cache can be empty at ready (guilds still syncing); fetch to be
    // sure, then fetch each full Guild so channel scanning sees everything.
    let guilds = [...ready.guilds.cache.values()];
    if (guilds.length === 0) {
      try {
        const partials = await ready.guilds.fetch();
        guilds = await Promise.all([...partials.values()].map((g) => g.fetch()));
      } catch (err) {
        console.error('[discord] failed to fetch guilds at ready:', err);
      }
    }
    console.log(`[discord] ensuring channels across ${guilds.length} guild(s)`);
    for (const guild of guilds) {
      try {
        await guild.channels.fetch();
        await ensureChannels(guild);
      } catch (err) {
        console.error(`[discord] failed to ensure channels in guild ${guild.id}:`, err);
      }
      // Slash commands (/github-token …) — guild-scoped so they appear instantly.
      // Independent of channel setup so one failing doesn't block the other. Requires
      // the bot invite to include the `applications.commands` OAuth scope.
      try {
        await registerGuildCommands(guild);
      } catch (err) {
        console.error(`[discord] failed to register slash commands in ${guild.id}:`, err);
      }
    }
  });
}
