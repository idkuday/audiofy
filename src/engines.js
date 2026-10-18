// Local speech engines (sherpa-onnx): Parakeet TDT for STT, Kokoro for TTS,
// Silero VAD to reject hands-free clips that contain no speech.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MODELS_DIR, ensureDir } from './config.js';
import { decodeWav } from './audio.js';

const require = createRequire(import.meta.url);
const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const MODELS = {
  stt: {
    name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    url: `${RELEASES}/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`,
    sizeMb: 465,
  },
  tts: {
    name: 'kokoro-multi-lang-v1_0',
    url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
    sizeMb: 334,
  },
  vad: {
    name: 'silero_vad.onnx',
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
    sizeMb: 2,
    file: true, // a single .onnx, not an archive
  },
};

// Speaker IDs baked into the Kokoro v1.0 model metadata.
const KOKORO_VOICES = (
  'af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky ' +
  'am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx am_puck am_santa ' +
  'bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis'
).split(' ');
export const DEFAULT_VOICE = 'af_heart';
export const VOICES = KOKORO_VOICES;

const threads = Number(process.env.AUDIOFY_THREADS) || Math.max(1, Math.min(8, Math.floor(os.cpus().length / 2)));

function modelDir(kind) {
  return path.join(MODELS_DIR, MODELS[kind].name);
}

export function isInstalled(kind) {
  return fs.existsSync(modelDir(kind));
}

// Downloads and unpacks a model archive. Uses the system `tar`, which reads
// .tar.bz2 on Linux, macOS and Windows 10+.
export async function installModel(kind, log = console.error) {
  if (isInstalled(kind)) return;
  const { name, url, sizeMb, file } = MODELS[kind];
  if (file) {
    ensureDir(MODELS_DIR);
    log(`Downloading ${name} (~${sizeMb} MB)...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
    const tmp = `${modelDir(kind)}.part`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, modelDir(kind));
    return;
  }
  // GNU tar (Linux) shells out to bzip2; bsdtar (macOS, Windows) has it built in.
  if (process.platform === 'linux' && spawnSync('bzip2', ['--help'], { stdio: 'ignore' }).error) {
    throw new Error('bzip2 is required to unpack models: install it (e.g. sudo apt install bzip2) and retry');
  }
  ensureDir(MODELS_DIR);
  const archive = `${name}.tar.bz2`;
  const archivePath = path.join(MODELS_DIR, archive);
  log(`Downloading ${name} (~${sizeMb} MB)...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archivePath));
  log(`Extracting ${archive}...`);
  // Relative archive path + cwd avoids GNU tar treating "C:" as a remote host.
  const r = spawnSync('tar', ['-xjf', archive], { cwd: MODELS_DIR, stdio: 'inherit' });
  fs.rmSync(archivePath, { force: true });
  if (r.status !== 0) throw new Error(`tar failed extracting ${archive}`);
}

let sherpa;
function lib() {
  sherpa ??= require('sherpa-onnx-node');
  return sherpa;
}

let recognizerPromise;
function recognizer() {
  recognizerPromise ??= (async () => {
    await installModel('stt');
    const dir = modelDir('stt');
    return lib().OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(dir, 'encoder.int8.onnx'),
          decoder: path.join(dir, 'decoder.int8.onnx'),
          joiner: path.join(dir, 'joiner.int8.onnx'),
        },
        tokens: path.join(dir, 'tokens.txt'),
        modelType: 'nemo_transducer',
        numThreads: threads,
        provider: 'cpu',
      },
      decodingMethod: 'greedy_search',
    });
  })();
  recognizerPromise.catch(() => { recognizerPromise = undefined; });
  return recognizerPromise;
}

let ttsPromise;
function tts() {
  ttsPromise ??= (async () => {
    await installModel('tts');
    const dir = modelDir('tts');
    return lib().OfflineTts.createAsync({
      model: {
        kokoro: {
          model: path.join(dir, 'model.onnx'),
          voices: path.join(dir, 'voices.bin'),
          tokens: path.join(dir, 'tokens.txt'),
          dataDir: path.join(dir, 'espeak-ng-data'),
          lexicon: [path.join(dir, 'lexicon-us-en.txt'), path.join(dir, 'lexicon-zh.txt')].join(','),
        },
        numThreads: threads,
        provider: 'cpu',
      },
      maxNumSentences: 1,
    });
  })();
  ttsPromise.catch(() => { ttsPromise = undefined; });
  return ttsPromise;
}

let vadPromise;
function vad() {
  vadPromise ??= (async () => {
    await installModel('vad');
    return new (lib().Vad)(
      {
        sileroVad: { model: modelDir('vad'), threshold: 0.5, minSilenceDuration: 0.3, minSpeechDuration: 0.25, windowSize: 512 },
        sampleRate: 16000,
        numThreads: 1,
        provider: 'cpu',
      },
      120,
    );
  })();
  vadPromise.catch(() => { vadPromise = undefined; });
  return vadPromise;
}

// Linear resampling is plenty for voice-activity decisions.
function resample(samples, from, to) {
  if (from === to) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const k = Math.min(j + 1, samples.length - 1);
    out[i] = samples[j] + (samples[k] - samples[j]) * (x - j);
  }
  return out;
}

// Seconds of speech Silero finds in a WAV clip.
export async function speechSeconds(wav) {
  const detector = await vad();
  const { samples, sampleRate } = decodeWav(wav);
  const pcm = resample(samples, sampleRate, 16000);
  detector.reset();
  for (let i = 0; i + 512 <= pcm.length; i += 512) detector.acceptWaveform(pcm.subarray(i, i + 512));
  detector.flush();
  let total = 0;
  while (!detector.isEmpty()) {
    total += detector.front(false).samples.length;
    detector.pop();
  }
  return total / 16000;
}

// Starts loading both engines without waiting, so the first request is fast.
export function warmUp(log = console.error) {
  recognizer().catch((e) => log(`STT load failed: ${e.message}`));
  tts().catch((e) => log(`TTS load failed: ${e.message}`));
  vad().catch((e) => log(`VAD load failed: ${e.message}`));
}

// wav: Buffer of a WAV file at any sample rate (sherpa-onnx resamples).
export async function transcribe(wav) {
  const rec = await recognizer();
  const wave = decodeWav(wav);
  const stream = rec.createStream();
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate });
  const result = await rec.decodeAsync(stream);
  return result.text.trim();
}

// Returns { samples: Float32Array, sampleRate }.
export async function synthesize(text, { voice = DEFAULT_VOICE, speed = 1.0 } = {}) {
  const engine = await tts();
  const sid = Math.max(0, KOKORO_VOICES.indexOf(voice));
  const audio = await engine.generateAsync({ text, sid, speed });
  return { samples: audio.samples, sampleRate: audio.sampleRate };
}
