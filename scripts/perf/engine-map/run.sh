#!/usr/bin/env bash
# run.sh — the ENGINE.MAP bench on a THROWAWAY server (F0.4). One script for CI and for a local run.
#
#   PLAN=quick scripts/perf/engine-map/run.sh                  # CI: ~6 min, N=0/1/10 × C=0/1/5
#   PLAN=quick SOAK_MIN=5 LABEL=soak scripts/perf/engine-map/run.sh
#
# Locally it is a heavy job: >= 5 GB available, one at a time, in a capped scope — and the SERVER never
# inside flock (a flock inherited by the server outlives the script):
#   systemd-run --user --scope -p MemoryMax=3G -p CPUQuota=200% scripts/perf/engine-map/run.sh
#
# What it builds under $ROOT (default $RUNNER_TEMP/engine-map, else ~/.cache/engine-map-ci):
#   home/   a SYNTHETIC home (scripts/perf/synth-home.ts + synth-harnesses.ts) — nothing is copied from
#           a real machine, nothing links to a real ~/.claude ~/.codex ~/.gemini ~/.copilot;
#   data/   AGENTISTICS_DIR, empty (consolidate mode, telemetry off, no backup schedule);
#   bin/    the fake harnesses (claude codex gemini copilot kimi agy → fake-harness) + the tmux shim;
#   tmux/   TMUX_TMPDIR — the server's own tmux socket lives here, never the real one;
#   work/   cwd of the fake sessions;  logs/  server.log, tmux-calls.log, bench-*.{md,json}.
#
# Safety (owner rules): never ports 47291/47292, refuses a port in use, `env -i` so nothing of the
# caller's AGENTISTICS_*/TMUX/XDG_RUNTIME_DIR leaks in, the four real harness configs are checked
# BEFORE and AFTER, and the server is stopped ONLY by the PIDs recorded here (the lock holder and the
# process this script started) — the tmux server only by its own socket. Never pkill/killall by name.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ROOT="${ROOT:-${RUNNER_TEMP:+$RUNNER_TEMP/engine-map}}"; ROOT="${ROOT:-$HOME/.cache/engine-map-ci}"
PORT="${PORT:-48881}"; WEB_PORT="${WEB_PORT:-48882}"
PLAN="${PLAN:-quick}"; SOAK_MIN="${SOAK_MIN:-0}"; LABEL="${LABEL:-ci}"
SCALE="${SCALE:-0.1}"
BUN="$(command -v bun)"

case "$PORT$WEB_PORT" in *47291*|*47292*) echo "refusing the real ports" >&2; exit 2 ;; esac
for p in "$PORT" "$WEB_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then echo "port $p already in use — refusing" >&2; exit 2; fi
done
case "$ROOT" in "$HOME/.agentistics"*|"$HOME/.claude"*|"$HOME/.codex"*|"$HOME/.gemini"*|"$HOME/.copilot"*) echo "refusing ROOT inside real data" >&2; exit 2 ;; esac
command -v tmux >/dev/null || { echo "tmux is required (the sessions run in it)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required (the fake harnesses write transcripts with it)" >&2; exit 2; }

check_configs() {
  local bad=0 f
  for f in "$HOME/.claude.json" "$HOME/.codex/config.toml" "$HOME/.gemini/settings.json" "$HOME/.copilot/mcp-config.json"; do
    [ -f "$f" ] || continue
    if grep -q -E "localhost:($PORT|$WEB_PORT)|127\.0\.0\.1:($PORT|$WEB_PORT)|$ROOT" "$f"; then echo "[safety] $f mentions this run!" >&2; bad=1; fi
  done
  return $bad
}
check_configs || { echo "[safety] configs not clean BEFORE the run — aborting" >&2; exit 3; }

# ── the throwaway environment ───────────────────────────────────────────────────────────────────
rm -rf "$ROOT"
mkdir -p "$ROOT"/{home,data,bin,tmux,work,logs}
TH="$ROOT/home"
"$BUN" "$REPO/scripts/perf/synth-home.ts" "$TH" --scale "$SCALE" --big 0 | sed 's/^/[env] /'
"$BUN" "$REPO/scripts/perf/synth-harnesses.ts" "$TH" --codex 20 --codex-kb 60 --gemini 6 --copilot 6 | sed 's/^/[env] /'
mkdir -p "$TH/.claude/sessions" "$TH/.codex" "$TH/.gemini" "$TH/.copilot"
echo '{}' > "$TH/.claude.json"
for h in claude codex gemini copilot kimi agy; do cp "$HERE/fake-harness" "$ROOT/bin/$h"; chmod +x "$ROOT/bin/$h"; done
cp "$HERE/tmux-shim" "$ROOT/bin/tmux"; chmod +x "$ROOT/bin/tmux"
printf '%s\n' '{"backup":{"schedule":"off"},"scanRoots":[],"archiveMode":"consolidate","experimental":'"$([ "${EXPERIMENTAL:-0}" = 1 ] && echo true || echo false)"'}' > "$ROOT/data/preferences.json"

# bun must stay reachable under `env -i`; the fakes and the tmux shim come FIRST.
SPATH="$ROOT/bin:$(dirname "$BUN"):/usr/local/bin:/usr/bin:/bin"
SRV_ENV=(env -i HOME="$TH" USER="${USER:-runner}" LOGNAME="${USER:-runner}" SHELL=/bin/bash LANG=C.UTF-8 TERM=xterm-256color
  PATH="$SPATH" TMUX_TMPDIR="$ROOT/tmux" TMUX_SHIM_LOG="$ROOT/logs/tmux-calls.log"
  AGENTISTICS_DIR="$ROOT/data" PORT="$PORT" WEB_PORT="$WEB_PORT"
  AGENTISTICS_THROWAWAY=1 AGENTISTICS_TELEMETRY=0 AGENTISTICS_JOURNAL_BACKFILL=0 FAKE_THINK_S="${FAKE_THINK_S:-1}")

