#!/usr/bin/env bash
# Single gated shell entrypoint for risky bots (the GitHub bots). A bot's tool
# allowlist permits ONLY this script for shell, so every gh/git/npx goes through
# here. Read-only commands run immediately; DESTRUCTIVE ones (push / repo create /
# issue create / PR comment / code execution) BLOCK until a Discord button
# approves them — an events(JSONL) + approvals/ file handshake, no TUI injection.
#
# Usage: gated-run.sh <cmd> [args...]
# Run from the bot's workspace cwd (<dataDir>/conversations/<KEY>), or with
# BUTLER_KEY/BUTLER_DATA_DIR injected (the bridge does this — see below).
set -uo pipefail

# Strip any instrumentation env a parent process manager (e.g. Platformatic Watt)
# hands down (NODE_OPTIONS=--import …, PLT_*). Left in, an `exec`ed node/npx would
# try to attach to a runtime IPC socket and die with connect ENOENT → exit 22.
# (Removing it does NOT affect the gate decision — only the instrumentation env.)
unset NODE_OPTIONS
for _v in $(compgen -e); do case "$_v" in PLT_*) unset "$_v" ;; esac; done

[ "$#" -ge 1 ] || { echo "gated-run: no command given" >&2; exit 2; }

# The conversation KEY and data dir come from the env the bridge injects
# (BUTLER_KEY/BUTLER_DATA_DIR) — NOT from $PWD. If they were inferred from $PWD,
# running gated-run inside a cloned repo (work/<repo>) would resolve KEY to the
# repo basename and write Approval events to a file the bridge isn't tailing (the
# button would never appear → 300s timeout). Env makes it correct regardless of
# cwd. We fall back to $PWD only when the env is absent (tests / manual runs).
KEY="${BUTLER_KEY:-$(basename "$PWD")}"
DATADIR="${BUTLER_DATA_DIR:-$(cd "$PWD/../.." 2>/dev/null && pwd)}"
[ -n "$DATADIR" ] || { echo "gated-run: cannot resolve data dir from $PWD" >&2; exit 2; }
EVENTS="$DATADIR/events/$KEY.jsonl"
APPROVALS="$DATADIR/approvals"

# Whitelist of permitted base commands (no rm / curl / bash / sh / eval …).
BIN="$1"
ALLOWED_BINS=" gh git npx node deno bun cargo rustc rustup wasm-pack ls cat mkdir cp mv pwd echo test "
# Per-user-token GitHub bots (KEY=github… / github-issue… / code-review…): running
# a cloned repo's own code on the host is an RCE vector, so we drop the arbitrary-
# code-execution bins (node/npx/deno/bun/cargo/…) and leave gh/git (+read utils)
# only. BUTLER_ALLOW_CODE_EXEC=1 (the bridge injects it ONLY for bots whose
# registry entry sets `allowRepoCodeExec` — issue-solving + code-review) skips this
# narrowing: those bots legitimately need builds/tests. Their code-exec bins still
# ALWAYS hit the approval gate below, and that approval is OWNER-ONLY (an `.owner`
# marker; the requester can NOT self-approve code execution).
if [ "${BUTLER_ALLOW_CODE_EXEC:-}" != 1 ]; then
  case "$KEY" in
    github*|code-review*) ALLOWED_BINS=" gh git ls cat mkdir cp mv pwd echo test " ;;
  esac
fi
case "$ALLOWED_BINS" in
  *" $BIN "*) : ;;
  *) echo "gated-run: '$BIN' is not a permitted command" >&2; exit 3 ;;
esac

CMD="$*"
# Scan only the part BEFORE a message/body flag, so commit/PR/issue text like
# `-m "fix push bug"` can't trigger a false gate. `.*` between tokens makes the
# patterns robust to intervening flags (e.g. `git -C work/repo push`).
SCAN="$CMD"
SCAN="${SCAN%% -m *}"
SCAN="${SCAN%% --message *}"
SCAN="${SCAN%% -b *}"
SCAN="${SCAN%% --body *}"
# `gh pr (review|comment)` = posting a comment/review to a PR (external write) →
# gate the code-review bot's comment posting. `gh pr merge` gated too. `gh pr
# view/diff/checkout/list` are NOT here (read/local). `gh api` writes are handled
# separately by gh_api_needs_gate() below (the regex can't tell an implicit POST
# from a read).
DESTRUCTIVE_RE='\bgit\b.*\bpush\b|--force|\bgh\b.*\brepo\b.*\b(create|delete|fork)\b|\bgh\b.*\bpr\b.*\b(merge|review|comment)\b|\bgh\b.*\brelease\b.*\bcreate\b|\bgit\b.*\bremote\b.*\b(add|set-url)\b|\bgh\b.*\bissue\b.*\bcreate\b'

