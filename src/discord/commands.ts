import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ChatInputApplicationCommandData,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import type { Bridge } from '../bridge.js';
import { noreplyEmail, removeGitHubSecret, saveGitHubSecret } from '../bots/github-token.js';

const execFileAsync = promisify(execFile);

/**
 * Guild-scoped (instantly-applied) token-onboarding commands. Responses are ALWAYS
 * ephemeral (only the caller sees them), so a token never lands in channel history.
 * The bot's invite MUST include the `applications.commands` scope, or slash commands
 * don't appear.
 */
export const GITHUB_TOKEN_COMMANDS: ChatInputApplicationCommandData[] = [
  {
    name: 'github-token',
    description: 'GitHub PAT를 등록해 본인 명의로 이슈/PR 작업을 합니다(응답은 본인만 보임).',
    options: [
      {
        name: 'token',
        description: 'classic PAT 권장 (repo scope; 조직 레포면 그 토큰을 조직용 SSO 인가)',
        type: ApplicationCommandOptionType.String,
        required: true,
      },
      {
        name: 'email',
        description: '커밋에 쓸 공개 이메일(기본: GitHub noreply)',
        type: ApplicationCommandOptionType.String,
        required: false,
      },
    ],
  },
  { name: 'github-token-remove', description: '등록한 GitHub 토큰을 삭제합니다.' },
];

/**
 * Per-channel session commands (need channel→bot routing, handled in the interaction
 * dispatcher, not here). `/설명` shows the channel's bot detail card, ephemeral.
 */
export const SESSION_COMMANDS: ChatInputApplicationCommandData[] = [
  { name: '설명', description: '이 비서의 모델·격상 트리거 등 상세 설정을 나만 보이게 알려줘요.' },
  { name: 'interrupt', description: '진행 중인 작업을 즉시 멈춰요(대화 맥락은 유지).' },
];

/** gh api user(JSON) → identity. name falls back to login. Returns undefined on parse/field failure. */
export function parseUserApiJson(
  stdout: string,
): { id: number; login: string; name: string } | undefined {
  try {
    const j = JSON.parse(stdout) as { id?: number; login?: string; name?: string | null };
    if (typeof j.id !== 'number' || typeof j.login !== 'string') return undefined;
    return { id: j.id, login: j.login, name: j.name?.trim() || j.login };
  } catch {
    return undefined;
  }
}

/**
 * Validates a PAT via `GH_TOKEN=<t> gh api user`. Returns the identity on success,
 * `{error}` on failure. The execFile impl is injectable (`run`) so unit tests can
 * verify it without a real `gh`.
 */
export async function validateToken(
  token: string,
  run: typeof execFileAsync = execFileAsync,
): Promise<{ id: number; login: string; name: string } | { error: string }> {
  try {
    const { stdout } = await run('gh', ['api', 'user'], {
      env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
      timeout: 15_000,
    });
    const id = parseUserApiJson(stdout);
    return id ?? { error: 'gh api user 응답을 해석하지 못했어요.' };
  } catch (err) {
    return { error: `토큰 검증 실패: ${(err as Error)?.message ?? err}` };
  }
}

/** Guild-scoped registration (applied instantly). Needs the applications.commands invite scope. */
export async function registerGuildCommands(guild: Guild): Promise<void> {
  await guild.commands.set([...GITHUB_TOKEN_COMMANDS, ...SESSION_COMMANDS]);
}

/** Handles /github-token · /github-token-remove (always ephemeral). NEVER echoes the token. */
export async function handleChatInputCommand(
  interaction: ChatInputCommandInteraction,
  bridge: Bridge,
): Promise<void> {
  if (interaction.commandName === 'github-token-remove') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const removed = await removeGitHubSecret(bridge.dataDir, interaction.user.id);
    await interaction.editReply(removed ? '🗑️ 토큰을 삭제했어요.' : '등록된 토큰이 없어요.');
    return;
  }
  if (interaction.commandName !== 'github-token') return;

  // The gh api call may exceed Discord's 3s window → defer (ephemeral) first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const token = interaction.options.getString('token', true).trim();
  const emailOverride = interaction.options.getString('email')?.trim();

  const id = await validateToken(token);
  if ('error' in id) {
    await interaction.editReply(
      `❌ ${id.error}\n유효한 PAT인지, gh 권한(repo/pull_requests)을 확인해 주세요.`,
    );
    return;
  }
  const email = emailOverride || noreplyEmail(id.id, id.login);
  await saveGitHubSecret(bridge.dataDir, interaction.user.id, {
    login: id.login,
    id: id.id,
    name: id.name,
    email,
    token,
    addedAt: new Date().toISOString(),
  });
  // Confirm with the identity only — the token is NEVER printed.
  await interaction.editReply(
    `✅ **${id.login}** 계정으로 등록했어요. 커밋 이메일: \`${email}\`\n` +
      '이제 #github-이슈해결 / #github-이슈만들기 / #github-코드리뷰 에서 본인 명의로 작업해요. (삭제: /github-token-remove)',
  );
}
