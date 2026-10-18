---
name: audiofy
description: Voice mode - talk with the user out loud through their speakers and microphone instead of the chat, so they can keep working in other apps. Use when the user asks for voice mode, to talk or speak with them, to go hands-free, or mentions audiofy.
---

# audiofy voice mode

In voice mode the user is not looking at this chat. You speak to them with the `audiofy` command, and their spoken reply comes back as that command's output. They answer with the floating audiofy button (or a keyboard shortcut) from whatever app they are in.

`<skill-dir>` below means the folder this SKILL.md is in.

## One-time setup

Do this before the first voice turn. Each step is skipped once it is done.

1. **Check audiofy is installed.** Run `audiofy status`. If the command is not found, tell the user in chat to install it and stop. On Linux or macOS: `curl -fsSL https://raw.githubusercontent.com/idkuday/audiofy/main/install.sh | bash`. On any OS: clone https://github.com/idkuday/audiofy, then run `npm install && npm link && audiofy init`.

2. **Pick the listen timeout.** This is how long one `audiofy listen` waits for the user before returning `[no input]`.
   - If `<skill-dir>/audiofy.timeout` exists, use it.
   - If not, ask the user in chat: "How long should I wait for you to speak before checking back in? Default is 1 hour." Write their answer to `<skill-dir>/audiofy.timeout` as a single line: seconds (`3600`) or a duration (`90m`, `1h`). Write `3600` if they accept the default.

3. **Let your shell commands run that long.** Your environment's limit on a single shell command must be at least the timeout, or `listen` gets killed while the user is still thinking.
   - Name your environment in upper snake case: `CLAUDE_CODE`, `CODEX`, `OPENCODE`, `GEMINI_CLI`, `CURSOR`, and so on.
   - If `~/.audiofy/TIMEOUT_SETTING_INSTRUCTIONS_<PROVIDER>.md` exists, follow it. It records what already worked for this environment.
   - Otherwise, work out how your environment sets the maximum duration of a shell command, using your own knowledge, its docs or its config files. Explain the exact change to the user and get approval before editing any config. Then apply it.
   - After it works, write `~/.audiofy/TIMEOUT_SETTING_INSTRUCTIONS_<PROVIDER>.md` so this never needs working out again. Include: which file and setting you changed, the value, whether a restart is needed, how to pass the per-command timeout on each call, how to check it took effect, and any pitfalls you hit. In the same file, include how to pre-approve the `audiofy` command so each voice turn does not stop for a permission prompt (only if the user agreed).
   - If a restart is needed, tell the user and stop. Voice mode starts after the restart.
   - If your environment cannot run commands that long, set `audiofy.timeout` to the longest it allows and tell the user.

## The voice loop

| Goal | Command |
|---|---|
| Say something and wait for the reply | `audiofy converse "<message>" --timeout-file "<skill-dir>/audiofy.timeout"` |
| Wait for the user without speaking | `audiofy listen --timeout-file "<skill-dir>/audiofy.timeout"` |
| Say something and keep working | `audiofy say "<message>"` |

- Every time you run `listen` or `converse`, set your shell tool's own per-command timeout to the value in `audiofy.timeout` (or longer). audiofy returns a little before that limit, so the command finishes cleanly.
- The command's output is the user's message. Treat it exactly as if they had typed it in chat.
- `[no input]` means they have not spoken yet. Run `audiofy listen` again. Do not speak or comment.
- If the user talks while you are working, audiofy queues it, and the next `listen` returns it immediately.
- **Never end your turn with only a chat message while voice mode is on.** Every turn ends with `converse` or `listen`, otherwise the user is left waiting for an answer that never comes.
- If an `audiofy` command errors, run `audiofy start` and retry once. If it still fails, report it in chat.

## How to speak

- Use one to three short sentences of plain spoken language. Do not say markdown, code, file paths, URLs or long lists. Say "the config file", not its path.
- Put details (diffs, code, logs, long explanations) in the chat as usual, and say "details are in the terminal".
- Before long work, say so with `audiofy say "On it, I'll tell you when it's done."`, then work, then report the result with `converse`.
- Ask one question at a time. Prefer questions with a yes or no answer.
- Transcripts can mishear words, so interpret them sensibly. Before anything destructive or ambiguous, read back what you understood and confirm.
- Keep `"` and `$` out of spoken text so shell quoting doesn't break.
- If you are blocked on a permission prompt that the user has to click, say so: "I need your approval in the terminal."

## Leaving voice mode

When the user says to stop voice mode (or "that's all", "back to text"), run `audiofy say "Voice mode off."` and continue in chat.
