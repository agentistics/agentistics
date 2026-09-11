#!/usr/bin/env bash
# Install agentop — agentistics CLI
# Usage: curl -fsSL https://agentop.openvibes.tech/cli | bash
#        sudo curl -fsSL https://agentop.openvibes.tech/cli | bash

set -euo pipefail

REPO="blpsoares/agentistics"
BINARY="agentop"

# ── Determine install directory ────────────────────────────────────────────
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  INSTALL_DIR="/usr/local/bin"
else
  INSTALL_DIR="${HOME}/.local/bin"
fi

# ── Check platform ─────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    if [[ "$ARCH" != "x86_64" ]]; then
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

# ── libc: glibc vs musl (Linux only — macOS has no equivalent split) ────────
#
# Two Linux binaries are published: `agentop` (glibc) and `agentop-musl` (Alpine and other
# musl-based distros — glibc's dynamic linker does not exist there, so the glibc binary fails with
# a bare "not found" that names no missing library). `ldd --version` prints "musl libc" on a musl
# system regardless of its own exit code (busybox's `ldd` does not fully support `--version`) —
# and this script runs under `set -o pipefail`, under which the PIPELINE fails if ANY stage does,
# not only the last, so ldd's own non-zero exit would sink the `if` even when grep matches. The
# `|| true` neutralises that: only grep's result decides.
IS_MUSL=0
if [[ "$OS" == "Linux" ]] && (ldd --version 2>&1 || true) | grep -qi musl; then
  IS_MUSL=1
fi

BINARY_ASSET="$BINARY"
if [[ "$OS" == "Darwin" ]]; then
  if [[ "$ARCH" == "arm64" ]]; then
    BINARY_ASSET="${BINARY}-darwin-arm64"
  else
    BINARY_ASSET="${BINARY}-darwin-x64"
  fi
elif [[ "$IS_MUSL" -eq 1 ]]; then
  BINARY_ASSET="${BINARY}-musl"

  # Bun's own runtime links libstdc++/libgcc even in its musl build, and Alpine's base image ships
  # neither — without them the binary fails with "Error relocating ...: symbol not found" instead
  # of running. `apk` is the only musl-distro package manager worth targeting here.
  if command -v apk >/dev/null 2>&1; then
    echo "musl libc detected — ensuring libstdc++/libgcc are present…"
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      apk add --no-cache libstdc++ libgcc >/dev/null 2>&1 || true
    elif command -v sudo >/dev/null 2>&1; then
      sudo apk add --no-cache libstdc++ libgcc >/dev/null 2>&1 || true
    else
      echo "  Not root and no sudo on PATH — if the binary fails to start, run:"
      echo "    apk add libstdc++ libgcc"
    fi
  fi
fi

RELEASE_URL="https://github.com/${REPO}/releases/latest/download/${BINARY_ASSET}"

# ── Runtime dependency: tmux ────────────────────────────────────────────────
#
# agentop's session manager (`agentop session`, the cockpit's Sessions tab) is built entirely on
# tmux — there is no other backend (see packages/server/server/sessions/dependency-plan.ts, which
# the already-installed binary uses to explain a MISSING tmux to someone who skipped this script or
# removed the package afterwards). Without it every session-related feature fails the moment it is
# used, well after the install already reported success — a confusing place to first learn about a
# missing dependency. So it is installed HERE, proactively, the same way any competent install
# script pulls in what it needs — never silently, and never left to fail on first use.
#
# `apt` is checked before `apt-get` (Debian/Ubuntu ship both; a machine with both gets the modern
# one) and `apt-get update` runs first because a freshly booted cloud VM or container image
# routinely has an empty or stale package index — `apt-get install` alone fails on exactly the
# machines this script most often runs on. `pacman -Sy` syncs the database for the same reason.
if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found — agentop's session manager needs it. Installing…"

  TMUX_SUDO=()
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    if command -v sudo >/dev/null 2>&1; then
      TMUX_SUDO=(sudo)
    else
      echo "  Not root and no sudo on PATH — install tmux yourself, e.g.: apt install tmux"
    fi
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 || ${#TMUX_SUDO[@]} -gt 0 ]]; then
    if command -v apt >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" apt-get update -qq 2>/dev/null || true
      "${TMUX_SUDO[@]}" apt install -y tmux
    elif command -v apt-get >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" apt-get update -qq 2>/dev/null || true
      "${TMUX_SUDO[@]}" apt-get install -y tmux
    elif command -v dnf >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" dnf install -y tmux
    elif command -v yum >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" yum install -y tmux
    elif command -v pacman >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" pacman -Sy --noconfirm tmux
    elif command -v zypper >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" zypper install -y tmux
    elif command -v apk >/dev/null 2>&1; then
      "${TMUX_SUDO[@]}" apk add tmux
    elif command -v brew >/dev/null 2>&1; then
      brew install tmux
    else
      echo "  No supported package manager found — install tmux manually."
    fi
  fi

  if command -v tmux >/dev/null 2>&1; then
    echo "  tmux installed ($(tmux -V))."
  else
    echo "  tmux is still missing — agentop will run, but session features (agentop session," \
         "the cockpit's Sessions tab) will not work until it is installed."
  fi
  echo ""
fi

# ── Download ───────────────────────────────────────────────────────────────
echo "Downloading ${BINARY_ASSET} from ${RELEASE_URL} …"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$RELEASE_URL" -o "${INSTALL_DIR}/${BINARY}"
chmod +x "${INSTALL_DIR}/${BINARY}"

# ── PATH hint ──────────────────────────────────────────────────────────────
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "NOTE: ${INSTALL_DIR} is not in your PATH."
  echo "Add it with:"
  echo ""
  echo "  echo 'export PATH=\"\${HOME}/.local/bin:\${PATH}\"' >> ~/.bashrc && source ~/.bashrc"
  echo ""
fi

echo "Installed: ${INSTALL_DIR}/${BINARY}"
echo ""
echo "Usage:"
echo "  ${BINARY} server       # web dashboard + daemon"
echo "  ${BINARY} tui          # terminal TUI"
echo "  ${BINARY} watch        # daemon only"
