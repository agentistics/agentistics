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

echo ""
echo "Usage:"
echo "  ${BINARY} server       # web dashboard + daemon"
echo "  ${BINARY} tui          # terminal TUI"
echo "  ${BINARY} watch        # daemon only"
