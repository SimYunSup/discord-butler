# Self-hosting discord-butler on a mini PC / 미니PC에 discord-butler 자가호스팅하기

This guide takes you from **buying a mini PC** all the way to a butler that runs
24/7 and restarts itself on reboot. discord-butler is light: it has **no database**
(state is Markdown files) and drives one `claude` (Claude Code CLI) instance per
conversation inside `tmux`.

이 문서는 **미니PC 구매**부터 24시간 돌아가고 재부팅 후에도 자동 복구되는 비서까지를 다룹니다.
discord-butler는 가볍습니다 — **DB가 없고**(상태는 Markdown 파일), 대화마다 `tmux` 안에서
`claude`(Claude Code CLI) 인스턴스 하나를 띄워 답합니다.

> Throughout, replace `<...>` placeholders with your own values. Lines starting
> with `#` in shell blocks are comments.
> 본문의 `<...>`는 본인 값으로 바꾸세요. 셸 블록의 `#` 줄은 주석입니다.

---

## 0. Quick start — one command / 원커맨드 빠른 설치

**EN.** Once you're on a Linux box or a Mac mini with an OS installed, the whole
software side (prerequisites → clone → install → build → 24/7 service) is one
command. It installs Node 20 + pnpm + tmux + git + the `claude` CLI, sets up the
repo, writes `.env`, and registers a systemd (Linux) / launchd (macOS) service:

```bash
# interactive — keeps a TTY so it can prompt for your Discord token
bash <(curl -fsSL https://raw.githubusercontent.com/SimYunSup/discord-butler/main/scripts/install.sh)

# or fully unattended — pass the secrets up front
DISCORD_TOKEN=xxx ANTHROPIC_API_KEY=sk-... \
  bash <(curl -fsSL https://raw.githubusercontent.com/SimYunSup/discord-butler/main/scripts/install.sh)
```

**Two steps can't be automated** (they're inherently human), so a *zero-input*
one-command install isn't possible:

1. **Create the Discord app + token** in the Developer Portal and enable Message
   Content Intent / invite the bot (§5) — you paste the token into the prompt.
2. **Log in to `claude` once** (interactive OAuth, §4) — *unless* you pass
   `ANTHROPIC_API_KEY`, which skips the login entirely.

Steps 1–10 below are the same process done by hand, with the hardware/OS context.
Use them if you want to understand or customize what the script does.

**KO.** Linux 박스나 OS가 깔린 Mac mini만 준비되면, 소프트웨어 쪽(필수구성요소 → 클론 →
설치 → 빌드 → 상시구동 서비스)은 **명령 한 줄**입니다. Node 20·pnpm·tmux·git·`claude` CLI를
설치하고, 레포를 받고, `.env`를 만들고, systemd(Linux)/launchd(macOS) 서비스까지 등록합니다.
다만 **두 단계는 사람만 가능**해서 완전 무입력 원커맨드는 불가능합니다 — (1) Discord 포털에서
앱·토큰 생성 + Message Content Intent/초대(§5, 토큰은 프롬프트에 붙여넣기), (2) `claude` 최초
로그인(§4, `ANTHROPIC_API_KEY`를 넘기면 생략 가능). 아래 1~10단계는 같은 과정을 손으로 하는
버전이며, 동작을 이해·커스터마이즈하려면 참고하세요.

> The script is idempotent — re-running reuses an existing repo/`.env`/service.
> 스크립트는 멱등 — 재실행해도 기존 레포/`.env`/서비스를 덮어쓰지 않고 재사용합니다.

---

## 1. Buy the mini PC — RAM & SSD / 미니PC 구매 — 램·SSD

**EN.** This workload is **memory- and I/O-bound, not CPU-bound** — it mostly waits
on the Discord gateway and the Anthropic API. Each active conversation is a separate
Node/`claude` process, so RAM is what limits how many people can chat at once.

- **CPU:** any modern x86-64 is plenty. Low-power **Intel N100 / N150 / N305** mini
  PCs (~6–15 W, always-on friendly) are ideal. A Ryzen mini PC or an Apple-silicon
  **Mac mini** also works great (`claude` and `tmux` run on Linux x64/arm64 and macOS).
- **RAM: 16 GB recommended.** 8 GB works for light, single-user use but is tight once
  two or three conversations run at once. Pick 32 GB if you expect many concurrent users.
- **SSD: 512 GB NVMe recommended** (256 GB minimum). It holds the OS, Node, the
  `node_modules`, per-conversation workspaces, and the `claude` cache. Prefer **NVMe**
  over SATA for faster installs/updates.
