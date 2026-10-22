/**
 * Reproduce the public demo rhythm from oscillators and seeded noise only.
 * No recordings, samples, third-party composition or teacher media are read.
 * The script is GPL-3.0-only; its synthesized audio is dedicated under CC0-1.0.
 * @author ahui
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../resources/music/', import.meta.url);
const sampleRate = 44_100;
const bpm = 100;
const totalBeats = 64;
const beatSeconds = 60 / bpm;
const samples = new Float64Array(Math.round(totalBeats * beatSeconds * sampleRate));
let noiseSeed = 0x45434701;
/** Fixed integer noise makes every rebuild byte-identical without sampled audio. */
function noise() {
  noiseSeed ^= noiseSeed << 13;
  noiseSeed ^= noiseSeed >>> 17;
  noiseSeed ^= noiseSeed << 5;
  return ((noiseSeed >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Add one bounded voice; all releases fit before the next beat/loop boundary.
 * @param {number} beat Zero-based start measured in original music beats.
 * @param {number} duration Duration in seconds, never a classroom timing source.
 * @param {(seconds:number)=>number} voice Sample amplitude as a function of seconds.
 */
function add(beat, duration, voice) {
  const first = Math.round(beat * beatSeconds * sampleRate);
  const end = Math.min(samples.length, first + Math.round(duration * sampleRate));
  for (let i = first; i < end; i++) {
    const t = (i - first) / sampleRate;
    // Short attack/release avoids PCM steps; it does not postpone the beat grid.
    const edge = Math.min(1, t / 0.002, (end - i) / (sampleRate * 0.006));
    samples[i] += voice(t) * edge;
  }
}

// Four-bar harmonic pattern and a modest drum pulse leave spoken words audible.
const roots = [130.81278265, 174.61411572, 146.83238396, 195.99771799];
for (let beat = 0; beat < totalBeats; beat++) {
  const root = roots[Math.floor(beat / 4) % roots.length];
  add(
    beat,
    0.22,
    (t) =>
      0.3 * Math.sin(2 * Math.PI * (52 * t + 0.9 * (1 - Math.exp(-30 * t)))) * Math.exp(-22 * t),
  );
  if (beat % 4 === 1 || beat % 4 === 3)
    add(
      beat,
      0.12,
      (t) => (noise() * 0.095 + Math.sin(2 * Math.PI * 180 * t) * 0.025) * Math.exp(-35 * t),
    );
  add(beat, 0.42, (t) => 0.1 * Math.sin(2 * Math.PI * root * t) * Math.exp(-7 * t));
  for (const offset of [0, 0.5]) {
    add(beat + offset, 0.045, (t) => noise() * 0.027 * Math.exp(-90 * t));
    const note = root * [2, 2.5, 3, 2.5][beat % 4];
    add(
      beat + offset,
      0.2,
      (t) =>
        (Math.sin(2 * Math.PI * note * t) + 0.18 * Math.sin(4 * Math.PI * note * t)) *
        0.034 *
        Math.exp(-15 * t),
    );
  }
}
const wav = Buffer.alloc(44 + samples.length * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples.length * 2, 40);
let peak = 0;
for (const value of samples) peak = Math.max(peak, Math.abs(value));
for (let i = 0; i < samples.length; i++)
  wav.writeInt16LE(Math.round((samples[i] / peak) * 0.7 * 32767), 44 + i * 2);
const info = {
  name: '课堂律动 · 首发背景音乐',
  author: 'ahui',
  license: 'CC0-1.0',
  generator: 'scripts/build-builtin-music.mjs',
  sampleRate,
  channels: 1,
  bitsPerSample: 16,
  bpm,
  totalBeats,
  firstBeatMs: 0,
  loopStartMs: 0,
  loopEndMs: (samples.length / sampleRate) * 1000,
  bytes: wav.length,
  sha256: createHash('sha256').update(wav).digest('hex'),
};
await mkdir(output, { recursive: true });
await writeFile(new URL('word-beat-bgm.wav', output), wav);
await writeFile(new URL('source.json', output), JSON.stringify(info, null, 2) + '\n');
console.log(JSON.stringify(info));
