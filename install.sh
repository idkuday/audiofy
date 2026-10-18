#!/usr/bin/env bash
# audiofy installer for Linux and macOS. Installs everything audiofy needs:
# missing system packages (git, bzip2), Node.js if missing or too old, the
# CLI + local server, the speech models, and the voice-mode skill for every
# coding agent it finds (Claude Code, Codex, OpenCode).
#
#   curl -fsSL https://raw.githubusercontent.com/idkuday/audiofy/main/install.sh | bash
#
# Re-running it updates an existing install.
set -euo pipefail

# Everything runs inside main(), so a piped `curl | bash` reads the whole
# script before anything executes (nothing can swallow the rest of it).
main() {
REPO="${AUDIOFY_REPO:-https://github.com/idkuday/audiofy.git}"
BRANCH="${AUDIOFY_BRANCH:-main}"
AUDIOFY_DIR="${AUDIOFY_HOME:-$HOME/.audiofy}"
APP_DIR="$AUDIOFY_DIR/app"
BIN_DIR="${AUDIOFY_BIN_DIR:-$HOME/.local/bin}"
NODE_VERSION="22.19.0" # downloaded only when no suitable Node.js is installed
PORT="${AUDIOFY_PORT:-7777}"
ORIG_PATH="$PATH"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
case "$OS" in Linux | Darwin) ;; *) fail "unsupported OS: $OS (on Windows, see the README)" ;; esac

# --- system packages ---------------------------------------------------------
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"
  elif has sudo; then sudo "$@"
  else fail "sudo is not available; install the missing packages yourself and re-run"
  fi
}

install_packages() {
  say "Installing $* (you may be asked for your password)"
  if has apt-get; then as_root apt-get update -qq && as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
  elif has dnf; then as_root dnf install -y -q "$@"
  elif has yum; then as_root yum install -y -q "$@"
  elif has pacman; then as_root pacman -S --needed --noconfirm "$@"
  elif has zypper; then as_root zypper --quiet install -y "$@"
  elif has apk; then as_root apk add --quiet "$@"
  elif has brew; then brew install "$@"
  else fail "no supported package manager found; install $* and re-run"
  fi
}

packages=()
has git || packages+=(git)
has tar || packages+=(tar)
has curl || has wget || packages+=(curl)
# GNU tar needs bzip2 to unpack the models; macOS tar has it built in.
[ "$OS" = Linux ] && ! has bzip2 && packages+=(bzip2)
if [ ${#packages[@]} -gt 0 ]; then install_packages "${packages[@]}"; fi

fetch() { if has curl; then curl -fsSL "$1"; else wget -qO- "$1"; fi; }

# --- Node.js -----------------------------------------------------------------
node_ok() {
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)' 2>/dev/null
}

PRIVATE_NODE="$AUDIOFY_DIR/node/bin/node"
if has node && has npm && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif [ -x "$PRIVATE_NODE" ] && node_ok "$PRIVATE_NODE"; then
  NODE="$PRIVATE_NODE"
else
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "no prebuilt Node.js for $(uname -m); install Node.js 18.17+ and re-run" ;;
  esac
  platform="$(printf '%s' "$OS" | tr '[:upper:]' '[:lower:]')"
  say "Installing Node.js $NODE_VERSION into $AUDIOFY_DIR/node"
  tmp="$(mktemp -d)"
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$platform-$arch.tar.gz" | tar -xz -C "$tmp"
  mkdir -p "$AUDIOFY_DIR"
  rm -rf "$AUDIOFY_DIR/node"
  mv "$tmp/node-v$NODE_VERSION-$platform-$arch" "$AUDIOFY_DIR/node"
  rm -rf "$tmp"
  NODE="$PRIVATE_NODE"
fi
export PATH="$(dirname "$NODE"):$PATH"

# --- fetch or update the code ------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating audiofy in $APP_DIR"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  say "Downloading audiofy to $APP_DIR"
  mkdir -p "$AUDIOFY_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

say "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# --- the `audiofy` command ---------------------------------------------------
# A wrapper pinned to this Node, so it works even where Node isn't on PATH
# (e.g. the shells coding agents spawn).
mkdir -p "$BIN_DIR"
rm -f "$BIN_DIR/audiofy"
cat >"$BIN_DIR/audiofy" <<EOF
#!/bin/sh
exec "$NODE" "$APP_DIR/src/cli.js" "\$@"
EOF
chmod +x "$BIN_DIR/audiofy"
AUDIOFY="$BIN_DIR/audiofy"

# Put BIN_DIR on PATH for future shells, login and interactive alike.
path_files=()
case ":$ORIG_PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    line="export PATH=\"$BIN_DIR:\$PATH\""
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ "$rc" = "$HOME/.profile" ] || [ -f "$rc" ] || continue
      if ! grep -qsF "$BIN_DIR" "$rc"; then
        printf '\n# Added by the audiofy installer\n%s\n' "$line" >>"$rc"
        path_files+=("$rc")
      fi
    done
    fish_rc="$HOME/.config/fish/config.fish"
    if [ -f "$fish_rc" ] && ! grep -qsF "$BIN_DIR" "$fish_rc"; then
      printf '\n# Added by the audiofy installer\nfish_add_path %s\n' "$BIN_DIR" >>"$fish_rc"
      path_files+=("$fish_rc")
    fi
    ;;
esac

# --- skill, models, server ---------------------------------------------------
"$AUDIOFY" stop >/dev/null 2>&1 || true # make sure the new code is what runs
say "Setting up the skill, speech models (~800 MB on first run) and server"
"$AUDIOFY" init

if [ "$OS" = Linux ] && ! has pw-play && ! has paplay && ! has aplay && ! has ffplay; then
  echo
  echo "Note: no command-line audio player found. Speech plays through the browser"
  echo "overlay; for playback when it's closed, install pipewire, pulseaudio-utils or alsa-utils."
fi

# --- how to use it -----------------------------------------------------------
echo
say "audiofy is installed"
if [ ${#path_files[@]} -gt 0 ]; then
  echo "Added $BIN_DIR to your PATH in: ${path_files[*]}"
  echo "Open a new terminal (or run: export PATH=\"$BIN_DIR:\$PATH\") to use the audiofy command."
  echo
fi
cat <<EOF
How to use it:

  1. Open the overlay in Chrome, Edge or Brave:  http://127.0.0.1:$PORT
     (or run: audiofy overlay). Click the mic button once to allow the microphone,
     then click "Pop out" for a small floating button that stays on top.

  2. Restart your coding agent (Claude Code, Codex or OpenCode) so it loads
     the audiofy skill, then tell it:  voice mode
     The first time, it asks how long to wait for you to speak (default 1 hour)
     and may ask to raise its command time limit. Say yes, then restart it if asked.

  3. Talk to it:
     - Click the button (or press Space in the overlay) to talk, click again to send.
     - Or switch on Hands-free under the button and just talk. A pause of about
       2.5 seconds sends it.
     - Green pulse: the agent is waiting for you. Blue: it's speaking (click to skip).
     - Say "stop voice mode" to go back to typing.

  Keep only one overlay tab open, otherwise audio plays twice.

  Commands:  audiofy status | start | stop | overlay | help
  Update:    run this installer again
  Logs:      $AUDIOFY_DIR/server.log
EOF
}

main "$@"
