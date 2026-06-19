import type { Bot } from './bots/types.js';
import { bots } from './bots/registry.js';

/**
 * Maps a Discord channel to the bot that owns it.
 *
 * For personal bots we match on the channel name (the bot owns exactly one named
 * channel under the personal category). Shared bots create per-user private
 * threads under their channel; we match the thread's parent channel name.
 *
 * @param channelName the message channel's name, or — for a thread — its parent's name.
 * @returns the owning bot, or undefined if no bot owns this channel.
 */
export function findBotForChannel(channelName: string | null | undefined): Bot | undefined {
  if (!channelName) return undefined;
  return bots.find((b) => b.channelName === channelName);
}

/**
 * Computes the conversation key — the identity of one tmux window / working dir.
 *
 * - threadPerMessage bot (with threadId) → `botId__thread_<threadId>` (one
 *   isolated window per question-thread).
 * - Personal bot  → `botId`            (one window for me).
 * - Shared bot    → `botId__userId`    (one isolated window per user).
 *
 * The key is also used as the tmux window name and the working-dir folder name,
 * so it is constrained to a filesystem/tmux-safe charset.
 *
 * Invariant: the key is ALWAYS derived from the message AUTHOR (userId / shared
 * gate); a threadId only FURTHER-scopes a threadPerMessage bot, it never replaces
 * author derivation, so a user can never be routed into another user's window.
 */
export function conversationKey(bot: Bot, userId: string, threadId?: string): string {
  if (bot.threadPerMessage && threadId) return `${bot.id}__thread_${threadId}`;
  return bot.shared ? `${bot.id}__${userId}` : bot.id;
}

/**
 * Sanitizes a conversation key for safe use as a tmux window name and directory
 * name. tmux treats `.`, `:` specially in target syntax; we also strip anything
 * outside a conservative charset.
 */
export function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}
