#!/usr/bin/env node
// audiofy CLI: the interface agents (and people) use to speak and listen.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, BASE_URL, HOME_DIR, LOG_FILE, DEFAULT_TIMEOUT_SEC, parseDuration, readTimeoutFile, ensureDir } from './config.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `audiofy - local speech-to-text / text-to-speech for you and your coding agent

Voice loop (what agents call):
  audiofy say <text>                 Speak text aloud; returns when playback ends
  audiofy listen [timeout]           Wait for the user to talk (overlay button / ptt);
                                     prints the transcript, or [no input] on timeout
  audiofy converse <text> [timeout]  say, then listen

  timeout: --timeout <1h|60m|3600>  or  --timeout-file <path/to/audiofy.timeout>
           (default ${DEFAULT_TIMEOUT_SEC}s). Pass the agent's command time limit; audiofy
           returns a little before it so the command is never killed.

Server and overlay:
  audiofy start | stop | status      Manage the background server (auto-started when needed)
  audiofy serve [--no-open]          Run the server in the foreground
  audiofy overlay                    Open the push-to-talk overlay in your browser
  audiofy ptt                        Toggle recording (bind this to an OS keyboard shortcut)

Utilities:
  audiofy transcribe <file.wav>      Print the transcript of a WAV file
  audiofy tts <text> -o <out.wav>    Write speech to a WAV file
  audiofy init                       One-step setup: install the skill for every agent found,
                                     download the models, start the server
  audiofy setup                      Download the speech models (~800 MB, once)
  audiofy install-skill [--claude|--codex|--opencode|--dir <dir>]
                                     Copy the agent skill into an agent's skills folder