- **Networking:** wired Ethernet is best for an always-on box. It only needs
  **outbound** internet (Discord + Anthropic); no inbound ports must be opened.

Example form factors (no affiliation): Beelink / Minisforum / GMKtec N100 boxes,
Intel NUC, or a Mac mini.

**KO.** 이 작업은 **CPU보다 메모리·I/O가 병목**입니다 — 대부분 Discord 게이트웨이와
Anthropic API 응답을 기다립니다. 활성 대화마다 별도 Node/`claude` 프로세스가 뜨므로,
동시에 몇 명이 대화할 수 있는지는 **램**이 좌우합니다.

- **CPU:** 요즘 x86-64면 충분. 저전력 **Intel N100 / N150 / N305** 미니PC(~6–15W, 상시구동에
  적합)가 이상적. Ryzen 미니PC나 애플 실리콘 **Mac mini**도 좋음(`claude`·`tmux`는 Linux
  x64/arm64·macOS 모두 지원).
- **램: 16GB 권장.** 8GB는 1인·가벼운 용도엔 되지만 동시 2~3개 대화면 빠듯. 동시 사용자가
  많으면 32GB.
- **SSD: 512GB NVMe 권장**(최소 256GB). OS·Node·`node_modules`·대화별 워크스페이스·`claude`
  캐시가 들어감. 설치/업데이트 속도를 위해 SATA보다 **NVMe**.
- **네트워크:** 상시구동엔 유선 이더넷이 안정적. **아웃바운드** 인터넷만 필요(Discord·Anthropic),
  인바운드 포트 개방 불필요.

예시 기기(무관): Beelink / Minisforum / GMKtec N100, Intel NUC, Mac mini.

---

## 2. Install the OS / OS 설치

**EN.** The primary path here is **Ubuntu Server LTS** (24.04+) — stable, headless,
well-documented. A desktop Ubuntu or a Mac mini (macOS) works too; the only extra
need is a way to authenticate `claude` once (Step 4).

1. Flash Ubuntu Server LTS to a USB stick (e.g. with Raspberry Pi Imager or balenaEtcher).
2. Boot the mini PC from USB, install, create your user, and enable **OpenSSH** so you
   can manage it from your laptop.
3. After first boot: `sudo apt update && sudo apt -y upgrade`.

**KO.** 기본 경로는 **Ubuntu Server LTS**(24.04+) — 안정적이고 헤드리스이며 자료가 많습니다.
데스크톱 Ubuntu나 Mac mini(macOS)도 가능하며, 추가로 필요한 건 `claude`를 한 번 인증할
방법(4단계)뿐입니다.

1. USB에 Ubuntu Server LTS를 굽습니다(Raspberry Pi Imager/balenaEtcher 등).
2. USB로 부팅 → 설치 → 사용자 생성 → 노트북에서 관리할 수 있게 **OpenSSH** 활성화.
3. 첫 부팅 후: `sudo apt update && sudo apt -y upgrade`.

---

## 3. Install prerequisites / 필수 구성요소 설치

Node ≥ 20, pnpm, tmux, git, and the `claude` CLI.

```bash
# tmux + git (Ubuntu/Debian) — macOS: use `brew install tmux git`
sudo apt -y install tmux git curl

# Node ≥ 20 via fnm (no sudo; per-user). Then reload your shell.
curl -fsSL https://fnm.vercel.app/install | bash
exec "$SHELL"
fnm install 20 && fnm use 20 && fnm default 20

# pnpm via corepack (ships with Node)
corepack enable && corepack prepare pnpm@latest --activate

# Claude Code CLI (see https://docs.claude.com/claude-code for the latest method)
npm install -g @anthropic-ai/claude-code

# sanity check
node -v && pnpm -v && tmux -V && claude --version
```

---

## 4. Get an LLM plan, then authenticate `claude` (once) / LLM 구독·키 준비 후 `claude` 인증 (1회)

**EN — pick how you'll pay for the model first.** The default `claude` backend needs
an Anthropic login of some kind. If you're starting from zero, choose one:

