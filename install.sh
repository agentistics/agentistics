#!/bin/sh
# agentop installer. POSIX sh on purpose: it is piped into whatever `sh` the
# machine has (`curl … | sh`, `| bash`, `| zsh`), so it must run identically on
# dash, macOS's /bin/sh, bash 3.2 and zsh. No `[[`, no arrays, no `pipefail`.
#
# Test hooks (not for users): AGENTOP_INSTALL_BASE_URL replaces the GitHub
# release URL, AGENTOP_INSTALL_OS / AGENTOP_INSTALL_ARCH replace uname,
# AGENTOP_INSTALL_SKIP_TMUX=1 skips the tmux step.
set -eu

REPOS="agentistics/agentistics blpsoares/agentistics"
BINARY="agentop"

OS="${AGENTOP_INSTALL_OS:-$(uname -s)}"
ARCH="${AGENTOP_INSTALL_ARCH:-$(uname -m)}"
IS_ROOT=0
if [ "$(id -u)" -eq 0 ]; then
  IS_ROOT=1
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

case "$OS" in
  Linux)
    if [ "$ARCH" != "x86_64" ]; then
      echo "Error: only x86_64 Linux binaries are published at the moment (detected: $ARCH)."
      exit 1
    fi
    ;;
  Darwin)
    case "$ARCH" in
      x86_64|arm64) ;;
      *)
        echo "Error: only x86_64 and arm64 macOS binaries are published at the moment (detected: $ARCH)."
        exit 1
        ;;
    esac
    ;;
  *)
    echo "Error: only Linux and macOS binaries are published at the moment (detected: $OS)."
    exit 1
    ;;
esac

IS_MUSL=0
if [ "$OS" = "Linux" ] && (ldd --version 2>&1 || true) | grep -qi musl; then
  IS_MUSL=1
fi

BINARY_ASSET="$BINARY"
if [ "$OS" = "Darwin" ]; then
  if [ "$ARCH" = "arm64" ]; then
    BINARY_ASSET="${BINARY}-darwin-arm64"
  else
    BINARY_ASSET="${BINARY}-darwin-x64"
  fi
elif [ "$IS_MUSL" -eq 1 ]; then
  BINARY_ASSET="${BINARY}-musl"

  if command -v apk >/dev/null 2>&1; then
    echo "musl libc detected — ensuring libstdc++/libgcc are present…"
    if [ "$IS_ROOT" -eq 1 ]; then
      apk add --no-cache libstdc++ libgcc >/dev/null 2>&1 || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo apk add --no-cache libstdc++ libgcc >/dev/null 2>&1 || true
    else
      echo "  Not root and no sudo on PATH — if the binary fails to start, run:"
      echo "    apk add libstdc++ libgcc"
    fi
  fi
fi

if [ "${AGENTOP_INSTALL_SKIP_TMUX:-}" != "1" ] && ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found — agentop's session manager needs it. Installing…"

  # Empty when root (or when there is no sudo); the package managers below only
  # run when we are root or sudo exists.
  TMUX_SUDO=""
  CAN_INSTALL=0
  if [ "$IS_ROOT" -eq 1 ]; then
    CAN_INSTALL=1
  elif command -v sudo >/dev/null 2>&1; then
    TMUX_SUDO="sudo"
    CAN_INSTALL=1
  fi

  if [ "$OS" = "Darwin" ]; then
    # Homebrew refuses to run as root and needs no sudo.
    if command -v brew >/dev/null 2>&1; then
      brew install tmux || true
    else
      echo "  Homebrew is not installed. To get tmux, install Homebrew from https://brew.sh"
      echo "  and then run: brew install tmux"
    fi
  elif [ "$CAN_INSTALL" -eq 1 ]; then
    if command -v apt >/dev/null 2>&1; then
      $TMUX_SUDO apt-get update -qq 2>/dev/null || true
      $TMUX_SUDO apt install -y tmux || true
    elif command -v apt-get >/dev/null 2>&1; then
      $TMUX_SUDO apt-get update -qq 2>/dev/null || true
      $TMUX_SUDO apt-get install -y tmux || true
    elif command -v dnf >/dev/null 2>&1; then
      $TMUX_SUDO dnf install -y tmux || true
    elif command -v yum >/dev/null 2>&1; then
      $TMUX_SUDO yum install -y tmux || true
    elif command -v pacman >/dev/null 2>&1; then
      $TMUX_SUDO pacman -Sy --noconfirm tmux || true
    elif command -v zypper >/dev/null 2>&1; then
      $TMUX_SUDO zypper install -y tmux || true
    elif command -v apk >/dev/null 2>&1; then
      $TMUX_SUDO apk add tmux || true
    elif command -v brew >/dev/null 2>&1; then
      brew install tmux || true
    else
      echo "  No supported package manager found — install tmux manually."
    fi
  else
    echo "  Not root and no sudo on PATH — install tmux yourself, e.g.: apt install tmux"
  fi

  if command -v tmux >/dev/null 2>&1; then
    echo "  tmux installed ($(tmux -V))."
  else
    echo "  tmux is still missing — agentop will run, but session features (agentop session," \
         "the cockpit's Sessions tab) will not work until it is installed."
  fi
  echo ""