# `--port` is what keeps `agentop server` from delegating to an installed service unit: this one is
# ours, on our own data dir.
( cd "$REPO" && exec "${SRV_ENV[@]}" "$BUN" packages/server/bin/cli.ts server --port "$PORT" ) > "$ROOT/logs/server.log" 2>&1 &
SRV=$!
echo "$SRV" > "$ROOT/server.pid"
echo "[run] server started, pid $SRV, :$PORT"
# The lock holder is what `cli.ts server` may re-launch itself as; read from the lock, never guessed.
holder_pid() { local h; h="$(awk '{print $1; exit}' "$ROOT/data/server.lock" 2>/dev/null || true)"; case "$h" in ""|*[!0-9]*) return 0 ;; esac; kill -0 "$h" 2>/dev/null && echo "$h" || true; }

stop_pid() { # only a PID this script recorded
  local p="$1"; [ -n "$p" ] || return 0
  if kill -0 "$p" 2>/dev/null; then kill "$p" 2>/dev/null || true; for _ in $(seq 1 30); do kill -0 "$p" 2>/dev/null || return 0; sleep 0.2; done; kill -9 "$p" 2>/dev/null || true; fi
}
tmux_sock() { ls -d "$ROOT"/tmux/tmux-*/agentop* 2>/dev/null | head -1 || true; }

# WATCHDOG: every 5 s; MemAvailable < 2 GB stops the run at once (and, off CI, so does a 1-min load > 8:
# a 2-core runner is legitimately loaded, a developer machine is not).
(
  while kill -0 "$SRV" 2>/dev/null; do
    avail_kb=$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)
    why=""
    [ "$avail_kb" -lt 2097152 ] && why="MemAvailable ${avail_kb} kB < 2 GB"
    if [ -z "${CI:-}" ]; then
      load1=$(cut -d' ' -f1 /proc/loadavg)
      awk -v l="$load1" 'BEGIN{exit !(l>8)}' && why="${why:+$why; }load1 $load1 > 8"
    fi
    if [ -n "$why" ]; then
      echo "[watchdog] $(date -Is) STOPPING: $why" | tee -a "$ROOT/logs/watchdog.log" >&2
      stop_pid "$(holder_pid)"; stop_pid "$SRV"
      sock="$(tmux_sock)"; [ -n "$sock" ] && /usr/bin/tmux -S "$sock" kill-server 2>/dev/null
      exit 0
    fi
    sleep 5
  done
) &
WATCHDOG=$!

cleanup() {
  kill "${WATCHDOG:-0}" 2>/dev/null || true
  stop_pid "$(holder_pid)"; stop_pid "$SRV"
  local sock; sock="$(tmux_sock)"
  [ -n "$sock" ] && /usr/bin/tmux -S "$sock" kill-server 2>/dev/null || true
  # The artifacts are collected HERE so a run that died half way still leaves its logs and the
  # partial table (bench.ts saves after every condition).
  if [ -n "${OUT_DIR:-}" ]; then
    mkdir -p "$OUT_DIR"
    cp "$ROOT"/logs/bench-* "$ROOT"/logs/budgets-* "$ROOT"/logs/tmux-calls.log "$ROOT"/logs/watchdog.log "$OUT_DIR"/ 2>/dev/null || true
    cp "$ROOT/logs/server.log" "$OUT_DIR/server-$LABEL.log" 2>/dev/null || true
  fi
  check_configs && echo "[safety] configs clean after the run" || echo "[safety] CONFIGS TOUCHED — report it" >&2
}
trap cleanup EXIT
trap 'exit 143' TERM INT

for i in $(seq 1 180); do
  curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  kill -0 "$SRV" 2>/dev/null || { echo "server died — tail of $ROOT/logs/server.log:" >&2; tail -40 "$ROOT/logs/server.log" >&2; exit 4; }
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null || { echo "server never answered /api/health" >&2; tail -40 "$ROOT/logs/server.log" >&2; exit 4; }
check_configs || { echo "[safety] configs touched right after boot — stopping" >&2; exit 5; }

# The process whose CPU/RSS the bench samples is the one holding the data dir's lock.
HOLDER="$(holder_pid)"; HOLDER="${HOLDER:-$SRV}"
echo "[run] server up after ${i}s, measuring pid $HOLDER"

# ── the bench, then the budgets ─────────────────────────────────────────────────────────────────
OUT="$ROOT/logs"
"$BUN" "$HERE/bench.ts" --base "http://127.0.0.1:$PORT" --pid "$HOLDER" --root "$ROOT" --plan "$PLAN" \
  --soak-min "$SOAK_MIN" --label "$LABEL" --out "$OUT/bench-$LABEL.json" | tee "$OUT/bench-$LABEL.md"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### ENGINE.MAP bench — $LABEL (plan $PLAN)"; echo; cat "$OUT/bench-$LABEL.md"; echo; } >> "$GITHUB_STEP_SUMMARY"
fi
status=0
"$BUN" "$HERE/check.ts" "$OUT/bench-$LABEL.json" | tee "$OUT/budgets-$LABEL.md" || status=$?
exit "$status"
