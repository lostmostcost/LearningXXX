import type { EngineOutput } from "./engine.ts";

/**
 * WBS-101: long audio is transcribed in windows of a few minutes, one engine
 * process each, so memory stays bounded and finished windows survive a pause,
 * a quit or a failure. Windows end at the quietest moment near the target
 * length, so a cut rarely falls inside a word.
 */

/** The engine's input format: 16 kHz, mono, 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;
/** Loudness is compared over 100 ms frames. */
const FRAME = SAMPLE_RATE / 10;

export interface WindowSettings {
  /** Target window length. */
  seconds: number;
  /** A cut may move this far either side of the target to find a quiet moment. */
  searchSeconds: number;
  /** A last piece shorter than this joins the window before it instead. */
  minTailSeconds: number;
}

/** A window in samples, end exclusive. */
export interface Window {
  start: number;
  end: number;
}

/** The PCM samples of a WAV file, wherever its `data` chunk is (afconvert may add other chunks first). */
export function wavSamples(file: Buffer): Int16Array {
  if (file.length < 12 || file.toString("ascii", 0, 4) !== "RIFF" || file.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let format: { channels: number; rate: number; bits: number } | undefined;
  while (at + 8 <= file.length) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") format = { channels: file.readUInt16LE(body + 2), rate: file.readUInt32LE(body + 4), bits: file.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!format || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) throw new Error("expected 16 kHz mono 16-bit WAV");
      const end = Math.min(file.length, body + size) - ((Math.min(file.length, body + size) - body) % 2);
      // A view when the samples are 2-byte aligned (no second copy of a long lecture); a copy otherwise.
      if ((file.byteOffset + body) % 2 === 0) return new Int16Array(file.buffer, file.byteOffset + body, (end - body) / 2);
      return new Int16Array(new Uint8Array(file.subarray(body, end)).buffer);
    }
    at = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** The middle of the quietest 100 ms frame in [from, to), as an absolute sample index. `offset` is where `pcm` starts. */
export function quietestPoint(pcm: Int16Array, from: number, to: number, offset = 0): number {
  let best = Math.round((from + to) / 2);
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let s = Math.max(from, offset); s + FRAME <= Math.min(to, offset + pcm.length); s += FRAME / 2) {
    let energy = 0;
    for (let i = s - offset; i < s - offset + FRAME; i += 1) energy += pcm[i]! * pcm[i]!;
    if (energy < bestEnergy) { bestEnergy = energy; best = s + FRAME / 2; }
  }
  return best;
}

/** Windows covering all of `pcm`, each cut at a quiet moment near the target length. */
export function planWindows(pcm: Int16Array, settings: WindowSettings): Window[] {
  const target = Math.round(settings.seconds * SAMPLE_RATE);
  const search = Math.round(settings.searchSeconds * SAMPLE_RATE);
  const minTail = Math.round(settings.minTailSeconds * SAMPLE_RATE);
  const windows: Window[] = [];
  let start = 0;
  while (pcm.length - start > target + minTail) {
    const cut = nextCut(pcm, start, target, search);
    windows.push({ start, end: cut });
    start = cut;
  }
  windows.push({ start, end: pcm.length });
  return windows;
}

/** Where the window starting at `start` should end; `pcm` must hold at least `start + target + search` samples. */
export function nextCut(pcm: Int16Array, start: number, target: number, search: number, offset = 0): number {
  const cut = quietestPoint(pcm, start + target - search, start + target + search, offset);
  // Never a zero-length window, whatever the search found.
  return Math.max(start + FRAME, cut);
}

/** One window's engine result, in seconds relative to the window. */
export interface WindowResult {
  /** Where the window starts in the whole audio, in seconds. */
  offsetSeconds: number;
  output: EngineOutput;
}

/** The windows' results as one result for the whole audio: text joined, word times shifted, in time order. */
export function mergeWindows(results: readonly WindowResult[]): EngineOutput {
  const ordered = results.toSorted((a, b) => a.offsetSeconds - b.offsetSeconds);
  return {
    language: ordered.find((r) => r.output.language)?.output.language ?? "Korean",
    text: ordered.map((r) => r.output.text.trim()).filter(Boolean).join(" "),
    words: ordered.flatMap((r) => r.output.words.map((w) => ({ text: w.text, start: w.start + r.offsetSeconds, end: w.end + r.offsetSeconds }))),
  };
}

/** A WAV file for one window of PCM samples. */
export function wavFile(samples: Int16Array): Buffer {
  const bytes = samples.length * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, bytes)]);
}
