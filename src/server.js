// Local audiofy server: keeps the speech models warm, serves the overlay, and
// brokers a single agent session's say/listen calls with the overlay's mic.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, BASE_URL, HOME_DIR, STATE_FILE, ensureDir } from './config.js';
import { transcribe, synthesize, speechSeconds, warmUp, VOICES, DEFAULT_VOICE } from './engines.js';
import { encodeWav, playWavNative, openUrl } from './audio.js';

const OVERLAY_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'overlay.html');
const MAX_BODY = 50 * 1024 * 1024;

const overlays = new Set(); // open SSE responses
const plays = new Map(); // id -> { wav, done(result) }
let listener = null; // { finish(result) } for the one pending listen call
let queued = null; // transcript spoken while nobody was listening
let speaking = false;
let lastMessage = '';
let lastTranscript = '';
let lastOpenAt = 0;
let lastTimeoutAt = 0; // when a listen last ended with no input

const log = (...args) => console.log(new Date().toISOString(), ...args);

function send(res, status, body, type = 'application/json') {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of overlays) res.write(line);
}

function pushState() {
  // `relisten`: the agent is just re-polling after a timeout, so the overlay
  // shouldn't chime again.
  const relisten = !!listener && Date.now() - lastTimeoutAt < 10_000;
  broadcast({ type: 'state', listening: !!listener, relisten, speaking, lastMessage, lastTranscript, queued: !!queued });
}

// Brings up the overlay if none is open, at most once a minute.
function ensureOverlay() {
  if (overlays.size || Date.now() - lastOpenAt < 60_000) return;
  if (process.env.AUDIOFY_NO_OPEN === '1') return;
  lastOpenAt = Date.now();
  log('No overlay connected; opening', BASE_URL);
  openUrl(BASE_URL);
}

// Plays through the overlay when one is open (so audio follows the browser's
// output device), otherwise through the OS player.
async function play(wav) {
  if (overlays.size) {
    const id = randomUUID();
    const result = await new Promise((done) => {
      plays.set(id, { wav, done });
      broadcast({ type: 'play', id });
      // A closed overlay never reports back; don't hang forever.
      setTimeout(() => done({ ok: false, error: 'overlay did not respond' }), 15_000 + wav.length / 48);
    });
    plays.delete(id);
    if (result.ok || result.skipped) return 'overlay';
    log('Overlay playback failed:', result.error, '- falling back to native');
  }
  await playWavNative(wav);
  return 'native';
}

async function handleSay(req, res) {
  const { text, voice = DEFAULT_VOICE, speed = 1 } = await readJson(req);
  if (!text || !String(text).trim()) return send(res, 400, { error: 'text is required' });
  if (!VOICES.includes(voice)) return send(res, 400, { error: `Unknown voice. Options: ${VOICES.join(', ')}` });
  const audio = await synthesize(String(text), { voice, speed: Number(speed) || 1 });
  const wav = encodeWav(audio.samples, audio.sampleRate);
  lastMessage = String(text);
  speaking = true;
  pushState();
  try {
    const via = await play(wav);
    send(res, 200, { ok: true, via });
  } finally {
    speaking = false;
    pushState();
  }
}

async function handleListen(req, res) {
  const { timeoutSec = 3600 } = await readJson(req);
  if (queued !== null) {
    const text = queued;
    queued = null;
    pushState();
    return send(res, 200, { text });
  }
  // Single session: a newer listen replaces an older one.
  listener?.finish({ text: null, reason: 'superseded' });
  ensureOverlay();
  let timer;
  const finish = (result) => {
    if (listener?.finish !== finish) return;
    clearTimeout(timer);
    listener = null;
    pushState();
    if (!res.writableEnded) send(res, 200, result);
  };
  listener = { finish };
  timer = setTimeout(() => {
    lastTimeoutAt = Date.now();
    finish({ text: null, reason: 'timeout' });
  }, Math.max(1, Number(timeoutSec)) * 1000);
  // The agent's command got killed or interrupted: stop waiting for it.
  res.on('close', () => finish({ text: null, reason: 'disconnected' }));
  pushState();
}

