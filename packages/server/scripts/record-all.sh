#!/usr/bin/env bash
#
# record-all.sh — record the full set of terminal casts for the README and site.
#
# Every cast runs against a DEMO machine home built by seed-demo.ts, never your
# own: the recordings are published, and a real project name or repository in one
# cannot be taken back. Build the fleet first:
#
#   bun run packages/server/scripts/seed-demo.ts --split 3 --force
#   HOME=~/.agentistics-demo-home-1 PORT=47391 ./release/agentop server &
#
# Then:  packages/server/scripts/record-all.sh
#
# Output: casts/*.cast (embed with asciinema-player) and casts/*.gif (README).
#
# Env: DEMO_HOME (default ~/.agentistics-demo-home-1), DEMO_PORT (47391),
#      AGENTOP (./release/agentop), OUT_DIR (./casts).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

DEMO_HOME="${DEMO_HOME:-$HOME/.agentistics-demo-home-1}"
DEMO_PORT="${DEMO_PORT:-47391}"
AGENTOP="${AGENTOP:-$ROOT/release/agentop}"
OUT_DIR="${OUT_DIR:-$ROOT/casts}"

[ -x "$AGENTOP" ] || { echo "no binary at $AGENTOP — run 'bun run build:binary'" >&2; exit 1; }
[ -d "$DEMO_HOME" ] || { echo "no demo home at $DEMO_HOME — run seed-demo.ts" >&2; exit 1; }
command -v asciinema >/dev/null || { echo "asciinema is not installed" >&2; exit 1; }
command -v agg >/dev/null || { echo "agg is not installed" >&2; exit 1; }

rec() {
  # BIN_DIR puts the binary under test on the recorded shell's PATH, so the
  # command that appears on screen is `agentop …` and not an absolute path
  # through the operator's home directory.
  OUT_DIR="$OUT_DIR" HOME_DIR="$DEMO_HOME" EXTRA_ENV="PORT=$DEMO_PORT" \
  BIN_DIR="$(dirname "$AGENTOP")" \
    "$HERE/record-cast.sh" "$@"
}

# The control center's Services tab: move across the tabs, then into the panes.
# Only navigation — nothing here presses enter on a verb that would start, stop
# or rebuild anything.
SETTLE_MS=3500 rec control-center 120 34 "agentop start" -- \
  Down 1100 Tab 1000 Down 900 Down 900 Tab 1100 Right 1400 Right 1400 Right 1300 Left 1300 Left 1300 Left 1300 q 500

# Setup tab — the setup wizard, shown but never submitted.
SETTLE_MS=3500 rec control-center-setup 120 34 "agentop start" -- \
  Right 1600 Down 1000 Down 1000 Up 1000 q 500

# The cheat sheet: the one screen that is pure reference, so it reads well as a
# still image too.
SETTLE_MS=3500 rec control-center-commands 120 34 "agentop start" -- \
  Right 900 Right 900 Right 1800 Down 900 Down 900 Down 900 q 500

# The live terminal dashboard. It scans the demo home's harness dirs first, so it
# needs a longer settle before the first keypress. Its screens are bound to the
# DIGITS and to tab — not to the arrows, which the control center uses; pressing
# arrows here does nothing and the cast ends up being one static screen.
SETTLE_MS=12000 TAIL_MS=1800 rec tui 120 34 "agentop tui" -- \
  2 2400 3 2400 4 2400 5 2400 1 2000 q 600

# Non-interactive commands: one shot each, no keys. These are the ones a reader
# copies, so they are recorded exactly as typed.
SETTLE_MS=6000 TAIL_MS=1200 rec status 100 26 "agentop status"

# agentistics' own palette, not a stock terminal theme: the background matches
# the dashboard's (#0a0a0f) and index 3 is the product's amber rather than a
# pale yellow, so anything that DOES fall back to a 16-colour index still lands
# on the right colour instead of a different-looking product.
#   bg,fg,black,red,green,yellow,blue,magenta,cyan,white,+ the bright eight
THEME="0a0a0f,e4e4e7,111118,f43f5e,10b981,f59e0b,6366f1,8b5cf6,38bdf8,e4e4e7,52525b,fb7185,34d399,fbbf24,818cf8,a78bfa,7dd3fc,ffffff"

echo
for cast in "$OUT_DIR"/*.cast; do
  gif="${cast%.cast}.gif"
  # 16px renders legibly on GitHub at the width a README column gives it, and
  # the idle cap keeps a long settle from becoming dead seconds in the loop.
  agg --font-size 16 --theme "$THEME" --idle-time-limit 2 "$cast" "$gif" 2>/dev/null
  printf '%-34s %s\n' "$(basename "$gif")" "$(du -h "$gif" | cut -f1)"
done
