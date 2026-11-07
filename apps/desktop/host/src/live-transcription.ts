import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mergeWindows, nextCut, SAMPLE_RATE, wavFile, type EngineOutput, type WindowSettings } from "@learningxxx/transcriber";

/**
 * WBS-101: transcription while the lecture is still being recorded. Every
 * time the recording grows by one window (a few minutes), that window is cut
 * at a quiet moment, copied aside and transcribed. When the recording stops,
 * only the rest is left to do, so the transcript is ready soon after class
 * instead of an hour later, and no single engine run holds a whole lecture.
 *
 * Everything is kept on disk per recording (a manifest, the waiting window
 * WAVs and each finished window's result), so a quit or crash continues where
 * it was. The transcription queue still owns the transcript: when it reaches
 * the original made from this recording, it takes the finished windows here
 * instead of transcribing the whole file again (see `take`).
 */

interface LiveWindow {
  index: number;
  /** Samples from the start of the recording; end exclusive. */
  start: number;
  end: number;
  state: "pending" | "done" | "failed";
}

interface Manifest {
  recordingId: string;
  /** Where the next window starts (samples). */
  cut: number;
  windows: LiveWindow[];
  /** Set when the recording stopped: the original's content hash and full length. */
  final?: { sha256: string; samples: number };
}

export interface LiveTranscriptionOptions {
  /** e.g. <data>/media/live */
  root: string;
  window: WindowSettings;
  /** One window WAV → engine result (through the app's one-at-a-time engine gate). */
  transcribe: (wav: string, signal: AbortSignal, onProgress: (fraction: number) => void, context: string) => Promise<EngineOutput>;
  /** Course terms for the engine, the same the queue would give the original (ADR-003 step 1). */
  contextFor?: (recordingId: string) => Promise<string>;
  /** False while transcription is paused, turned off, or the engine is not ready: windows are cut but wait. */
  enabled: () => boolean;
  /** After a failed window, wait this long before trying again on our own (the queue may still force it). */
  retryAfterMs?: number;
  now?: () => number;
}

const BYTES_PER_SAMPLE = 2;

export class LiveTranscription {
  readonly #o: LiveTranscriptionOptions;
  readonly #manifests = new Map<string, Manifest>();
  readonly #work = new Map<string, Promise<void>>();
  readonly #failedAt = new Map<string, number>();
  readonly #shutdown = new AbortController();

  constructor(options: LiveTranscriptionOptions) {
    this.#o = options;
    for (const id of safeList(options.root)) {
      try {
        const m = JSON.parse(readFileSync(join(options.root, id, "manifest.json"), "utf8")) as Manifest;
        if (m.recordingId === id && Array.isArray(m.windows)) this.#manifests.set(id, m);
      } catch { /* unreadable: left alone, pruned with orphans */ }
    }
  }

  #dir(id: string) { return join(this.#o.root, id); }

  #save(m: Manifest): void {
    mkdirSync(this.#dir(m.recordingId), { recursive: true });
    const file = join(this.#dir(m.recordingId), "manifest.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(m), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** Samples [from, to) of the recording's PCM file. */
  static #read(pcmPath: string, from: number, to: number): Int16Array {
    const bytes = Buffer.alloc((to - from) * BYTES_PER_SAMPLE);
    const fd = openSync(pcmPath, "r");
    try { readSync(fd, bytes, 0, bytes.length, from * BYTES_PER_SAMPLE); } finally { closeSync(fd); }
    return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / BYTES_PER_SAMPLE);
  }

