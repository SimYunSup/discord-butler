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
      if (bot.usage && existing.topic !== bot.usage) {
        await existing.setTopic(bot.usage).catch((err) => {
          console.error(`[discord] failed to set topic on #${bot.channelName}:`, err);
        });
      }
      continue;
    }
    await guild.channels.create({
      name: bot.channelName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: bot.usage,
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
 * Wires up the client: on ready, ensures categories/channels across all guilds.
 * The caller attaches the message handler and logs in.
 */
export function initClient(client: Client): void {
  client.once(Events.ClientReady, async (ready) => {
    console.log(`[discord] logged in as ${ready.user.tag}`);
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
    }
  });
}
