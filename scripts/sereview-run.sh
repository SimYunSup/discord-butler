#!/usr/bin/env bash
# sereview review-packet builder — read-only, immediate (NO approval gate). Takes a
# PR and prints a ReviewPacket (JSON) to stdout. sereview never calls an LLM — it is
# a deterministic packet generator (no API key). The `packet` subcommand is
# HARD-CODED here, so this script cannot run arbitrary code → the code-review bot
# calls it directly (not via gated-run); being read-only, it needs no owner gate.
#
# Usage:
#   sereview-run.sh <pr-url | owner/repo#number> [--max-bundle-tokens N]
#   git diff origin/main... | sereview-run.sh --diff -
#
# Requires `sereview` on PATH (npm i -g sereview), else falls back to `npx -y sereview`.
set -euo pipefail

# Strip instrumentation env a parent process manager may hand down (NODE_OPTIONS=
# --import …, PLT_*) — left in, sereview's node child would try to attach to a
# runtime IPC socket and die with connect ENOENT (same fix as gated-run.sh / hooks).
unset NODE_OPTIONS
for _v in $(compgen -e); do case "$_v" in PLT_*) unset "$_v" ;; esac; done

if [ "$#" -eq 0 ]; then
  printf '{"ok":false,"error":"usage: sereview-run.sh <pr-url|owner/repo#N> [--max-bundle-tokens N]"}\n'
  exit 2
fi

# Prefer a globally-installed sereview (no registry round-trip). `packet` is
# hard-coded — the args ("$@") are passed only as `sereview packet`'s argv (no shell re-eval).
if command -v sereview >/dev/null 2>&1; then
  exec sereview packet "$@"
fi
exec npx -y sereview packet "$@"
