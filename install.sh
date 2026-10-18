#!/usr/bin/env bash
# audiofy installer for Linux and macOS. Installs the CLI + local server,
# downloads the speech models, and installs the voice-mode skill for every
# coding agent it finds (Claude Code, Codex, OpenCode). No sudo needed.
#
#   curl -fsSL https://raw.githubusercontent.com/idkuday/audiofy/main/install.sh | bash
#
# Re-running it updates an existing install.
set -euo pipefail

REPO="${AUDIOFY_REPO:-https://github.com/idkuday/audiofy.git}"
BRANCH="${AUDIOFY_BRANCH:-main}"
APP_DIR="${AUDIOFY_HOME:-$HOME/.audiofy}/app"
BIN_DIR="${AUDIOFY_BIN_DIR:-$HOME/.local/bin}"
ORIG_PATH="$PATH"

say() { printf '\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

# --- prerequisites -----------------------------------------------------------
missing=()
has git || missing+=(git)
has tar || missing+=(tar)
[ "$(uname -s)" = Linux ] && ! has bzip2 && missing+=(bzip2)
if [ ${#missing[@]} -gt 0 ]; then
  hint="install them with your package manager"
  if has apt-get; then hint="sudo apt-get install -y ${missing[*]}"
  elif has dnf; then hint="sudo dnf install -y ${missing[*]}"
  elif has pacman; then hint="sudo pacman -S --needed ${missing[*]}"
  elif has zypper; then hint="sudo zypper install -y ${missing[*]}"
  elif has brew; then hint="brew install ${missing[*]}"
  fi
  fail "missing: ${missing[*]} - $hint"
fi

if ! has node || ! has npm; then
  fail "Node.js 18.17+ is required. Install it from https://nodejs.org or with nvm:
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>18||(a===18&&b>=17)?0:1)' \
  || fail "Node.js 18.17+ is required (found $(node --version))"

# --- fetch or update the code ------------------------------------------------
if [ -d "$APP_DIR/.git" ]; then
  say "Updating audiofy in $APP_DIR"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
else
  say "Downloading audiofy to $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

say "Installing dependencies"
(cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error)

# --- put `audiofy` on PATH ---------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$APP_DIR/src/cli.js"
ln -sf "$APP_DIR/src/cli.js" "$BIN_DIR/audiofy"
export PATH="$BIN_DIR:$PATH"

# --- skill, models, server ---------------------------------------------------
# Stop an older server so the new code is the one that runs.
audiofy stop >/dev/null 2>&1 || true
say "Setting up skill, models (~800 MB on first run) and server"
audiofy init

# --- audio output check (Linux) ----------------------------------------------
if [ "$(uname -s)" = Linux ] && ! has pw-play && ! has paplay && ! has aplay && ! has ffplay; then
  echo
  echo "Note: no command-line audio player found. Speech still plays through the"
  echo "browser overlay; for playback without it, install pipewire, pulseaudio-utils or alsa-utils."
fi

echo
say "audiofy is installed."
case ":$ORIG_PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo "Add audiofy to your PATH (then open a new terminal):"
    echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc   # or ~/.zshrc"
    echo
    ;;
esac
cat <<EOF
Next steps:
  1. Open the overlay in Chrome, Edge or Brave:  http://127.0.0.1:7777
     Click the button once to allow the microphone, then "Pop out" to float it.
  2. Restart your coding agent so it picks up the new skill.
  3. Tell the agent: "voice mode".
EOF
