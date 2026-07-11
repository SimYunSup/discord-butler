import type { Bot } from '../bots/types.js';

/**
 * Builds the Discord channel topic for a bot: its hand-written `usage` text plus a
 * UNIFORM model/effort tag appended to EVERY channel, so a user can see at a glance which
 * model & effort the channel runs (and where to get the full detail). The tag shows the
 * bot's BASE tier (escalation triggers bump above it — see `/설명`); `기본` stands in for
 * an unset model/effort (the CLI default). Pure & deterministic (client.ts applies it).
 */
export function buildChannelTopic(bot: Bot): string {
  const tag = `🧠 ${bot.model ?? '기본'} · effort ${bot.effort ?? '기본'} · 상세 /설명`;
  const usage = (bot.usage ?? '').trim();
  return usage ? `${usage}\n\n${tag}` : tag;
}
