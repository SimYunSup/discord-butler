import { loadConfig } from './config.js';
import { createClient, initClient } from './discord/client.js';
import { registerHandler } from './discord/handler.js';
import { findTextChannelByName, postReply } from './discord/post.js';
import { Bridge } from './bridge.js';
import { startTriggerServer } from './http.js';
import { conversationKey } from './router.js';

/**
 * Entry point: wire config → Discord client → handler → bridge, then log in.
 * Sets up graceful shutdown that tears down the tmux session.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[butler] data dir: ${config.dataDir}`);
  console.log(`[butler] claude bin: ${config.claudeBin}, tmux bin: ${config.tmuxBin}`);

  const bridge = new Bridge(config);
  const client = createClient();
  initClient(client);
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
      const channel = findTextChannelByName(client, bot.channelName);
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

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[butler] received ${signal}, shutting down (claude 창은 유지)…`);
    try {
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
