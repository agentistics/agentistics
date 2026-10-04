#!/usr/bin/env bash
# scripts/perf/copy-data.sh — a THROWAWAY copy of this machine's data for the perf baseline (PERF.1).
#
# Usage: scripts/perf/copy-data.sh [dest]   (default: /tmp/agentistics-perf/home)
#
# The copy is a fake $HOME: the harness dirs (~/.claude, ~/.codex, ~/.gemini, ~/.copilot, opencode)
# and ~/.agentistics WITHOUT what must never leave its place: the vault, provider keys, sealed
# backups, team connections and central data, and the backups/archive (size, not data the server
# reads at boot). preferences.json is copied with its `team` block removed, so the copy can never
# push to a central. The running server and its data are only READ, never written.
set -euo pipefail
DEST="${1:-/tmp/agentistics-perf/home}"
case "$DEST" in "$HOME"|"$HOME/"|/) echo "refusing to copy onto $DEST" >&2; exit 2;; esac
mkdir -p "$DEST"
copy() { [ -e "$HOME/$1" ] || return 0; mkdir -p "$DEST/$(dirname "$1")"; rsync -a --delete "${@:2}" "$HOME/$1/" "$DEST/$1/"; }
copy .claude --exclude '.credentials.json' --exclude 'shell-snapshots' --exclude 'statsig' --exclude 'plugins/cache'
copy .codex --exclude 'auth.json'
copy .gemini --exclude 'oauth_creds.json'
copy .copilot
copy .local/share/opencode --exclude 'auth.json'
copy .agentistics \
  --exclude 'vault' --exclude 'provider-keys' --exclude '*.sealed' --exclude 'backups' --exclude 'backups.jsonl' \
  --exclude 'archive' --exclude 'central' --exclude 'connections' --exclude 'team*' --exclude '*.corrupt-*' \
  --exclude '*.pre-*' --exclude 'run' --exclude 'instance.lock' --exclude 'preferences.json' --exclude 'agentop-server.log'
if [ -f "$HOME/.agentistics/preferences.json" ]; then
  bun -e "const p=JSON.parse(await Bun.file(process.argv[1]).text()); delete p.team; await Bun.write(process.argv[2], JSON.stringify(p,null,2))" \
    "$HOME/.agentistics/preferences.json" "$DEST/.agentistics/preferences.json"
fi
du -sh "$DEST" | cat
