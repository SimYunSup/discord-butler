#!/usr/bin/env node
// discord-butler: Claude Code hook emitter.
//
// Claude Code invokes this from a per-conversation `.claude/settings.json` hook,
// e.g.  node /abs/scripts/hook-emit.mjs /abs/data/events/<key>.jsonl Stop
//
// It reads the hook payload Claude Code passes on STDIN as a single JSON object
// and appends ONE normalized JSONL line to the target events file:
//
//   {"event":"Stop","ts":"2026-...Z","payload":{...original hook JSON...}}
//
// The butler bridge tails that file: a `Stop` line means the assistant finished
// a turn (its text is in payload.last_assistant_message); a `Notification` line
// means Claude Code wants attention (permission prompt / idle), described by
// payload.message + payload.notification_type.
//
// ── How Claude Code passes hook data (as of current docs) ──────────────────
// Claude Code writes a JSON object to the hook command's STDIN. Common fields:
//   session_id, transcript_path, cwd, hook_event_name, permission_mode
// Stop adds:        last_assistant_message (string), stop_hook_active (bool)
// Notification adds: message (string), title?, notification_type (string)
// It also sets env vars (e.g. CLAUDE_PROJECT_DIR). We primarily consume STDIN
// and accept argv as a fallback so the script is robust to invocation quirks.
//
// Design intent: tiny, dependency-free, never throws in a way that would break
// the hook (a failing hook can disrupt the claude session). On any error we
// still try to record something and exit 0.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read all of STDIN as a string. Resolves '' if stdin is empty/closed fast. */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // Safety: if nothing arrives shortly, proceed with what we have.
    setTimeout(() => resolve(data), 2000).unref?.();
  });
}

async function main() {
  // argv: [node, script, <eventsFilePath>, <eventName>]
  const eventsPath = process.argv[2];
  const eventName = process.argv[3] || 'Unknown';

  if (!eventsPath) {
    // Nothing we can do without a target; don't break the hook.
    process.stderr.write('[hook-emit] missing events file path argument\n');
    process.exit(0);
  }

  const stdin = await readStdin();
  let payload;
  if (stdin && stdin.trim()) {
    try {
      payload = JSON.parse(stdin);
    } catch {
      // Keep the raw text if it wasn't valid JSON, so nothing is lost.
      payload = { _raw: stdin };
    }
  } else {
    // Fallback: accept any extra argv beyond the two we expect as the payload,
    // and include relevant env vars so the line is still useful.
    payload = {
      _argv: process.argv.slice(4),
      _env: {
        CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
      },
    };
  }

  const line =
    JSON.stringify({
      event: eventName,
      ts: new Date().toISOString(),
      payload,
    }) + '\n';

  try {
    await mkdir(dirname(eventsPath), { recursive: true });
    await appendFile(eventsPath, line, 'utf8');
  } catch (err) {
    process.stderr.write(`[hook-emit] failed to append: ${err?.message ?? err}\n`);
  }

  // Always succeed so the hook never blocks the claude session.
  process.exit(0);
}

main();