fi

mkdir -p "$INSTALL_DIR"
DOWNLOADED=""
for REPO in $REPOS; do
  RELEASE_URL="${AGENTOP_INSTALL_BASE_URL:-https://github.com/${REPO}/releases/latest/download}/${BINARY_ASSET}"
  echo "Downloading ${BINARY_ASSET} from ${RELEASE_URL} …"
  if curl -fsSL "$RELEASE_URL" -o "${INSTALL_DIR}/${BINARY}"; then
    DOWNLOADED=1
    break
  fi
done
if [ -z "$DOWNLOADED" ]; then
  echo "Download failed from every known location (${REPOS})." >&2
  exit 1
fi
chmod +x "${INSTALL_DIR}/${BINARY}"

# A file fetched by curl is not quarantined, but one that arrived through a
# browser or AirDrop is, and Gatekeeper then refuses the unsigned binary.
if [ "$OS" = "Darwin" ] && command -v xattr >/dev/null 2>&1; then
  if xattr "${INSTALL_DIR}/${BINARY}" 2>/dev/null | grep -q "com.apple.quarantine"; then
    xattr -d com.apple.quarantine "${INSTALL_DIR}/${BINARY}" 2>/dev/null || true
  fi
fi

echo "Installed: ${INSTALL_DIR}/${BINARY}"

# PATH: ~/.local/bin is not on a fresh Mac's PATH. Edit the rc file of the
# user's login shell ($SHELL — not the interpreter running this script), once.
MARKER="# agentop: add ~/.local/bin to PATH"
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

add_path_line() {
  # $1 = file, $2 = line
  mkdir -p "$(dirname "$1")"
  if [ -f "$1" ] && grep -qF "$MARKER" "$1"; then
    return 0
  fi
  {
    echo ""
    echo "$MARKER"
    echo "$2"
  } >> "$1"
  PATH_FILES="${PATH_FILES} $1"
}

PATH_FILES=""
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    if [ "$IS_ROOT" -eq 0 ]; then
      case "${SHELL:-}" in
        */zsh)
          add_path_line "${ZDOTDIR:-$HOME}/.zshrc" "$PATH_LINE"
          ;;
        */bash)
          add_path_line "$HOME/.bashrc" "$PATH_LINE"
          if [ "$OS" = "Darwin" ]; then
            add_path_line "$HOME/.bash_profile" "$PATH_LINE"
          fi
          ;;
        */fish)
          add_path_line "$HOME/.config/fish/conf.d/agentop.fish" 'fish_add_path -g "$HOME/.local/bin"'
          ;;
        *)
          add_path_line "$HOME/.profile" "$PATH_LINE"
          ;;
      esac
      echo ""
      if [ -n "$PATH_FILES" ]; then
        echo "Added ${INSTALL_DIR} to your PATH in:${PATH_FILES}"
      else
        echo "${INSTALL_DIR} is already set up to be added to your PATH."
      fi
      echo "To use agentop RIGHT NOW in this terminal, run: export PATH=\"\$HOME/.local/bin:\$PATH\"   (a new terminal finds agentop on its own)"
    fi
    ;;
esac

