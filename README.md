# audiofy

Talk with your coding agent (Claude Code, Codex, OpenCode, ...) without switching back to its window. The agent speaks to you through your speakers; you answer with a floating push-to-talk button from whatever app you're in.

Everything runs locally:

- **Speech to text:** NVIDIA Parakeet TDT 0.6B v3 (int8). About 1 s for 10 s of audio on a laptop CPU.
- **Text to speech:** Kokoro 82M v1.0. About 0.3× real time on CPU.
- Both run through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), which ships prebuilt binaries for Windows, macOS and Linux (x64 and arm64), so no Python or GPU setup is needed.

## How it works

```
agent ──shell──► audiofy CLI ──HTTP──► local server (127.0.0.1:7777, models stay loaded)
                                            │  SSE
                                            ▼
                              overlay page in your browser
                              (mic + speakers + floating button)
```

- `audiofy say "..."` speaks. `audiofy listen` blocks until you press the button and talk, then prints your words. `audiofy converse "..."` does both.
- The agent reads that output as your reply, does the work, and calls `converse` again. The skill in `skill/audiofy` teaches it this loop.
- The overlay runs in the browser, so microphone and audio output work the same on every OS. If no overlay is open, `say` falls back to the OS player: `pw-play`, `paplay`, `aplay` or `ffplay` on Linux, `afplay` on macOS, PowerShell's SoundPlayer on Windows.

## Install

The installer sets up everything it needs: git and bzip2 through your package manager (it may ask for your sudo password), and Node.js in `~/.audiofy/node` if you don't have 18.17+.

**Linux / macOS, one line:**

```sh
curl -fsSL https://raw.githubusercontent.com/idkuday/audiofy/main/install.sh | bash
```

This needs no sudo. It does the following:
- Clones audiofy into `~/.audiofy/app` and links the `audiofy` command into `~/.local/bin`.
- Downloads the models (~800 MB) to `~/.audiofy/models`.
- Installs the skill for every agent it finds (Claude Code, Codex, OpenCode).
- Starts the server.

Run it again to update.

**Any OS, from a clone:**

```sh
git clone https://github.com/idkuday/audiofy.git && cd audiofy
npm install && npm link    # puts `audiofy` on your PATH
audiofy init               # skill for every agent found + models + server
```

## Use it with an agent

`audiofy init` installs the skill for every agent it finds. To install it for one agent by hand:

```sh
audiofy install-skill            # Claude Code: ~/.claude/skills/audiofy
audiofy install-skill --codex    # ~/.codex/skills/audiofy
audiofy install-skill --opencode # ~/.config/opencode/skill/audiofy
audiofy install-skill --dir <skills-folder>
```

Then tell the agent "voice mode" or "let's talk".

On first use the skill does three things:

1. Asks you for a listen timeout (default 1 hour) and saves it in `audiofy.timeout` next to `SKILL.md`.
2. With your approval, raises the agent's own shell-command time limit to match.
3. Writes what it did to `~/.audiofy/TIMEOUT_SETTING_INSTRUCTIONS_<PROVIDER>.md`, so it never has to work it out again.

`listen` returns `[no input]` a little before the timeout, and the agent simply calls it again.

## The overlay

Open it with `audiofy overlay` (or go to http://127.0.0.1:7777). Click **Pop out** to get a small always-on-top window. This uses Document Picture-in-Picture, so it needs Chrome or Edge.

| Button | Meaning |
|---|---|
| Grey | Idle. Click to talk; your words are queued for the agent's next `listen`. |
| Green pulse | The agent is waiting for you. |
| Red | Recording. Click again to send. |
| Blue | The agent is speaking. Click to skip. |

`Space` also toggles the button while the overlay has focus.

### Hands-free mode

Turn on the **Hands-free** switch under the button and you never have to click.

- **When the mic is open:** the whole time hands-free is on, except while the agent speaks, so it never hears itself.
- **When it sends:** you just talk, and about 2.5 seconds of silence sends what you said. If the agent is busy, your message is queued and it gets it the next time it listens.
- **How it decides what's speech:** a light energy detector in the browser decides where your speech starts and ends, keeping half a second from just before you started so the first word isn't clipped. Silero VAD on the server then drops clips that aren't really speech, such as typing, coughs or a door.
- **Memory:** the setting is remembered in the browser. Clicking the button still works as manual push-to-talk.

### Global keyboard shortcut

Bind an OS shortcut to `audiofy ptt` (toggle recording):

- **Linux (GNOME/KDE, including Wayland):** Settings → Keyboard → Custom Shortcuts → command `audiofy ptt`.
- **Windows:** make a desktop shortcut to `audiofy ptt`, then Properties → Shortcut key.
- **macOS:** a Shortcuts.app "Run Shell Script" action, or Raycast/Alfred.

## CLI

```
audiofy say <text>                 speak; returns when playback ends
audiofy listen [--timeout 1h | --timeout-file <file>]
audiofy converse <text> [timeout options]
audiofy start | stop | status | serve | overlay | ptt
audiofy transcribe <file.wav>
audiofy tts <text> -o <out.wav>
options: --voice af_heart (any Kokoro English voice, e.g. am_michael, bf_emma, bm_george), --speed 1.0
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `AUDIOFY_PORT` | `7777` | Server port |
| `AUDIOFY_HOME` | `~/.audiofy` | Models, log (`server.log`) and setup notes |
| `AUDIOFY_THREADS` | half the CPU cores (max 8) | Inference threads |
| `AUDIOFY_NO_OPEN` | unset | `1` stops the server from opening the overlay automatically |

## HTTP API (127.0.0.1 only)

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/say` | `{text, voice?, speed?}` | Returns after playback |
| `POST /api/listen` | `{timeoutSec}` | Long-polls until you speak. Returns `{text}`, or `{text: null}` on timeout |
| `POST /api/transcribe` | WAV bytes | `{text}` |
| `POST /api/tts` | `{text, voice?, speed?}` | WAV bytes |
| `POST /api/ptt` | | Toggles recording in the overlay |
| `GET /api/status` | | Server status |

## Limits (v0.1)

- **One agent session at a time.** A newer `listen` replaces an older one.
- **The overlay must be open to record.** The server opens it automatically when an agent starts listening and none is connected.
- **Remote agents:** if the agent runs over SSH, run audiofy on your own machine and forward the port with `ssh -R 7777:127.0.0.1:7777 host`. The CLI on the remote side then talks to your local server.
