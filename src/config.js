// Shared paths, defaults and small parsing helpers.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME_DIR = process.env.AUDIOFY_HOME || path.join(os.homedir(), '.audiofy');
export const MODELS_DIR = path.join(HOME_DIR, 'models');
export const STATE_FILE = path.join(HOME_DIR, 'server.json');
export const LOG_FILE = path.join(HOME_DIR, 'server.log');

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.AUDIOFY_PORT || 7777);
export const BASE_URL = `http://${HOST}:${PORT}`;

export const DEFAULT_TIMEOUT_SEC = 3600;

// Accepts "3600", "3600s", "60m", "1h", "1.5h". Returns seconds or null.
export function parseDuration(value) {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  if (unit.startsWith('h')) return Math.round(n * 3600);
  if (unit.startsWith('m')) return Math.round(n * 60);
  return Math.round(n);
}

// Reads the first non-comment line of an audiofy.timeout file.
export function readTimeoutFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  const sec = parseDuration(line);
  if (!sec) throw new Error(`Invalid timeout in ${file}: "${line}"`);
  return sec;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