async function handleRecording(req, res, url) {
  const wav = await readBody(req);
  // Hands-free clips are cut by a rough in-browser detector; drop the ones
  // Silero says hold no real speech (coughs, typing, background noise).
  if (url.searchParams.get('handsfree') === '1') {
    const speech = await speechSeconds(wav);
    if (speech < 0.3) return send(res, 200, { text: '', delivered: false, rejected: true });
  }
  const text = await transcribe(wav);
  lastTranscript = text;
  let delivered = false;
  if (text) {
    if (listener) {
      listener.finish({ text });
      delivered = true;
    } else {
      queued = queued ? `${queued} ${text}` : text;
    }
  }
  pushState();
  send(res, 200, { text, delivered });
}

function handleEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  overlays.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    overlays.delete(res);
    // Closing or reloading the overlay mid-speech counts as skipping it.
    if (!overlays.size) for (const p of plays.values()) p.done({ skipped: true });
  });
  pushState();
}

const routes = {
  'GET /': (req, res) => send(res, 200, fs.readFileSync(OVERLAY_HTML), 'text/html; charset=utf-8'),
  'GET /events': handleEvents,
  'GET /api/status': (req, res) =>
    send(res, 200, { ok: true, pid: process.pid, overlays: overlays.size, listening: !!listener, queued: !!queued }),
  'POST /api/say': handleSay,
  'POST /api/listen': handleListen,
  'POST /api/recording': handleRecording,
  'POST /api/transcribe': async (req, res) => send(res, 200, { text: await transcribe(await readBody(req)) }),
  'POST /api/tts': async (req, res) => {
    const { text, voice = DEFAULT_VOICE, speed = 1 } = await readJson(req);
    if (!text) return send(res, 400, { error: 'text is required' });
    const audio = await synthesize(String(text), { voice, speed: Number(speed) || 1 });
    send(res, 200, encodeWav(audio.samples, audio.sampleRate), 'audio/wav');
  },
  'POST /api/ptt': (req, res) => {
    ensureOverlay();
    broadcast({ type: 'toggle' });
    send(res, 200, { ok: true, overlays: overlays.size });
  },
  'POST /api/shutdown': (req, res) => {
    send(res, 200, { ok: true });
    setTimeout(() => process.exit(0), 50);
  },
};

async function route(req, res) {
  const url = new URL(req.url, BASE_URL);
  const audio = url.pathname.match(/^\/api\/audio\/([\w-]+)$/);
  if (req.method === 'GET' && audio) {
    const p = plays.get(audio[1]);
    return p ? send(res, 200, p.wav, 'audio/wav') : send(res, 404, { error: 'unknown audio id' });
  }
  const played = url.pathname.match(/^\/api\/played\/([\w-]+)$/);
  if (req.method === 'POST' && played) {
    const result = await readJson(req);
    plays.get(played[1])?.done(result);
    return send(res, 200, { ok: true });
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (!handler) return send(res, 404, { error: 'not found' });
  await handler(req, res, url);
}

export function startServer({ open = true } = {}) {
  ensureDir(HOME_DIR);
  const server = http.createServer((req, res) => {
    // Only accept requests addressed to this machine (blocks DNS rebinding).
    const host = (req.headers.host || '').split(':')[0];
    if (host !== HOST && host !== 'localhost') return send(res, 403, { error: 'forbidden host' });
    route(req, res).catch((err) => {
      log('Error', req.method, req.url, err.message);
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
      else res.end();
    });
  });
  server.requestTimeout = 0; // listen calls are long-polls
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use (is audiofy already running?)` : err.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ pid: process.pid, port: PORT }));
    log(`audiofy listening on ${BASE_URL}`);
    warmUp((msg) => log(msg));
    if (open && process.env.AUDIOFY_NO_OPEN !== '1') {
      // Give an already-open overlay tab a moment to reconnect first.
      setTimeout(() => ensureOverlay(), 3000);
    }
  });
  const cleanup = () => {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (s.pid === process.pid) fs.rmSync(STATE_FILE, { force: true });
    } catch {}
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  return server;
}
