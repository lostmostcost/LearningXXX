import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ErrorCode, TranscriptEngine } from "@learningxxx/contracts";
import type { AlignedWord } from "./segments.ts";

/** A failure the queue can act on: retry it, or stop and say why. */
export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
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
}

export const RUNTIME_VERSION = "mlx-qwen3-asr-0.4.4";

export function defaultModel(memoryBytes = totalmem()): string {
  return memoryBytes <= 8 * 1024 ** 3 ? "Qwen/Qwen3-ASR-0.6B" : "Qwen/Qwen3-ASR-1.7B";
}

/**
 * Qwen3-ASR through a separate Python process (ADR-003). The original is
 * first decoded to 16 kHz mono WAV with macOS's own `afconvert`, so neither
 * ffmpeg nor any system-wide package is needed; the WAV is deleted after.
 */
export class QwenEngine implements Engine {
  readonly info: TranscriptEngine;
  readonly parameters: Record<string, string>;
  readonly #o: QwenEngineOptions;
  readonly #model: string;

  constructor(options: QwenEngineOptions) {
    this.#o = options;
    this.#model = options.model ?? defaultModel();
    this.info = { name: "qwen3-asr", version: `${this.#model.split("/").pop()}/${options.runtimeVersion ?? RUNTIME_VERSION}` };
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
      return await this.#run(wav, context, signal, onProgress);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  #run(wav: string, context: string, signal: AbortSignal, onProgress: (n: number) => void): Promise<EngineOutput> {
    return new Promise((resolve, reject) => {
      // -I: the script's folder and the current folder never shadow a module.
      const child = spawn(this.#o.python, ["-I", this.#o.script, "--wav", wav, "--model", this.#model, "--language", "Korean", "--context", context], {
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
      // Library warnings only; drained so the pipe never fills, never shown (they may quote paths).
      child.stderr.resume();
      child.on("error", (error) => {
        if (signal.aborted) return reject(error);
        reject(new EngineError("ENGINE_UNAVAILABLE", "전사 엔진을 실행하지 못했습니다. 전사 엔진 설치가 필요합니다.", false));
      });
      child.on("close", (code) => {
        if (signal.aborted) return reject(signal.reason ?? new Error("cancelled"));
        if (code === 0 && result) return resolve(result);
        if (code === 3) return reject(new EngineError("ENGINE_UNAVAILABLE", "전사 엔진을 불러오지 못했습니다. 전사 엔진 설치를 다시 실행하세요.", false));
        if (code === 4) return reject(new EngineError("MEDIA_UNREADABLE", "변환한 오디오를 읽지 못했습니다.", false));
        reject(new EngineError("TRANSCRIBE_FAILED", "전사 중 오류가 났습니다. 잠시 뒤 자동으로 다시 시도합니다.", true));
      });
    });
  }
}
