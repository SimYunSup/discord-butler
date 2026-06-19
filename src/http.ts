import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ButlerConfig } from './config.js';
import type { Bot } from './bots/types.js';
import { bots } from './bots/registry.js';

/** Dependencies the trigger server needs to run a bot and post its reply. */
export interface TriggerDeps {
  /** Run `bot` with `prompt` and post the reply to the bot's channel. */
  trigger: (bot: Bot, prompt: string) => Promise<void>;
}

/** Reads the request body and parses it as JSON ({} on empty/invalid). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/**
 * Builds the request listener for the trigger webhook (exposed for testing).
 *
 * Routes:
 *  - GET  /healthz          → 200 ok
 *  - POST /trigger/<botId>  → 202 (auth + opt-in checks), runs deps.trigger async
 */
export function createTriggerListener(config: ButlerConfig, deps: TriggerDeps) {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, 'ok');
      return;
    }
    const m = url.pathname.match(/^\/trigger\/([A-Za-z0-9_-]+)$/);
    if (req.method !== 'POST' || !m) {
      send(res, 404, 'not found');
      return;
    }
    if (req.headers['x-butler-token'] !== config.triggerToken) {
      send(res, 401, 'unauthorized');
      return;
    }
    const botId = m[1];
    const bot = bots.find((b) => b.id === botId);
    // Trigger is opt-in (bot must define triggerPrompt) and personal-only.
    if (!bot || !bot.triggerPrompt) {
      send(res, 404, 'no such triggerable bot');
      return;
    }
    if (bot.shared) {
      send(res, 400, 'shared bots cannot be triggered');
      return;
    }
    const body = await readJsonBody(req);
    const prompt =
      typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : bot.triggerPrompt;
    // Respond immediately; the bot run + post happens async.
    send(res, 202, 'accepted');
    void deps.trigger(bot, prompt).catch((err) => console.error(`[http] trigger ${botId} failed:`, err));
  }

  return (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((err) => {
      console.error('[http] trigger handler error:', err);
      if (!res.headersSent) send(res, 500, 'error');
    });
  };
}

/**
 * Starts the localhost trigger server, or returns undefined if no triggerToken
 * is configured (server disabled). Binds 127.0.0.1 only.
 */
export function startTriggerServer(config: ButlerConfig, deps: TriggerDeps): Server | undefined {
  if (!config.triggerToken) {
    console.log('[http] trigger server disabled (BUTLER_TRIGGER_TOKEN not set).');
    return undefined;
  }
  const server = createServer(createTriggerListener(config, deps));
  server.listen(config.httpPort, '127.0.0.1', () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.httpPort;
    console.log(`[http] trigger server on 127.0.0.1:${port}`);
  });
  return server;
}
