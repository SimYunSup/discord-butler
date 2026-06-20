#!/usr/bin/env bash
# discord-butler one-command installer / 원커맨드 설치 스크립트
#
# Automates the *automatable* parts of docs/self-hosting.md: prerequisites
# (Node 20 + pnpm + tmux + git + claude CLI), clone, install, build, .env, and a
# 24/7 service (systemd --user on Linux, launchd on macOS).
#
# Two steps it CANNOT do for you (they're inherently human):
#   1. Create the Discord app + token in the Developer Portal (you paste the token).
#   2. Log in to `claude` once (interactive OAuth) — unless you pass ANTHROPIC_API_KEY.
#
# Usage — interactive (keeps a TTY so it can prompt for the token):
#   bash <(curl -fsSL https://raw.githubusercontent.com/SimYunSup/discord-butler/main/scripts/install.sh)
# Usage — non-interactive (CI / unattended): supply secrets as env vars:
#   DISCORD_TOKEN=xxx ANTHROPIC_API_KEY=sk-... bash <(curl -fsSL .../install.sh)
#
# Re-running is safe: existing repo/.env/service are reused, not clobbered.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SimYunSup/discord-butler.git}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/discord-butler}"
log() { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in
  Linux)  PKG="apt" ;;
  Darwin) PKG="brew" ;;
  *) die "unsupported OS: $OS (Linux or macOS only)" ;;
esac

# 1. Prerequisites ----------------------------------------------------------
log "installing prerequisites (tmux, git, curl)…"
if [ "$PKG" = "apt" ]; then
  sudo apt-get update -y && sudo apt-get install -y tmux git curl
else
  have brew || die "Homebrew not found — install it first: https://brew.sh"
  brew install tmux git || true
fi

if ! have node || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  log "installing Node 20 via fnm…"
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)" 2>/dev/null || true
  fnm install 20 && fnm use 20 && fnm default 20
fi
have corepack && corepack enable && corepack prepare pnpm@latest --activate
have claude || npm install -g @anthropic-ai/claude-code

node -v && pnpm -v && tmux -V && claude --version || die "prerequisite check failed"

# 2. Code -------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  log "repo already at $INSTALL_DIR — pulling latest"
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  log "cloning $REPO_URL → $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"
pnpm install
pnpm build

# 3. .env -------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  if [ -z "${DISCORD_TOKEN:-}" ] && [ -t 0 ]; then
    log "Create the app at https://discord.com/developers/applications → Bot → Reset Token, then paste it below."
    read -r -p "Discord bot token (DISCORD_TOKEN): " DISCORD_TOKEN
  fi
  [ -n "${DISCORD_TOKEN:-}" ] || die "DISCORD_TOKEN is required (env var or prompt). Create the app at https://discord.com/developers/applications first."
  # replace the placeholder line; append the rest only if provided
  if grep -q '^DISCORD_TOKEN=' .env; then
    sed -i.bak "s|^DISCORD_TOKEN=.*|DISCORD_TOKEN=${DISCORD_TOKEN}|" .env && rm -f .env.bak
  else
    printf 'DISCORD_TOKEN=%s\n' "$DISCORD_TOKEN" >> .env
  fi
  [ -n "${OWNER_DISCORD_ID:-}" ] && printf 'OWNER_DISCORD_ID=%s\n' "$OWNER_DISCORD_ID" >> .env
  [ -n "${ANTHROPIC_API_KEY:-}" ] && printf 'ANTHROPIC_API_KEY=%s\n' "$ANTHROPIC_API_KEY" >> .env
  log ".env created"
else
  log ".env already exists — left untouched"
fi

# 4. Authenticate the model (before starting the service) -------------------
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  log "ANTHROPIC_API_KEY present — skipping interactive claude login."
elif [ -t 0 ]; then
  printf '\033[1;34m[install]\033[0m Log in to claude now? A device/browser prompt opens; type /exit when done. [Y/n] '
  read -r ans
  case "${ans:-Y}" in
    [Nn]*) log "skipped — run 'claude' yourself before messaging the bot." ;;
    *) claude || log "claude login didn't finish — re-run 'claude' later." ;;
  esac
else
  log "no TTY and no ANTHROPIC_API_KEY — authenticate later: run 'claude' (or set ANTHROPIC_API_KEY)."
fi

# 5. Service ----------------------------------------------------------------
if [ "$OS" = "Linux" ]; then
  log "registering systemd --user service…"
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/discord-butler.service" <<UNIT
[Unit]
Description=discord-butler bridge
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash -lc 'node dist/index.mjs'
Restart=always
RestartSec=3
EnvironmentFile=$INSTALL_DIR/.env

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now discord-butler
  loginctl enable-linger "$USER" || true
  SERVICE_HINT="systemctl --user status discord-butler  •  journalctl --user -u discord-butler -f"
else
  log "registering launchd LaunchAgent…"
  PLIST="$HOME/Library/LaunchAgents/com.discord-butler.plist"
  NODE_BIN="$(command -v node)"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.discord-butler</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$INSTALL_DIR/dist/index.mjs</string></array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PL
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  SERVICE_HINT="launchctl list | grep discord-butler"
fi

# 6. Remaining human step ----------------------------------------------------
log "done. One manual step remains:"
cat <<NOTE

  • In the Discord Developer Portal: enable Message Content Intent and invite the
    bot with the Manage Channels permission (see docs/self-hosting.md §5).
    If you skipped the claude login above, run 'claude' once before messaging.

  Service:  $SERVICE_HINT
NOTE
