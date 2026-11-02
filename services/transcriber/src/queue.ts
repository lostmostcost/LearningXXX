import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MediaAsset,
  SCHEMA_VERSION,
  Transcript,
  TranscriptionJob,
  canonicalParameters,
  transcriptionKeyInput,
} from "@learningxxx/contracts";
import type { ErrorCode } from "@learningxxx/contracts";
import { EngineError, type Engine } from "./engine.ts";
import { buildSegments } from "./segments.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Entry {
  job: TranscriptionJob;
  asset: MediaAsset;
  /** Fixed when the job is created, so a re-run after a crash rewrites the same transcript. */
  transcriptId: string;
}

export interface QueueOptions {
  /** Folder for jobs.json and transcripts/, e.g. <data>/transcription. */
  root: string;
  engine: Engine;
  /** Absolute path of a stored original; only read. */
  pathOf: (asset: MediaAsset) => string;
  /** Course terms for the engine (ADR-003 step 1); empty when none. */
  contextFor?: (asset: MediaAsset) => Promise<string>;
  onChange?: (job: TranscriptionJob) => void;
  now?: () => Date;
  newId?: () => string;
  /** A running job not renewed within this time is taken to be abandoned. */
  leaseMs?: number;
  maxAttempts?: number;
  /** Wait before attempt 2, 3, … after a retryable failure. */
  retryDelaysMs?: readonly number[];
}

const DEFAULT_LEASE_MS = 10 * 60_000;

/**
 * SPEC-004 transcription queue (WBS-025). One job runs at a time, in the
 * order they came. The same source, engine and parameters never make a
 * second job. A crash leaves a running job whose lease runs out, and it is
 * picked up again. Each finished job keeps its own transcript version. It
 * never starts a summary.
 */
export class TranscriptionQueue {
  readonly #o: QueueOptions;
  readonly #file: string;
  readonly #entries: Entry[];
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  /** Queued jobs waiting out a retry delay: job id → earliest start (ms). */
  readonly #holdUntil = new Map<string, number>();
  #running: { jobId: string; abort: AbortController; done: Promise<void> } | undefined;
  #started = false;

  constructor(options: QueueOptions) {
    this.#o = options;
    this.#file = join(options.root, "jobs.json");
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#entries = this.#load();
  }

  #stamp(): string {
    return this.#now().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  #load(): Entry[] {
    if (!existsSync(this.#file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as { entries?: unknown[] };
      return (raw.entries ?? []).flatMap((e) => {
        const entry = e as Entry;
        const job = TranscriptionJob.safeParse(entry.job);
        const asset = MediaAsset.safeParse(entry.asset);
        return job.success && asset.success ? [{ job: job.data, asset: asset.data, transcriptId: String(entry.transcriptId) }] : [];
      });
    } catch {
      // Keep the unreadable file for recovery rather than overwrite it.
      renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      return [];
    }
  }

