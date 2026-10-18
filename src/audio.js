// WAV encoding and OS-level helpers (native playback, opening a browser).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Float32 samples in [-1, 1] -> 16-bit mono PCM WAV.
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

// WAV (PCM 8/16/24/32-bit or float32, any channel count) -> mono Float32.
export function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file (convert to .wav first, e.g. with ffmpeg)');
  }
  let fmt;
  let data;
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
      if (fmt.format === 0xfffe) fmt.format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    off = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt or data chunk');
  const { format, channels, sampleRate, bits } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const read =
    format === 3 && bits === 32 ? (o) => data.readFloatLE(o)
    : format === 1 && bits === 16 ? (o) => data.readInt16LE(o) / 0x8000
    : format === 1 && bits === 24 ? (o) => data.readIntLE(o, 3) / 0x800000
    : format === 1 && bits === 32 ? (o) => data.readInt32LE(o) / 0x80000000
    : format === 1 && bits === 8 ? (o) => (data.readUInt8(o) - 128) / 128
    : null;
  if (!read) throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read((i * channels + c) * bytes);
    samples[i] = sum / channels;
  }
  return { samples, sampleRate };
}

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { stdio: 'ignore' }).status === 0;
}

// Picks a command line that plays a WAV file on this OS, or null.
function playerFor(file) {
  if (process.platform === 'win32') {
    const ps = `(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`;
    return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]];
  }
  if (process.platform === 'darwin') return ['afplay', [file]];
  const candidates = [
    ['pw-play', [file]],
    ['paplay', [file]],
    ['aplay', ['-q', file]],
    ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]],
  ];
  return candidates.find(([cmd]) => hasCommand(cmd)) || null;
}

// Plays WAV bytes through the OS audio stack. Resolves when playback ends.
export function playWavNative(wav) {
  const file = path.join(os.tmpdir(), `audiofy-${process.pid}-${Date.now()}.wav`);
  fs.writeFileSync(file, wav);
  const player = playerFor(file);
  if (!player) {
    fs.rmSync(file, { force: true });
    return Promise.reject(new Error('No audio player found (install pipewire, pulseaudio-utils, alsa-utils or ffmpeg)'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(player[0], player[1], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => {
      fs.rmSync(file, { force: true });
      code === 0 ? resolve() : reject(new Error(`${player[0]} exited with code ${code}`));
    });
  });
}

export function openUrl(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
