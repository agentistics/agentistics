#!/usr/bin/env bash
#
# record-cast.sh — record one asciinema cast of an interactive agentop screen.
#
# The control center and the TUI are full-screen Ink applications: they need a
# real pty and they must be driven by keystrokes, which `asciinema rec -c` alone
# cannot do. So the program runs inside a detached tmux session, keys are sent to
# it from outside, and asciinema records a READ-ONLY attach to that session — the
# recording therefore captures exactly what a user would see, with no recorder
# chrome and no stray input of our own.
#
# Usage:
#   record-cast.sh <name> <cols> <rows> <command> [-- <key> <delay-ms> ...]
#
#   record-cast.sh control 120 34 "agentop start" -- Right 1200 Right 1200 q 400
#
# Output: $OUT_DIR/<name>.cast   (OUT_DIR defaults to ./casts)
#
# Env:
#   OUT_DIR      where the .cast lands
#   HOME_DIR     HOME for the recorded program (use a demo home — never your own)
#   EXTRA_ENV    extra "K=V K=V" passed to the recorded program
#   SETTLE_MS    wait after start before the first key (default 2500)
#   TAIL_MS      wait after the last key before stopping (default 1500)

set -euo pipefail

NAME="${1:?name required}"
COLS="${2:?cols required}"
ROWS="${3:?rows required}"
CMD="${4:?command required}"
shift 4
[ "${1:-}" = "--" ] && shift

OUT_DIR="${OUT_DIR:-./casts}"
SETTLE_MS="${SETTLE_MS:-2500}"
TAIL_MS="${TAIL_MS:-1500}"
SESSION="rec_${NAME}_$$"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$NAME.cast"

sleep_ms() { sleep "$(awk "BEGIN{print $1/1000}")"; }

cleanup() { tmux kill-session -t "$SESSION" 2>/dev/null || true; }
trap cleanup EXIT

# A fixed size is what keeps every cast in a set visually consistent; the Ink
# screens lay themselves out from it, so it must be set before the program runs.
#
# The pane runs a BARE shell (--noprofile --norc) with a neutral prompt. The
# operator's own prompt is the leak nobody thinks about: a themed prompt puts the
# host, the cwd, the git branch and — with the common work setups — an e-mail
# address on screen, and it reappears the moment the recorded program exits. A
# published GIF cannot be taken back, so the prompt is replaced, not trusted.
#
# The demo HOME, the ports and the binary's directory all go on the SESSION's
# shell, never on the command we type. Two reasons, both of them things that end
# up in a published file: the pane inherits the tmux server's environment, so
# setting HOME anywhere else leaves the recorded program reading the operator's
# real config; and a typed `env HOME=/home/<user>/… /home/<user>/…/agentop start`
# puts that user's name and directory layout on screen for the first seconds of
# every recording. What gets typed is just `agentop start`.
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "env -u PROMPT_COMMAND -u STARSHIP_SHELL AGENTISTICS_TELEMETRY=0 COLORTERM=truecolor FORCE_COLOR=3 \
   HOME='${HOME_DIR:-$HOME}' PATH='${BIN_DIR:-$HOME/.local/bin}:/usr/local/bin:/usr/bin:/bin' \
   ${EXTRA_ENV:-} PS1='$ ' bash --noprofile --norc"
tmux set-option -t "$SESSION" status off
# TRUECOLOR, or the recording is the wrong colour. The TUI paints in 24-bit hex
# (#f59e0b amber); inside tmux the default TERM advertises only 256 colours, so
# Ink downsamples it to the nearest ANSI index — plain yellow — and the whole
# wordmark comes out a different colour from the one users actually see.
tmux set-option -t "$SESSION" default-terminal "tmux-256color"
tmux set-option -ga terminal-overrides ",*:Tc"
tmux send-keys -t "$SESSION" "clear" Enter

# asciinema records the read-only attach. `-q` keeps its own banner out of the
# cast; the attach ends when we kill the session, which ends the recording.
asciinema rec -q \
  --cols "$COLS" --rows "$ROWS" \
  -c "tmux attach -t $SESSION -r" \
  "$OUT_DIR/$NAME.cast" &
REC_PID=$!

sleep_ms 600  # let the recorder attach before anything happens on screen

tmux send-keys -t "$SESSION" "$CMD" Enter
sleep_ms "$SETTLE_MS"

while [ $# -gt 0 ]; do
  key="$1"; delay="${2:?each key needs a delay}"; shift 2
  # A literal string is sent as text; a named key (Enter, Right, C-c…) as a key.
  case "$key" in
    Enter|Escape|Tab|BTab|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|C-*|M-*)
      tmux send-keys -t "$SESSION" "$key" ;;
    *)
      tmux send-keys -t "$SESSION" -l "$key" ;;
  esac
  sleep_ms "$delay"
done

sleep_ms "$TAIL_MS"
cleanup
wait "$REC_PID" 2>/dev/null || true

echo "recorded $OUT_DIR/$NAME.cast"