  #save(): void {
    mkdirSync(this.#o.root, { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify({ entries: this.#entries }));
    renameSync(temp, this.#file);
  }

  #update(jobId: string, patch: Partial<TranscriptionJob>, drop: (keyof TranscriptionJob)[] = []): TranscriptionJob {
    const entry = this.#entries.find((e) => e.job.id === jobId)!;
    const next: Record<string, unknown> = { ...entry.job, ...patch, updatedAt: this.#stamp() };
    for (const key of drop) delete next[key];
    entry.job = TranscriptionJob.parse(next);
    this.#save();
    this.#o.onChange?.(entry.job);
    return entry.job;
  }

  get parametersHash(): string {
    return sha256(canonicalParameters(this.#o.engine.parameters));
  }

  jobs(): TranscriptionJob[] {
    return this.#entries.map((e) => e.job);
  }

  job(jobId: string): TranscriptionJob | undefined {
    return this.#entries.find((e) => e.job.id === jobId)?.job;
  }

  transcript(transcriptId: string): Transcript | undefined {
    const file = join(this.#o.root, "transcripts", `${transcriptId}.json`);
    if (!/^[0-9a-f-]{36}$/.test(transcriptId) || !existsSync(file)) return undefined;
    const parsed = Transcript.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : undefined;
  }

  /**
   * Queues an original for transcription, or returns the job that already
   * covers it. Called whenever an original is confirmed, and again for every
   * original on startup, so nothing made while the app was closed is missed.
   */
  enqueue(asset: MediaAsset): TranscriptionJob {
    const valid = MediaAsset.parse(asset);
    const parametersHash = this.parametersHash;
    const idempotencyKey = sha256(transcriptionKeyInput(valid.sha256, this.#o.engine.info, parametersHash));
    const existing = this.#entries.find((e) => e.job.idempotencyKey === idempotencyKey);
    if (existing) return existing.job;
    const stamp = this.#stamp();
    const job = TranscriptionJob.parse({
      schemaVersion: SCHEMA_VERSION,
      id: this.#newId(),
      sourceAssetId: valid.id,
      engine: this.#o.engine.info,
      parametersHash,
      idempotencyKey,
      status: "queued",
      attempt: 0,
      createdAt: stamp,
      updatedAt: stamp,
    });
    this.#entries.push({ job, asset: valid, transcriptId: this.#newId() });
    this.#save();
    this.#o.onChange?.(job);
    this.#kick();
    return job;
  }

  /** A queued job stops before it starts; a running one is stopped. Its original stays. */
  async cancel(jobId: string): Promise<TranscriptionJob> {
    const job = this.job(jobId);
    if (!job) throw new Error("job not found");
    if (job.status === "queued") return this.#update(jobId, { status: "cancelled" }, ["progress"]);
    if (job.status === "running" && this.#running?.jobId === jobId) {
      this.#running.abort.abort();
      await this.#running.done;
    }
    return this.job(jobId)!;
  }

  /** The user asks again after a failure or cancel: same job, same transcript slot. */
  retry(jobId: string): TranscriptionJob {
    const job = this.job(jobId);
    if (!job) throw new Error("job not found");
    if (job.status !== "failed" && job.status !== "cancelled") return job;
    const next = this.#update(jobId, { status: "queued" }, ["errorCode", "progress"]);
    this.#holdUntil.delete(jobId);
    this.#kick();
    return next;
  }

  /**
   * Begins work. A job left `running` by a previous process is queued again
   * once its lease has run out (immediately if it already has).
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const { job } of this.#entries) {
      if (job.status !== "running") continue;
      const wait = Date.parse(job.leaseExpiresAt!) - this.#now().getTime();
      const requeue = () => {
        if (this.job(job.id)?.status !== "running" || this.#running?.jobId === job.id) return;
        this.#update(job.id, { status: "queued" }, ["leaseExpiresAt", "progress"]);
        this.#kick();
      };
      if (wait <= 0) requeue();
      else this.#later(requeue, wait);
    }
    this.#kick();
  }

  /** Stops taking work and waits for the running job to be cut off (it is picked up next time). */
  async stop(): Promise<void> {
    this.#started = false;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    const running = this.#running;
    if (running) {
      running.abort.abort("shutdown");
      await running.done;
    }
  }

  #later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    t.unref(); // never keeps the app (or a test) alive on its own
    this.#timers.add(t);
  }

  #kick(): void {
    if (!this.#started || this.#running) return;
    const now = this.#now().getTime();
    const next = this.#entries.find((e) => e.job.status === "queued" && (this.#holdUntil.get(e.job.id) ?? 0) <= now);
    if (!next) return;
    const abort = new AbortController();
    const done = this.#process(next, abort).finally(() => {
      this.#running = undefined;
      this.#kick();
    });
    this.#running = { jobId: next.job.id, abort, done };
  }

  async #process(entry: Entry, abort: AbortController): Promise<void> {
    const leaseMs = this.#o.leaseMs ?? DEFAULT_LEASE_MS;
    const lease = () => new Date(this.#now().getTime() + leaseMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const jobId = entry.job.id;
    this.#update(jobId, { status: "running", attempt: entry.job.attempt + 1, leaseExpiresAt: lease() }, ["progress"]);
    const renew = setInterval(() => this.#update(jobId, { leaseExpiresAt: lease() }), Math.max(1000, leaseMs / 3));
    renew.unref();
    try {
      const context = (await this.#o.contextFor?.(entry.asset).catch(() => "")) ?? "";
      const output = await this.#o.engine.transcribe({
        audioPath: this.#o.pathOf(entry.asset),
        context,
        signal: abort.signal,
        onProgress: (progress) => {
          entry.job = TranscriptionJob.parse({ ...entry.job, progress });
          this.#o.onChange?.(entry.job);
        },
      });
      const transcript = Transcript.parse({
        schemaVersion: SCHEMA_VERSION,
        id: entry.transcriptId,
        sourceAssetId: entry.asset.id,
        kind: "engine",
        engine: entry.job.engine,
        parametersHash: entry.job.parametersHash,
        language: output.language === "Korean" ? "ko" : output.language.slice(0, 16) || "ko",
        createdAt: this.#stamp(),
        segments: buildSegments(output.text, output.words),
      });
      const dir = join(this.#o.root, "transcripts");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${transcript.id}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(transcript));
      renameSync(`${file}.tmp`, file);
      this.#update(jobId, { status: "succeeded", progress: 1, outputTranscriptId: transcript.id }, ["leaseExpiresAt", "errorCode"]);
    } catch (error) {
      if (abort.signal.aborted) {
        // Shutdown leaves it running: the lease brings it back next start. A user cancel ends it.
        if (abort.signal.reason !== "shutdown") this.#update(jobId, { status: "cancelled" }, ["leaseExpiresAt", "progress"]);
        return;
      }
      const engineError = error instanceof EngineError ? error : new EngineError("TRANSCRIBE_FAILED", "전사 중 오류가 났습니다.", true);
      const attempt = this.job(jobId)!.attempt;
      if (engineError.retryable && attempt < (this.#o.maxAttempts ?? 3)) {
        this.#update(jobId, { status: "queued" }, ["leaseExpiresAt", "progress"]);
        const delays = this.#o.retryDelaysMs ?? [30_000, 120_000];
        const delay = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
        this.#holdUntil.set(jobId, this.#now().getTime() + delay);
        this.#later(() => {
          this.#holdUntil.delete(jobId);
          this.#kick();
        }, delay);
        return;
      }
      this.#update(jobId, { status: "failed", errorCode: engineError.code as ErrorCode }, ["leaseExpiresAt", "progress"]);
    } finally {
      clearInterval(renew);
    }
  }
}
