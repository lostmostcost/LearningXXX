import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ErrorCode, TranscriptEngine } from "@learningxxx/contracts";
import type { AlignedWord } from "./segments.ts";
import { mergeWindows, planWindows, SAMPLE_RATE, wavFile, wavSamples, type WindowResult, type WindowSettings } from "./windows.ts";

/** A failure the queue can act on: retry it, or stop and say why. */
export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  /** WBS-101: what the engine itself said, shortened and without file paths; shown with the failed job. */
  readonly detail: string | undefined;
  constructor(code: ErrorCode, message: string, retryable: boolean, detail?: string) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
}

export interface EngineInput {
  /** Absolute path of the original (audio or video); it is only read. */
  audioPath: string;
  /** Course terms to bias recognition (ADR-003 step 1). */
  context: string;
  signal: AbortSignal;
  /** Real fraction of audio done; never called with made-up numbers. */
  onProgress: (fraction: number) => void;
  /** WBS-101: the original's content hash, when the caller knows it (a live recording may have done most of the work). */
  sourceSha256?: string;
}

export interface EngineOutput {
  language: string;
  text: string;
  words: AlignedWord[];
}

export interface Engine {
  readonly info: TranscriptEngine;
  /** What changes the output for the same audio; hashed into the idempotency key. */
  readonly parameters: Record<string, string>;
  transcribe(input: EngineInput): Promise<EngineOutput>;
}

export interface QwenEngineOptions {
  /** Python of the app's own virtual environment (services/transcriber/setup.sh). */
  python: string;
  /** services/transcriber/python/transcribe.py */
  script: string;
  /** Where model weights are cached (HF_HOME). */
  modelHome: string;
  /** Defaults by memory: 1.7B, or 0.6B on Macs with 8GB or less (ADR-003). */
  model?: string;
  runtimeVersion?: string;
  /**
   * WBS-101: finished windows are kept here (by content), so a paused, quit or
   * failed transcription continues from the last finished window. Without it,
   * windows are still used but nothing is kept between attempts.
   */
  partsRoot?: string | undefined;
  /** WBS-101: window length and cut search; see DEFAULT_WINDOW. */
  window?: Partial<WindowSettings>;
  /**
   * WBS-101: MLX buffer cache cap in MB for the engine process (negative = none).
   * Measured: 0 lowers the peak from 11.9 GB to 8.3 GB with the same speed and
   * output; what is left is the loaded model itself, the same for any window length.
   */
  cacheLimitMb?: number;
  /** For tests: runs one window WAV and returns the engine's result. */
  runWindow?: (wav: string, signal: AbortSignal, onProgress: (fraction: number) => void) => Promise<EngineOutput>;
}

export const RUNTIME_VERSION = "mlx-qwen3-asr-0.4.4";

/**
 * WBS-101 default, chosen by measurement (docs/qa/WBS-101-window-experiment.md):
 * windows of about five minutes, cut at the quietest moment within 8 seconds
 * of the target, and a last piece under 30 seconds joins the window before it.
 */
export const DEFAULT_WINDOW: WindowSettings = { seconds: 300, searchSeconds: 8, minTailSeconds: 30 };

export function defaultModel(memoryBytes = totalmem()): string {
  return memoryBytes <= 8 * 1024 ** 3 ? "Qwen/Qwen3-ASR-0.6B" : "Qwen/Qwen3-ASR-1.7B";
}