# --- Offer to start agentistics now, and on login/boot --------------------------------------
# Under `curl | sh` stdin is this script, so answers come from the controlling terminal. With no
# usable terminal (CI, Docker) nothing is asked and nothing is started; the env vars
# AGENTOP_INSTALL_START / AGENTOP_INSTALL_AUTOSTART (yes|no) answer for automation.
BIN="${INSTALL_DIR}/${BINARY}"
TTY_DEV="${AGENTOP_INSTALL_TTY:-/dev/tty}"
HAVE_TTY=0
if [ -r "$TTY_DEV" ] && (: < "$TTY_DEV") 2>/dev/null; then
  HAVE_TTY=1
  exec 3< "$TTY_DEV"
fi

# ask "question" -> 0 for yes (Enter = yes), 1 for no.
ask() {
  printf '%s [Y/n] ' "$1"
  ANSWER=""
  read -r ANSWER <&3 || ANSWER=""
  case "$ANSWER" in
    n|N|no|NO|No) return 1 ;;
    *) return 0 ;;
  esac
}

# decide VAR "question": env var wins, else ask on the terminal, else "unset".
decide() {
  case "$1" in
    yes|YES|y|1|true) return 0 ;;
    no|NO|n|0|false) return 1 ;;
  esac
  if [ "$HAVE_TTY" -eq 1 ]; then
    ask "$2"
    return $?
  fi
  return 2
}

WANT_START=1
WANT_BOOT=1
decide "${AGENTOP_INSTALL_START:-}" "Start agentistics now?" && WANT_START=0 || WANT_START=$?
if [ "$WANT_START" -eq 2 ] && [ "${AGENTOP_INSTALL_AUTOSTART:-}" = "yes" ]; then
  WANT_START=0
fi

START_LOG="${HOME}/.agentistics/server.log"
WEB_PORT="${AGENTOP_INSTALL_PORT:-47292}"
STARTED=0

start_in_background() {
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${WEB_PORT}/" 2>/dev/null; then
    echo "agentistics is already running — not starting another."
    STARTED=1
    return 0
  fi
  mkdir -p "${HOME}/.agentistics"
  nohup "$BIN" server > "$START_LOG" 2>&1 < /dev/null &
  echo "agentistics started in the background (log: ${START_LOG}; it stops at reboot)."
  STARTED=1
}

if [ "$WANT_START" -eq 0 ]; then
  echo ""
  # Recommended first-run settings (archive mode consolidate) for EVERY "yes" path below: boot,
  # one-off background start, and root. Never overrides a choice the person already made.
  "$BIN" setup --defaults || true
  if [ "$IS_ROOT" -eq 1 ]; then
    echo "Running as root: start-on-login is a per-user service, so it is not offered. Run the installer as your own user for that."
    start_in_background
  else
    decide "${AGENTOP_INSTALL_AUTOSTART:-}" "Start agentistics automatically when you log in / boot?" && WANT_BOOT=0 || WANT_BOOT=$?
    if [ "$WANT_BOOT" -eq 0 ]; then
      # An occupied port is the unit's job: its ExecCondition guard (`autostart guard server`) skips
      # the start quietly when something already serves it, so no port check is made here.
      if "$BIN" autostart server enable; then
        STARTED=1
      else
        echo "Could not register start-on-login — starting it just this once instead."
        start_in_background
      fi
    else
      start_in_background
    fi
  fi
  if [ "$STARTED" -eq 1 ]; then
    echo ""
    echo "Open http://localhost:${WEB_PORT} in your browser."
    if [ "$OS" = "Darwin" ] && command -v open >/dev/null 2>&1; then
      open "http://localhost:${WEB_PORT}" >/dev/null 2>&1 || true
    fi
  fi
elif [ "$WANT_START" -eq 2 ]; then
  echo ""
  echo "No terminal to ask on, so nothing was started. To start it:"
  echo "  ${BIN} setup --defaults          # recommended first-run settings"
  echo "  ${BIN} autostart server enable   # start now and on every login/boot"
fi

echo ""
echo "Usage:"
echo "  ${BINARY} server       # web dashboard + daemon"
echo "  ${BINARY} tui          # terminal TUI"
echo "  ${BINARY} watch        # daemon only"
