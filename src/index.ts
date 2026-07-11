import type { SendableChannels } from 'discord.js';
import { ChannelType } from 'discord.js';
import { loadConfig } from './config.js';
import { createClient, initClient } from './discord/client.js';
import { closeThread, registerHandler } from './discord/handler.js';
import { findTextChannelByName, findTextChannelByNameAsync, postReply } from './discord/post.js';
import { Bridge } from './bridge.js';
import { startTriggerServer } from './http.js';
import { conversationKey } from './router.js';
import { startReaper } from './reaper.js';
import { TmuxManager } from './tmux/manager.js';
import { bots } from './bots/registry.js';
import type { SessionEntry } from './persistence/session-map.js';

/**
 * Entry point: wire config → Discord client → handler → bridge, then log in.
 * Sets up graceful shutdown that tears down the tmux session.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[butler] data dir: ${config.dataDir}`);
  console.log(`[butler] claude bin: ${config.claudeBin}, tmux bin: ${config.tmuxBin}`);
  console.log(`[butler] default agent: ${config.defaultAgent}`);

  const bridge = new Bridge(config);
  const client = createClient();
  initClient(client, bridge.sessionStore);
  registerHandler(client, bridge);

  // Graceful shutdown: disconnect from Discord but LEAVE the tmux "butler" session
  // (and its claude windows) ALIVE, so in-progress conversations survive a bridge
  // restart/redeploy. The session is reused by conversation key on the next message;
  // claude's own context persists in each window.
  // localhost HTTP 트리거 서버: 외부 cron이 POST /trigger/<botId>로 봇을 깨운다.
  // 답은 봇의 채널(예: #날씨)에 게시(멘션 없음). 트리거 콜백은 cron 시점(로그인·
  // 길드 캐시 이후) 실행되므로 findTextChannelByName가 채널을 찾을 수 있다.
  const triggerServer = startTriggerServer(config, {
    trigger: async (bot, prompt) => {
      const key = conversationKey(bot, 'trigger'); // personal bot → key === bot.id
      // Async: fetch channels on a cache miss so a trigger right after restart still posts
      // into a low-traffic channel (e.g. #금융).
      let channel = await findTextChannelByNameAsync(client, bot.channelName);
      // triggerInThread: post the briefing into a fresh thread (e.g. weekly finance brief)
      // so the channel stays tidy. Best-effort — on failure fall back to the channel.
      if (channel && bot.triggerInThread && channel.type === ChannelType.GuildText) {
        const kstDate = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
        const thread = await channel.threads
          .create({
            name: `📊 ${bot.displayName} — ${kstDate}`,
            autoArchiveDuration: 1440,
            type: ChannelType.PublicThread,
          })
          .catch((err) => {
            console.warn(`[trigger] thread create failed #${bot.channelName}:`, err);
            return undefined;
          });
        if (thread) channel = thread;
      }
      await bridge.handleMessage(
        bot,
        key,
        prompt,
        {
          onReply: (text, files) => {
            if (channel) return postReply(channel, text, files);
            console.warn(`[trigger] no cached channel #${bot.channelName} to post into.`);
          },
          onNotification: (m, t) =>
            console.log(`[trigger] ${bot.displayName} notif: ${m}${t ? ` [${t}]` : ''}`),
        },
        [],
      );
    },
  });

  // Idle reaper: every 30 min, kill any conversation window idle ≥ 5h, post a
  // heads-up in its channel/thread, and drop its session entry — so an abandoned
  // (or wedged) window can't linger silently. Cutoff/interval overridable via env.
  const reaperStop = startReaper({
    sessions: bridge.sessionStore,
    tmux: new TmuxManager(config.tmuxBin),
    maxIdleMs: Number(process.env.BUTLER_REAP_IDLE_MS) || undefined,
    intervalMs: Number(process.env.BUTLER_REAP_INTERVAL_MS) || undefined,
    notify: async (key: string, entry: SessionEntry): Promise<void> => {
      // Resolve where this conversation lives: an explicit thread (shared bots), a
      // thread id embedded in the key (threadPerMessage), or the bot's channel.
      const botId = key.split('__')[0] ?? key;
      const bot = bots.find((b) => b.id === botId);
      const threadId = entry.threadId ?? key.match(/__thread_(\d+)/)?.[1];
      let channel: SendableChannels | undefined;
      if (threadId) {
        const ch = await client.channels.fetch(threadId).catch(() => null);
        if (ch && ch.isTextBased() && 'send' in ch) channel = ch as SendableChannels;
      }
      if (!channel && bot) channel = findTextChannelByName(client, bot.channelName);
      if (!channel) return;
      await channel
        .send({ content: '🧹 이 대화가 5시간 넘게 멈춰 있어 세션을 정리했어요. 다음 메시지부터 새 대화로 시작합니다.' })
        .catch((err) => console.warn(`[reaper] notify failed (${key}):`, err));
      // Session already reaped — close the (now-dead) thread like /end so the next
      // message opens a fresh thread instead of reviving this one via auto-unarchive.
      await closeThread(channel, 'discord-butler: 5시간 유휴로 세션을 정리했어요');
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[butler] received ${signal}, shutting down (claude 창은 유지)…`);
    try {
      reaperStop();
      triggerServer?.close();
      await client.destroy();
    } catch (err) {
      console.error('[butler] error destroying Discord client:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await client.login(config.discordToken);
}

main().catch((err) => {
  console.error('[butler] fatal startup error:', err);
  process.exit(1);
});