Options for say/converse/tts: --voice <name> (default af_heart), --speed <n>`;

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const takesValue = ['timeout', 'timeout-file', 'voice', 'speed', 'dir', 'out'].includes(k);
      flags[k] = v ?? (takesValue ? argv[++i] : true);
    } else if (a === '-o') flags.out = argv[++i];
    else rest.push(a);
  }
  return { flags, rest };
}

function request(method, urlPath, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const isBuf = Buffer.isBuffer(body);
    const data = body == null ? null : isBuf ? body : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path: urlPath,
        headers: data ? { 'Content-Type': isBuf ? 'audio/wav' : 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            let msg = buf.toString();
            try { msg = JSON.parse(msg).error; } catch {}
            return reject(new Error(msg));
          }
          resolve(raw ? buf : JSON.parse(buf.toString() || '{}'));
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function isRunning() {
  try {
    return (await request('GET', '/api/status')).ok === true;
  } catch {
    return false;
  }
}

async function ensureServer({ quiet = false } = {}) {
  if (await isRunning()) return;
  ensureDir(HOME_DIR);
  const out = fs.openSync(LOG_FILE, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  if (!quiet) console.error(`Started audiofy server (pid ${child.pid}), log: ${LOG_FILE}`);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isRunning()) return;
  }
  throw new Error(`Server did not start; see ${LOG_FILE}`);
}

async function textArg(rest) {
  if (rest.length && rest[0] !== '-') return rest.join(' ');
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function timeoutSec(flags) {
  if (flags['timeout-file']) {
    const file = flags['timeout-file'];
    if (fs.existsSync(file)) return readTimeoutFile(file);
    console.error(`${file} not found; using ${DEFAULT_TIMEOUT_SEC}s`);
    return DEFAULT_TIMEOUT_SEC;
  }
  if (flags.timeout) {
    const sec = parseDuration(flags.timeout);
    if (!sec) throw new Error(`Invalid --timeout "${flags.timeout}" (try 1h, 60m or 3600)`);
    return sec;
  }
  return DEFAULT_TIMEOUT_SEC;
}

async function say(flags, text) {
  if (!text) throw new Error('Nothing to say');
  await ensureServer();
  await request('POST', '/api/say', { text, voice: flags.voice, speed: flags.speed });
}

async function listen(flags) {
  const limit = timeoutSec(flags);
  // Return before the agent's command limit so the call is never killed.
  const margin = Math.min(30, Math.max(2, Math.round(limit * 0.05)));
  await ensureServer();
  const { text } = await request('POST', '/api/listen', { timeoutSec: Math.max(1, limit - margin) });
  console.log(text ? text : '[no input]');
}

// Agents audiofy knows how to install its skill into. `home` is the agent's
// config folder; its presence means the agent is installed.
const AGENTS = {
  claude: { label: 'Claude Code', home: path.join(os.homedir(), '.claude'), skills: 'skills' },
  codex: { label: 'Codex', home: path.join(os.homedir(), '.codex'), skills: 'skills' },
  opencode: { label: 'OpenCode', home: path.join(os.homedir(), '.config', 'opencode'), skills: 'skill' },
};

function skillTarget(flags) {
  if (flags.dir) return path.resolve(flags.dir, 'audiofy');
  const key = Object.keys(AGENTS).find((k) => flags[k]) || 'claude';
  return path.join(AGENTS[key].home, AGENTS[key].skills, 'audiofy');
}

function installSkill(dest) {
  const timeoutFile = path.join(dest, 'audiofy.timeout');
  // Keep the user's chosen timeout across reinstalls.
  const keep = fs.existsSync(timeoutFile) ? fs.readFileSync(timeoutFile) : null;
  fs.cpSync(path.join(ROOT, 'skill', 'audiofy'), dest, { recursive: true });
  if (keep) fs.writeFileSync(timeoutFile, keep);
}

const commands = {
  async say({ flags, rest }) {
    await say(flags, await textArg(rest));
  },
  async listen({ flags }) {
    await listen(flags);
  },
  async converse({ flags, rest }) {
    await say(flags, await textArg(rest));
    await listen(flags);
  },
  async start() {
    await ensureServer();
    console.log(`audiofy running at ${BASE_URL}`);
  },
  async stop() {
    if (!(await isRunning())) return console.log('audiofy is not running');
    await request('POST', '/api/shutdown');
    console.log('audiofy stopped');
  },
  async status() {
    if (!(await isRunning())) return console.log('audiofy is not running');
    const s = await request('GET', '/api/status');
    console.log(`running at ${BASE_URL} (pid ${s.pid}); overlays open: ${s.overlays}; agent listening: ${s.listening}`);
  },
  async serve({ flags }) {
    const { startServer } = await import('./server.js');
    startServer({ open: !flags['no-open'] });
  },
  async overlay() {
    await ensureServer();
    const { openUrl } = await import('./audio.js');
    openUrl(BASE_URL);
    console.log(`Opened ${BASE_URL}`);
  },
  async ptt() {
    await ensureServer({ quiet: true });
    await request('POST', '/api/ptt');
  },
  async transcribe({ rest }) {
    if (!rest[0]) throw new Error('Usage: audiofy transcribe <file.wav>');
    const wav = fs.readFileSync(rest[0]);
    await ensureServer();
    console.log((await request('POST', '/api/transcribe', wav)).text);
  },
  async tts({ flags, rest }) {
    const text = await textArg(rest);
    if (!text || !flags.out) throw new Error('Usage: audiofy tts <text> -o <out.wav>');
    await ensureServer();
    const wav = await request('POST', '/api/tts', { text, voice: flags.voice, speed: flags.speed }, { raw: true });
    fs.writeFileSync(flags.out, wav);
    console.log(`Wrote ${flags.out}`);
  },
  async setup() {
    const { installModel } = await import('./engines.js');
    await installModel('stt');
    await installModel('tts');
    await installModel('vad');
    console.log('Models ready.');
  },
  async 'install-skill'({ flags }) {
    const dest = skillTarget(flags);
    installSkill(dest);
    console.log(`Installed skill to ${dest}`);
  },
  async init({ flags }) {
    const found = Object.values(AGENTS).filter((a) => fs.existsSync(a.home));
    if (!found.length) console.log('No supported agents found (Claude Code, Codex, OpenCode); use install-skill --dir <folder>.');
    for (const agent of found) {
      const dest = path.join(agent.home, agent.skills, 'audiofy');
      installSkill(dest);
      console.log(`✓ Skill installed for ${agent.label}: ${dest}`);
    }
    if (!flags['skip-models']) {
      const { installModel } = await import('./engines.js');
      await installModel('stt');
      await installModel('tts');
      await installModel('vad');
      console.log('✓ Speech models ready');
    }
    if (!flags['no-start']) {
      await ensureServer();
      console.log(`✓ Server running; overlay at ${BASE_URL}`);
    }
    console.log('\nDone. In your agent, say "voice mode" to start talking.');
  },
};

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  const run = commands[cmd];
  if (!run) throw new Error(`Unknown command "${cmd}". Run "audiofy help".`);
  await run(parseArgs(argv));
}

main().catch((err) => {
  console.error(`audiofy: ${err.message}`);
  process.exit(1);
});