  #addWindow(m: Manifest, pcmPath: string, end: number): void {
    const index = m.windows.length;
    writeFileSync(join(this.#dir(m.recordingId), `w${index}.wav`), wavFile(LiveTranscription.#read(pcmPath, m.cut, end)), { mode: 0o600 });
    m.windows.push({ index, start: m.cut, end, state: "pending" });
    m.cut = end;
  }

  /** After every saved chunk; cheap unless a window has filled up. */
  chunkSaved(recordingId: string, pcmPath: string, pcmBytes: number): void {
    const target = Math.round(this.#o.window.seconds * SAMPLE_RATE);
    const search = Math.round(this.#o.window.searchSeconds * SAMPLE_RATE);
    const available = Math.floor(pcmBytes / BYTES_PER_SAMPLE);
    let m = this.#manifests.get(recordingId);
    const start = m?.cut ?? 0;
    if (available < start + target + search) { if (m) this.#kick(recordingId); return; }
    if (!m) { m = { recordingId, cut: 0, windows: [] }; this.#manifests.set(recordingId, m); mkdirSync(this.#dir(recordingId), { recursive: true }); }
    if (m.final) return;
    while (available >= m.cut + target + search) {
      const from = m.cut + target - search, to = m.cut + target + search;
      this.#addWindow(m, pcmPath, nextCut(LiveTranscription.#read(pcmPath, from, to), m.cut, target, search, from));
    }
    this.#save(m);
    this.#kick(recordingId);
  }

  /**
   * The recording stopped (or was recovered after a crash) and its original
   * has this content hash. The rest of the audio becomes the last window. A
   * short recording that never filled a window is left to the queue.
   */
  finish(recordingId: string, pcmPath: string, pcmBytes: number, sha256: string): void {
    const m = this.#manifests.get(recordingId);
    if (!m || m.final) return;
    const samples = Math.floor(pcmBytes / BYTES_PER_SAMPLE);
    if (samples > m.cut) this.#addWindow(m, pcmPath, samples);
    m.final = { sha256, samples };
    this.#save(m);
    this.#kick(recordingId);
  }

  /** The recording produced nothing (or is gone): drop its live work. */
  discard(recordingId: string): void {
    this.#manifests.delete(recordingId);
    rmSync(this.#dir(recordingId), { recursive: true, force: true });
  }

  /** How much of the recording, from the start without gaps, already has a transcript (for the recording screen). */
  transcribedMs(recordingId: string): number {
    const m = this.#manifests.get(recordingId);
    let end = 0;
    for (const w of m?.windows ?? []) { if (w.state !== "done") break; end = w.end; }
    return Math.floor((end / SAMPLE_RATE) * 1000);
  }

  /**
   * At start, after crashed recordings were recovered: live work of a
   * recording that is no longer recording and never finished, or whose
   * original is gone, is removed; the rest continues.
   */
  prune(isRecording: (recordingId: string) => boolean, hasOriginal: (sha256: string) => boolean): void {
    // A finished recording whose transcription was cancelled and never retried is dropped after two weeks.
    const stale = (id: string) => { try { return statSync(join(this.#dir(id), "manifest.json")).mtimeMs < (this.#o.now ?? Date.now)() - 14 * 24 * 3600_000; } catch { return true; } };
    for (const [id, m] of [...this.#manifests]) {
      if (m.final ? !hasOriginal(m.final.sha256) || stale(id) : !isRecording(id)) this.discard(id);
      else if (m.final) this.#kick(id);
    }
  }

  /** Starts the waiting windows of one recording if allowed now; one loop per recording. */
  #kick(recordingId: string): void {
    if (this.#work.has(recordingId) || !this.#o.enabled()) return;
    const failed = this.#failedAt.get(recordingId);
    if (failed !== undefined && (this.#o.now ?? Date.now)() - failed < (this.#o.retryAfterMs ?? 5 * 60_000)) return;
    const work = this.#process(recordingId, false, this.#shutdown.signal, () => {}).catch(() => undefined).finally(() => this.#work.delete(recordingId));
    this.#work.set(recordingId, work);
  }

  async #process(recordingId: string, force: boolean, signal: AbortSignal, onProgress: (done: number, total: number) => void): Promise<void> {
    const m = this.#manifests.get(recordingId);
    if (!m) return;
    const total = m.final?.samples ?? m.cut;
    const context = (await this.#o.contextFor?.(recordingId).catch(() => "")) ?? "";
    for (const w of m.windows) {
      const doneSoFar = m.windows.filter((x) => x.state === "done").reduce((s, x) => s + x.end - x.start, 0);
      if (w.state === "done") continue;
      if (!force && !this.#o.enabled()) return;
      signal.throwIfAborted();
      const wav = join(this.#dir(recordingId), `w${w.index}.wav`);
      try {
        const output = await this.#o.transcribe(wav, signal, (f) => onProgress(doneSoFar + f * (w.end - w.start), total), context);
        writeFileSync(join(this.#dir(recordingId), `w${w.index}.json`), JSON.stringify(output), { mode: 0o600 });
        rmSync(wav, { force: true });
        w.state = "done";
        this.#failedAt.delete(recordingId);
      } catch (error) {
        if (!signal.aborted) { w.state = "failed"; this.#failedAt.set(recordingId, (this.#o.now ?? Date.now)()); }
        if (this.#manifests.get(recordingId) === m) this.#save(m);
        throw error;
      }
      if (this.#manifests.get(recordingId) !== m) return; // discarded meanwhile
      this.#save(m);
      onProgress(doneSoFar + w.end - w.start, total);
    }
  }

  /**
   * For the transcription queue: the whole engine result for the original
   * with this content hash, if it came from a live recording. Waits for any
   * window in progress, transcribes what is left (even while live work is
   * held back), merges, and removes the live work. Undefined when the
   * original did not come from a live recording, or its work is unusable.
   */
  async take(sha256: string, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<EngineOutput | undefined> {
    const entry = [...this.#manifests.values()].find((m) => m.final?.sha256 === sha256);
    if (!entry) return undefined;
    const id = entry.recordingId;
    await this.#work.get(id)?.catch(() => undefined);
    const m = this.#manifests.get(id);
    if (!m?.final) return undefined;
    // A waiting window's WAV must exist; if not (damaged folder), the queue transcribes the original instead.
    if (m.windows.some((w) => w.state !== "done" && !existsSync(join(this.#dir(id), `w${w.index}.wav`)))) { this.discard(id); return undefined; }
    const running = this.#process(id, true, signal, (done, total) => onProgress(Math.min(1, done / Math.max(1, total))));
    this.#work.set(id, running.catch(() => undefined).finally(() => this.#work.delete(id)));
    await running;
    const results = [];
    for (const w of m.windows) {
      try {
        results.push({ offsetSeconds: w.start / SAMPLE_RATE, output: JSON.parse(readFileSync(join(this.#dir(id), `w${w.index}.json`), "utf8")) as EngineOutput });
      } catch { this.discard(id); return undefined; }
    }
    const merged = mergeWindows(results);
    this.discard(id);
    onProgress(1);
    return merged;
  }

  /** App quitting: the window in progress stops; it runs again next time. */
  async stop(): Promise<void> {
    this.#shutdown.abort("shutdown");
    await Promise.allSettled([...this.#work.values()]);
  }
}

function safeList(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