/** The end of the engine's error output, shortened, with file paths left out (they may name the student's folders). */
export function errorDetail(stderr: string): string | undefined {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const telling = lines.filter((l) => /error|exception|insufficient|memory|killed|abort|fail/i.test(l) && !/^warning/i.test(l));
  const line = telling.at(-1) ?? lines.at(-1);
  if (!line) return undefined;
  return line.replace(/(?:\/[^\s/'":,()]+)+\/?/g, "…").replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Qwen3-ASR through a separate Python process (ADR-003). The original is
 * first decoded to 16 kHz mono WAV with macOS's own `afconvert`, so neither
 * ffmpeg nor any system-wide package is needed; the WAV is deleted after.
 *
 * WBS-101: the audio is transcribed in windows of a few minutes, one process
 * each, so the engine's memory no longer grows with the length of the
 * lecture. Only one engine process runs at a time in the whole app (queued
 * files and live recordings share this gate).
 */
export class QwenEngine implements Engine {
  readonly info: TranscriptEngine;
  readonly parameters: Record<string, string>;
  readonly window: WindowSettings;
  readonly #o: QwenEngineOptions;
  readonly #model: string;
  #gate: Promise<unknown> = Promise.resolve();

  constructor(options: QwenEngineOptions) {
    this.#o = options;
    this.#model = options.model ?? defaultModel();
    this.window = { ...DEFAULT_WINDOW, ...options.window };
    this.info = { name: "qwen3-asr", version: `${this.#model.split("/").pop()}/${options.runtimeVersion ?? RUNTIME_VERSION}` };
    // Windows do not change what the transcript means, so they are not part of the parameters (existing jobs stay valid).
    this.parameters = { model: this.#model, language: "Korean", timestamps: "words" };
  }

  async transcribe({ audioPath, context, signal, onProgress }: EngineInput): Promise<EngineOutput> {
    const work = mkdtempSync(join(tmpdir(), "learningxxx-stt-"));
    try {
      const wav = join(work, "audio.wav");
      try {
        await promisify(execFile)("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", audioPath, wav], { signal, timeout: 30 * 60_000 });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new EngineError("MEDIA_UNREADABLE", "녹음 파일을 읽지 못했습니다. 파일이 손상됐거나 지원하지 않는 형식입니다.", false);
      }
      let pcm: Int16Array;
      try { pcm = wavSamples(readFileSync(wav)); } catch {
        throw new EngineError("MEDIA_UNREADABLE", "변환한 오디오를 읽지 못했습니다.", false);
      }
      rmSync(wav, { force: true });
      return await this.transcribeSamples(pcm, { context, signal, onProgress, work });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Transcribes 16 kHz mono samples window by window; finished windows are reused on the next attempt. */
  async transcribeSamples(pcm: Int16Array, { context, signal, onProgress, work }: { context: string; signal: AbortSignal; onProgress: (fraction: number) => void; work: string }): Promise<EngineOutput> {
    this.#prune();
    const windows = planWindows(pcm, this.window);
    const total = pcm.length || 1;
    const results: WindowResult[] = [];
    const used: string[] = [];
    let done = 0;
    for (const [i, w] of windows.entries()) {
      signal.throwIfAborted();
      const samples = pcm.subarray(w.start, w.end);
      const part = this.#partPath(samples, context);
      let output = part ? readPart(part) : undefined;
      if (!output) {
        const file = join(work, `window-${i}.wav`);
        writeFileSync(file, wavFile(samples));
        try {
          output = await this.transcribeWav(file, signal, (f) => onProgress(Math.min(1, (done + f * (w.end - w.start)) / total)), context);
        } finally { rmSync(file, { force: true }); }
        if (part) writePart(part, output);
      }
      if (part) used.push(part);
      results.push({ offsetSeconds: w.start / SAMPLE_RATE, output });
      done += w.end - w.start;
      onProgress(Math.min(1, done / total));
    }
    const merged = mergeWindows(results);
    // The whole result is about to be stored as a transcript; the pieces are no longer needed.
    for (const part of used) rmSync(part, { force: true });
    return merged;
  }

  /** One window (a WAV file the caller owns), through the app-wide gate: never two engine processes at once. */
  transcribeWav(wav: string, signal: AbortSignal, onProgress: (fraction: number) => void = () => {}, context = ""): Promise<EngineOutput> {
    const turn = this.#gate.then(() => {
      signal.throwIfAborted();
      return this.#o.runWindow ? this.#o.runWindow(wav, signal, onProgress) : this.#run(wav, context, signal, onProgress);
    });
    this.#gate = turn.catch(() => undefined);
    return turn;
  }

  /** Pieces of a transcription that was cancelled or removed and never finished are dropped after two weeks. */
  #prune(): void {
    if (!this.#o.partsRoot) return;
    const old = Date.now() - 14 * 24 * 3600_000;
    for (const name of readdirSafe(this.#o.partsRoot)) {
      const path = join(this.#o.partsRoot, name);
      try { if (statSync(path).mtimeMs < old) rmSync(path, { force: true }); } catch { /* already gone */ }
    }
  }

  #partPath(samples: Int16Array, context: string): string | undefined {
    if (!this.#o.partsRoot) return undefined;
    const hash = createHash("sha256").update(JSON.stringify({ ...this.parameters, engine: this.info, context })).update(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)).digest("hex");
    return join(this.#o.partsRoot, `${hash}.json`);
  }

  #run(wav: string, context: string, signal: AbortSignal, onProgress: (n: number) => void): Promise<EngineOutput> {
    return new Promise((resolve, reject) => {
      // -I: the script's folder and the current folder never shadow a module.
      const child = spawn(this.#o.python, ["-I", this.#o.script, "--wav", wav, "--model", this.#model, "--language", "Korean", "--context", context, "--cache-mb", String(this.#o.cacheLimitMb ?? 0)], {
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", HF_HOME: this.#o.modelHome, HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_OFFLINE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
        signal,
      });
      let result: EngineOutput | undefined;
      createInterface({ input: child.stdout }).on("line", (line) => {
        try {
          const event = JSON.parse(line) as { type?: string; value?: number; language?: string; text?: string; words?: AlignedWord[] };
          if (event.type === "progress" && typeof event.value === "number") onProgress(Math.min(1, Math.max(0, event.value)));
          if (event.type === "result") result = { language: event.language ?? "Korean", text: event.text ?? "", words: event.words ?? [] };
        } catch {
          // Not a protocol line; the exit code decides.
        }
      });
      // WBS-101: only the last few KB are kept, to say why it failed; never shown with paths.
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8192); });
      child.on("error", (error) => {
        if (signal.aborted) return reject(error);
        reject(new EngineError("ENGINE_UNAVAILABLE", "전사 엔진을 실행하지 못했습니다. 전사 엔진 설치가 필요합니다.", false));
      });
      child.on("close", (code, killed) => {
        if (signal.aborted) return reject(signal.reason ?? new Error("cancelled"));
        if (code === 0 && result) return resolve(result);
        if (code === 3) return reject(new EngineError("ENGINE_UNAVAILABLE", "전사 엔진을 불러오지 못했습니다. 전사 엔진 설치를 다시 실행하세요.", false, errorDetail(stderr)));
        if (code === 4) return reject(new EngineError("MEDIA_UNREADABLE", "변환한 오디오를 읽지 못했습니다.", false, errorDetail(stderr)));
        const detail = killed ? `엔진이 강제로 종료됐습니다(${killed}). 메모리가 부족했을 수 있습니다.` : errorDetail(stderr);
        const memory = Boolean(killed) || /memory|insufficient|out of memory/i.test(detail ?? "");
        reject(new EngineError("TRANSCRIBE_FAILED", memory ? "메모리가 부족해 전사하지 못했습니다. 다른 앱을 닫고 다시 시도하세요." : "전사 중 오류가 났습니다. 잠시 뒤 자동으로 다시 시도합니다.", true, detail));
      });
    });
  }
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function readPart(path: string): EngineOutput | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as EngineOutput;
    return typeof value.text === "string" && Array.isArray(value.words) ? value : undefined;
  } catch { return undefined; }
}

function writePart(path: string, output: EngineOutput): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(output), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