# `gh api` gate decision. The regex can't catch two bypasses:
#   1) write args (-f/-F/--field/--raw-field/--input) make gh auto-upgrade to POST
#      → a server write with no explicit -X.
#   2) `--method` (=-X alias, in `=`/space/glommed `-XPOST` forms).
# Policy: gh api runs immediately (return 1) ONLY when the method is provably
# GET/HEAD with no write args; everything else gates (return 0). Parses argv
# directly, so it's immune to the -m/-b truncation and regex bypasses.
gh_api_needs_gate() {
  local t method='' has_write=0 want_method=0
  for t in "$@"; do
    if [ "$want_method" = 1 ]; then method="$t"; want_method=0; continue; fi
    case "$t" in
      -X|--method)                       want_method=1 ;;
      -X=*|--method=*)                   method="${t#*=}" ;;
      -X*)                               method="${t#-X}" ;;   # glommed: -XPOST
      -f|-F|--field|--raw-field|--input) has_write=1 ;;
      --field=*|--raw-field=*|--input=*) has_write=1 ;;
      -f*|-F*)                           has_write=1 ;;        # glommed: -ftitle=x
    esac
  done
  local m
  m=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
  if [ -z "$m" ]; then                    # method unset → POST if write args, else GET
    if [ "$has_write" = 1 ]; then m=POST; else m=GET; fi
  fi
  if { [ "$m" = GET ] || [ "$m" = HEAD ]; } && [ "$has_write" = 0 ]; then
    return 1   # safe: GET/HEAD + no write args → run immediately
  fi
  return 0     # everything else gates
}

# node/npx/deno/bun/cargo/rustc/rustup/wasm-pack are arbitrary-code escape hatches:
# `node -e '<code>'`, `npx <pkg>`, `deno eval`, `bun x <pkg>` — and `cargo
# build`/`test` runs the crate's `build.rs` + proc-macros at COMPILE time. So a
# prompt-injected "read-only looking" command (a fetched issue telling the bot to
# `cargo test` an untrusted repo) would otherwise auto-execute with no approval.
# ALWAYS gate them regardless of args, matched on the base command ($BIN).
ALWAYS_GATE=" node npx deno bun cargo rustc rustup wasm-pack "
needs_gate=0
code_exec=0  # whether $BIN is an arbitrary-code-execution shell (=ALWAYS_GATE). Used to force owner-only approval.
case "$ALWAYS_GATE" in
  *" $BIN "*) needs_gate=1; code_exec=1 ;;
esac

# `gh api` write-bypass guard: if a gh call has the `api` subcommand, parse argv.
if [ "$needs_gate" -eq 0 ] && [ "$BIN" = gh ]; then
  case " $* " in
    *" api "*) if gh_api_needs_gate "$@"; then needs_gate=1; fi ;;
  esac
fi

# Final gate decision: ALWAYS_GATE / gh api / or the regex → gate.
gate=0
if [ "$needs_gate" -eq 1 ] || printf '%s' "$SCAN" | grep -qiE "$DESTRUCTIVE_RE"; then
  gate=1
fi

# Test hook (regression checks): print the classification only and do NOT
# exec/handshake — it never runs the command, so it can't weaken the gate.
if [ "${GATED_RUN_DRY:-}" = 1 ]; then
  [ "$gate" -eq 1 ] && echo GATE || echo RUN
  exit 0
fi

if [ "$gate" -eq 0 ]; then
  exec "$@"   # read-only / build → run immediately
fi

# --- destructive → approval handshake ---
mkdir -p "$(dirname "$EVENTS")" "$APPROVALS"
REQ="$(date +%s)-$$"
DECISION="$APPROVALS/$KEY.$REQ.decision"
OWNERMARK="$APPROVALS/$KEY.$REQ.owner"
rm -f "$DECISION" "$OWNERMARK"

# Code-execution (node/npx/deno/bun) gates drop an owner marker — the handler's
# canApproveGate sees it and forces OWNER-ONLY approval (even a per-user-token bot's
# requester can NOT self-approve running a cloned repo's code). Other destructive
# commands (git push, issue create) have no marker → the requester may self-approve.
[ "$code_exec" = 1 ] && : > "$OWNERMARK"

# Append an Approval event (JSON-safe) for the bridge to pick up.
python3 - "$EVENTS" "$KEY" "$REQ" "$CMD" <<'PY'
import json, sys, datetime
events, key, req, cmd = sys.argv[1:5]
line = json.dumps({
    "event": "Approval",
    "ts": datetime.datetime.now().astimezone().isoformat(),
    "payload": {"key": key, "reqId": req, "cmd": cmd},
}, ensure_ascii=False)
with open(events, "a", encoding="utf-8") as f:
    f.write(line + "\n")
PY

echo "⏳ waiting for approval (approve/deny in Discord): $CMD" >&2
# Poll for the decision file (0.5s × 600 = 300s timeout).
for _ in $(seq 1 600); do
  if [ -f "$DECISION" ]; then
    d="$(cat "$DECISION" 2>/dev/null)"; rm -f "$DECISION" "$OWNERMARK"
    case "$d" in
      approve) echo "✅ approved — running: $CMD" >&2; exec "$@" ;;
      *)       echo "🚫 denied: $CMD" >&2; exit 4 ;;
    esac
  fi
  sleep 0.5
done
rm -f "$OWNERMARK"
echo "⌛ approval timed out (300s): $CMD" >&2
exit 5