- **Claude subscription (Pro/Max)** — sign up at [claude.ai](https://claude.ai), then
  log in via the CLI (below). Simplest for personal/always-on use; flat monthly cost.
  Pricing: [anthropic.com/pricing](https://www.anthropic.com/pricing).
- **Anthropic API key (pay-as-you-go)** — create a key at
  [console.anthropic.com](https://console.anthropic.com) → API Keys, add billing, and
  set `ANTHROPIC_API_KEY` instead of logging in. Best if you'd rather pay per token.
  Pricing: [anthropic.com/pricing](https://www.anthropic.com/pricing).
- **No Anthropic account at all?** Use a different backend instead of `claude` — both
  run the same Claude Code CLI against an Anthropic-compatible endpoint (see *Agent
  backends* in the [README](../README.md)):
  - `BUTLER_AGENT=glm` with a **Z.ai** key (`GLM_AUTH_TOKEN`) — the GLM Coding Plan
    starts at ~$3/mo: [z.ai/subscribe](https://z.ai/subscribe).
  - `BUTLER_AGENT=kimi` with a **Moonshot** key (`KIMI_AUTH_TOKEN`) — pay-as-you-go:
    [Moonshot pricing](https://platform.moonshot.ai/).
  - (A `codex` backend also exists but is experimental and needs a paid
    [Codex/ChatGPT plan](https://openai.com/chatgpt/pricing/).)

Then make the chosen credential available to the bridge. The bridge launches `claude`
non-interactively, so it must already be logged in (or have an API key in its env):

```bash
claude            # follow the login prompt, then /exit
# Alternatively, use an API key instead of interactive login:
# export ANTHROPIC_API_KEY=<your-key>   # put in ~/.bashrc to persist
```

On a headless server the login flow prints a URL — open it on any device, approve,
and paste the code back. Auth is stored on disk, so it survives reboots.

**KO — 먼저 모델 비용을 어떻게 낼지 정하세요.** 기본 `claude` 백엔드는 Anthropic 인증이
필요합니다. 처음 시작한다면 셋 중 하나:

- **Claude 구독(Pro/Max)** — [claude.ai](https://claude.ai)에서 가입 후 아래 CLI로 로그인.
  개인·상시구동에 가장 간단(월 정액). 가격: [anthropic.com/pricing](https://www.anthropic.com/pricing).
- **Anthropic API 키(종량제)** — [console.anthropic.com](https://console.anthropic.com) →
  API Keys에서 키 발급 + 결제 등록 후, 로그인 대신 `ANTHROPIC_API_KEY` 설정. 토큰 단위
  과금을 원하면 이쪽. 가격: [anthropic.com/pricing](https://www.anthropic.com/pricing).
- **Anthropic 계정이 아예 없다면?** `claude` 대신 다른 백엔드 사용 — 둘 다 같은 Claude Code
  CLI를 Anthropic 호환 엔드포인트로 돌립니다([README](../README.md)의 *Agent backends* 참고):
  - `BUTLER_AGENT=glm` + **Z.ai** 키(`GLM_AUTH_TOKEN`) — GLM Coding Plan 월 ~$3부터:
    [z.ai/subscribe](https://z.ai/subscribe).
  - `BUTLER_AGENT=kimi` + **Moonshot** 키(`KIMI_AUTH_TOKEN`) — 종량제:
    [Moonshot 가격](https://platform.moonshot.ai/).
  - (`codex` 백엔드도 있으나 실험적이며 유료 [Codex/ChatGPT 플랜](https://openai.com/chatgpt/pricing/) 필요.)

그다음 고른 자격증명을 브리지가 쓰게 하세요. 브리지는 `claude`를 비대화형으로 띄우므로
**미리 로그인**돼 있어야 합니다(또는 env에 API 키):

```bash
claude            # 로그인 안내를 따르고 /exit
# 또는 대화형 로그인 대신 API 키 사용:
# export ANTHROPIC_API_KEY=<your-key>   # 영구 적용하려면 ~/.bashrc 에 추가
```

헤드리스 서버면 로그인 과정에서 URL이 출력됩니다 — 아무 기기에서 열어 승인하고 코드를
붙여넣으세요. 인증은 디스크에 저장되어 재부팅 후에도 유지됩니다.

---

## 5. Create the Discord app / Discord 앱 만들기

**EN.**
1. [Discord Developer Portal](https://discord.com/developers/applications) → **New
   Application** → **Bot** → **Reset Token**, copy it (this is `DISCORD_TOKEN`).
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**.
3. **OAuth2 → URL Generator**: scope `bot`, permission **Manage Channels** (so it can
   create its category/channels on first run). Open the generated URL and invite the
   bot to your server.
4. (Optional) To use `ownerOnly` bots, get your own Discord user id (enable Developer
   Mode → right-click your name → Copy User ID) for `OWNER_DISCORD_ID`.

**KO.**
1. [Discord Developer Portal](https://discord.com/developers/applications) → **New
   Application** → **Bot** → **Reset Token**, 복사(이게 `DISCORD_TOKEN`).
2. **Bot → Privileged Gateway Intents** 에서 **Message Content Intent** 켜기.
3. **OAuth2 → URL Generator**: 스코프 `bot`, 권한 **Manage Channels**(첫 실행 때 카테고리·채널
   생성용). 생성된 URL로 봇을 서버에 초대.
4. (선택) `ownerOnly` 봇을 쓰려면 본인 Discord 사용자 id(개발자 모드 → 이름 우클릭 → Copy
   User ID)를 `OWNER_DISCORD_ID` 에 넣기.

---

## 6. Get the code & configure / 코드 받기 & 설정

```bash
git clone <repository-url>      # the HTTPS URL shown on this repo's GitHub page
cd discord-butler
pnpm install
cp .env.example .env
```

Edit `.env` — at minimum set `DISCORD_TOKEN`. Other keys are optional (see comments in
the file). `.env` 를 열어 최소 `DISCORD_TOKEN` 을 채웁니다(나머지는 선택, 파일 주석 참고).

```bash
DISCORD_TOKEN=<your-bot-token>
# OWNER_DISCORD_ID=<your-discord-user-id>   # only if you use ownerOnly bots
# BUTLER_DATA_DIR=/home/<you>/discord-butler/data   # absolute path recommended
```

---

## 7. Build & first run / 빌드 & 첫 실행

```bash
pnpm typecheck && pnpm test     # optional sanity check / 선택 점검
pnpm build && pnpm start        # start the bridge / 브리지 시작
```

**EN.** On first run the bot creates its category and one channel per bot. Type a
message in a bot's channel (e.g. the travel or finance channel) and you should get a
reply within a few seconds. A long-lived `tmux` server must stay running — the bridge
creates/uses one automatically while it runs.

**KO.** 첫 실행 시 봇이 카테고리와 봇별 채널을 만듭니다. 봇 채널(예: 여행/금융)에 메시지를
보내면 몇 초 내 답이 옵니다. `tmux` 서버가 계속 떠 있어야 하는데, 브리지가 실행 중 자동으로
하나를 만들어 씁니다.

---

## 8. Run it 24/7 (systemd) / 상시 구동 (systemd)

**EN.** `pnpm start` stops when you log out. On Linux, run it as a **systemd user
service** so it survives logout and restarts on crash/reboot.

```bash
# build first so dist/ exists
pnpm build

mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/discord-butler.service <<'UNIT'
[Unit]
Description=discord-butler bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/discord-butler
ExecStart=/bin/bash -lc 'node dist/index.mjs'
Restart=always
RestartSec=3
# load .env into the process environment
EnvironmentFile=%h/discord-butler/.env

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now discord-butler
loginctl enable-linger "$USER"     # keep the user service running after logout/reboot

systemctl --user status discord-butler      # check it's active
journalctl --user -u discord-butler -f      # follow logs
```

> `ExecStart` uses `bash -lc` so your login shell loads `fnm`/`node` onto PATH. If you
> installed Node system-wide, you can point `ExecStart` at the absolute `node` path
> instead.

**KO.** `pnpm start` 는 로그아웃하면 멈춥니다. Linux에서는 **systemd 유저 서비스**로 등록해
로그아웃·크래시·재부팅에도 살아있게 합니다. (위 명령 그대로 사용)

- `loginctl enable-linger`: 로그아웃/재부팅 후에도 유저 서비스 유지.
- `ExecStart` 가 `bash -lc` 인 이유: 로그인 셸이 `fnm`/`node` 를 PATH에 올리도록. Node를 시스템
  전역 설치했다면 `node` 절대경로를 직접 지정해도 됩니다.

**macOS (Mac mini).** Use a `launchd` LaunchAgent (`~/Library/LaunchAgents/*.plist`,
`RunAtLoad` + `KeepAlive`) running `node dist/index.mjs` from the repo dir instead of
systemd. / macOS는 systemd 대신 `launchd` LaunchAgent로 동일하게 구성합니다.

---

## 9. Update & maintenance / 업데이트 & 유지보수

```bash
cd ~/discord-butler
git pull
pnpm install            # if dependencies changed / 의존성 바뀐 경우
pnpm build
systemctl --user restart discord-butler     # macOS: launchctl kickstart -k ...
```

State (conversations, profiles) lives under `BUTLER_DATA_DIR` (default `<repo>/data`)
and is **not** touched by updates. Back that directory up if it matters to you.

상태(대화·프로필)는 `BUTLER_DATA_DIR`(기본 `<repo>/data`)에 있고 업데이트가 **건드리지
않습니다**. 중요하면 이 디렉터리를 백업하세요.

---

## 10. Troubleshooting / 문제 해결

| Symptom / 증상 | Fix / 해결 |
|---|---|
| Bot replies time out (`no Stop hook`) | `claude` isn't authenticated, or the model is overloaded. Run `claude` manually once (Step 4); retry. / `claude` 미인증이거나 모델 과부하. 4단계 재실행 후 재시도. |
| Bot ignores messages | Enable **Message Content Intent** (Step 5) and re-invite if needed. / **Message Content Intent** 켜고 필요시 재초대. |
| Can't create channels | The bot needs **Manage Channels**. Re-invite with that permission. / 봇에 **Manage Channels** 권한 필요. 해당 권한으로 재초대. |
| `claude`/`tmux` not found | They're not on the service's PATH. Use `bash -lc` in `ExecStart`, or absolute paths in `.env` (`CLAUDE_BIN`/`TMUX_BIN`). / 서비스 PATH에 없음. `ExecStart` 에 `bash -lc` 쓰거나 `.env` 의 `CLAUDE_BIN`/`TMUX_BIN` 에 절대경로. |
| Service won't survive reboot | Run `loginctl enable-linger "$USER"`. / `loginctl enable-linger "$USER"` 실행. |

See the main [README](../README.md) for architecture and how to add a bot.
아키텍처와 봇 추가 방법은 [README](../README.md) 참고.

---

## 11. Optional: weekly finance market-brief (qlib) / 선택: 주간 시장 브리핑

The `finance` bot can post a **weekly market brief** built from a small local
quant pipeline (`scripts/finance-brief/`): daily KOSPI candles → qlib
(Alpha158 + LightGBM) → a relative-strength signal file → a briefing posted into
a fresh thread. This is **entirely optional and off by default** — the bot works
as a normal chat bot without any of it.

> **Reference signal only.** The model's information coefficient (IC) is low, so
> the output is a *relative-ranking hint*, not a prediction. Treat it as one small
> input, never a buy/sell call.

**Prerequisites**

1. **Toss Securities Open API creds** in `.env` (quote read only, no orders):
   ```
   TOSSINVEST_CLIENT_ID=...
   TOSSINVEST_CLIENT_SECRET=...
   ```
   and install the runtime client: `pnpm add toss-securities`.
2. **The localhost trigger server** enabled — set `BUTLER_TRIGGER_TOKEN` (and
   optionally `BUTLER_HTTP_PORT`, default 8787) in `.env` (see Step 6).
3. **A Python 3.11 venv** for qlib (needs `uv` + `libomp`; qlib requires 3.11, not 3.13):
   ```bash
   bash scripts/finance-brief/setup-venv.sh
   ```

**Run it weekly**

Install the launchd template so the pipeline runs Mon–Fri 08:00 KST (the script's
own gate only proceeds on the week's first trading day; holidays roll forward):

```bash
sed -e "s/YOUR_USERNAME/$(whoami)/g" \
  scripts/com.discordbutler.finance-brief.daemon.plist \
  | sudo tee /Library/LaunchDaemons/com.discordbutler.finance-brief.plist >/dev/null
sudo chown root:wheel /Library/LaunchDaemons/com.discordbutler.finance-brief.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.discordbutler.finance-brief.plist
```

To test the pipeline once by hand: `bash scripts/finance-brief/run-weekly.sh`.

`finance` 봇은 소형 로컬 퀀트 파이프라인(`scripts/finance-brief/`: KOSPI 일봉 → qlib
Alpha158+LightGBM → 상대강도 신호 → 스레드 게시)으로 **주간 시장 브리핑**을 올릴 수 있습니다.
**완전 선택이며 기본은 꺼져 있습니다** — 없어도 봇은 평범한 채팅 봇으로 동작합니다. 모델 IC가
낮아 **예측이 아닌 참고용 상대 랭킹**입니다. 사전 준비: (1) `.env`에 `TOSSINVEST_CLIENT_ID/SECRET`
(시세 조회 전용) + `pnpm add toss-securities`, (2) 로컬 트리거 서버(`BUTLER_TRIGGER_TOKEN`),
(3) Python 3.11 venv(`bash scripts/finance-brief/setup-venv.sh`). 그 뒤 위 launchd 템플릿을 설치하면
매주 첫 개장일 아침에 실행됩니다.
