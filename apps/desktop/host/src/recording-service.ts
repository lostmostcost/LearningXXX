import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AppError, MediaAsset, Recording, SCHEMA_VERSION } from "@learningxxx/contracts";
import type { AudioImportType, ErrorCode, IpcRequest, IpcResponse } from "@learningxxx/contracts";

/** What the renderer sends: 16 kHz, mono, 16-bit little-endian PCM. */
export const SAMPLE_RATE = 16_000;
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
/** Free space needed to start, and the floor at which a running recording is stopped. */
export const MIN_FREE_TO_START = 500 * 1024 ** 2;
export const MIN_FREE_TO_CONTINUE = 100 * 1024 ** 2;

function fail(code: ErrorCode, message: string, retryable = false): never {
  throw Object.assign(new Error(message), { appError: AppError.parse({ code, message, retryable }) });
}

/** A WAV header for raw PCM, so the original is readable even if compression fails. */
export function wavHeader(pcmBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

/** WAV → AAC in an .m4a with macOS's own encoder; about 30 times smaller, still readable by afconvert for transcription. */
export async function encodeAac(wav: string, m4a: string): Promise<void> {
  await promisify(execFile)("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "48000", wav, m4a], { timeout: 10 * 60_000 });
}

export interface RecordingServiceOptions {
  dataRoot: string;
  /** Asks macOS when not yet decided; never shows anything when already decided. */
  micPermission: () => Promise<"granted" | "denied">;
  freeBytes: (path: string) => number;
  /** WAV in, compressed original out. When it fails, the WAV itself is kept as the original. */
  encode?: (wav: string, out: string) => Promise<void>;
  /** WBS-025 wires this to the transcription queue. Called once per confirmed original. */
  onOriginalConfirmed?: (asset: MediaAsset) => void;
  /** The host stopped a recording on its own (low disk, sleep). */
  onStopped?: (recording: Recording, asset: MediaAsset | undefined) => void;
  /** WBS-101: transcription while recording; told about the growing PCM, the final original and discarded recordings. */
  live?: {
    chunkSaved: (recordingId: string, pcmPath: string, pcmBytes: number) => void;
    finish: (recordingId: string, pcmPath: string, pcmBytes: number, sha256: string) => void;
    discard: (recordingId: string) => void;
    transcribedMs: (recordingId: string) => number;
  };
  now?: () => Date;
  newId?: () => string;
}

interface Active {
  id: string;
  fd: number;
  nextSeq: number;
  bytes: number;
}

interface Stored {
  recordings: Recording[];
  assets: MediaAsset[];
}

/**
 * Lecture recording on this Mac (SPEC-004 녹음 흐름, WBS-023). Each chunk is
 * appended to one PCM file and flushed to disk before the renderer is told
 * it is saved, so a forced quit loses at most the chunk in flight. Stopping
 * turns the PCM into the original (AAC .m4a, or WAV if that fails), stores
 * it by content hash and hands it on for transcription. A recording left
 * unfinished by a crash is confirmed as `recovered_partial` on the next start.
 * Originals are never deleted or overwritten.
 */
export class RecordingService {
  readonly #o: RecordingServiceOptions;
  readonly #file: string;
  readonly #state: Stored;
  readonly #now: () => Date;
  readonly #newId: () => string;
  #active: Active | undefined;
  #stopping: Promise<IpcResponse<"recording.stop">> | undefined;

  constructor(options: RecordingServiceOptions) {
    this.#o = options;
    this.#file = join(options.dataRoot, "media", "recordings.json");
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
    this.#state = this.#load();
  }

  #stamp(): string {
    return this.#now().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  #dir(id: string): string {
    return join(this.#o.dataRoot, "media", "recordings", id);
  }

  #load(): Stored {
    if (!existsSync(this.#file)) return { recordings: [], assets: [] };
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Stored>;
      return {
        recordings: (raw.recordings ?? []).flatMap((r) => (Recording.safeParse(r).success ? [Recording.parse(r)] : [])),
        assets: (raw.assets ?? []).flatMap((a) => (MediaAsset.safeParse(a).success ? [MediaAsset.parse(a)] : [])),
      };
    } catch {
      // Keep the unreadable file for recovery instead of overwriting it.
      renameSync(this.#file, `${this.#file}.corrupt-${Date.now()}`);
      return { recordings: [], assets: [] };
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const temp = `${this.#file}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state));
    renameSync(temp, this.#file);
  }

  #put(recording: Recording): Recording {
    const parsed = Recording.parse(recording);
    const i = this.#state.recordings.findIndex((r) => r.id === parsed.id);
    if (i === -1) this.#state.recordings.push(parsed);
    else this.#state.recordings[i] = parsed;
    this.#save();
    return parsed;
  }

  #recording(id: string): Recording {
    return this.#state.recordings.find((r) => r.id === id) ?? fail("NOT_FOUND", "녹음을 찾을 수 없습니다.");
  }

  get activeId(): string | undefined {
    return this.#active?.id;
  }
  courseOf(recordingId: string): string { return this.#recording(recordingId).courseId; }

  list({ courseId }: IpcRequest<"recording.list">): IpcResponse<"recording.list"> {
    const recordings = this.#state.recordings.filter((r) => r.courseId === courseId).toSorted((a, b) => b.startedAt.localeCompare(a.startedAt));
    return { recordings, assets: this.#state.assets.filter((a) => a.courseId === courseId) };
  }

  /** Every confirmed original, so transcription can pick up anything it has not seen. */
  originals(): MediaAsset[] {
    return this.#state.assets.filter((a) => a.role === "original");
  }

  async start({ courseId, title, weekId, lectureSourceId }: IpcRequest<"recording.start">): Promise<Recording> {
    if (this.#active || this.#stopping) fail("RUN_ALREADY_ACTIVE", "이미 녹음 중입니다. 지금 녹음을 먼저 멈추세요.");
    if ((await this.#o.micPermission()) !== "granted") {
      fail("MIC_PERMISSION_DENIED", "마이크 권한이 없습니다. 시스템 설정 > 개인정보 보호 및 보안 > 마이크에서 이 앱을 켠 뒤 다시 시작하세요.");
    }
    mkdirSync(join(this.#o.dataRoot, "media"), { recursive: true });
    if (this.#o.freeBytes(this.#o.dataRoot) < MIN_FREE_TO_START) {
      fail("DISK_FULL", "저장 공간이 부족해 녹음을 시작하지 않았습니다. 500MB 이상 비운 뒤 다시 시작하세요.");
    }
    const id = this.#newId();
    const startedAt = this.#stamp();
    mkdirSync(this.#dir(id), { recursive: true });
    const fd = openSync(join(this.#dir(id), "audio.pcm"), "a");
    this.#active = { id, fd, nextSeq: 0, bytes: 0 };
    const label = new Date(this.#now().getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
    return this.#put({
      schemaVersion: SCHEMA_VERSION, id, courseId, title: title ?? `${label} 녹음`, startedAt, status: "recording",
      ...(weekId ? { weekId } : {}), ...(lectureSourceId ? { lectureSourceId } : {}),
    });
  }

  /**
   * WBS-065: files a recording under a week (and lecture), also while it is
   * being recorded. Only these two fields change; the original is untouched.
   * The caller checks that the week belongs to the recording's course.
   */
  assign({ recordingId, weekId, lectureSourceId }: IpcRequest<"recording.assign">): Recording {
    const { lectureSourceId: _previous, ...recording } = this.#recording(recordingId);
    return this.#put({ ...recording, weekId, ...(lectureSourceId ? { lectureSourceId } : {}) });
  }

  /** Appends and flushes one chunk. A repeated chunk (same seq) is acknowledged without writing twice. */
  async chunk({ recordingId, seq, pcm }: IpcRequest<"recording.chunk">): Promise<IpcResponse<"recording.chunk">> {
    const active = this.#active;
    if (!active || active.id !== recordingId) fail("NOT_FOUND", "진행 중인 녹음이 아닙니다.");
    if (seq < active.nextSeq) return { savedMs: Math.floor(active.bytes / BYTES_PER_MS) };
    if (seq > active.nextSeq) fail("INVALID_REQUEST", "녹음 조각 순서가 맞지 않습니다.");
    if (this.#o.freeBytes(this.#o.dataRoot) < MIN_FREE_TO_CONTINUE) {
      const stopped = await this.stop({ recordingId, reason: "app_closing" }, "DISK_FULL");
      this.#o.onStopped?.(stopped.recording, stopped.asset);
      fail("DISK_FULL", "저장 공간이 부족해 녹음을 멈추고 지금까지의 녹음을 저장했습니다.");
    }
    writeSync(active.fd, pcm);
    fsyncSync(active.fd);
    active.bytes += pcm.byteLength;
    active.nextSeq += 1;
    const live = this.#o.live;
    if (!live) return { savedMs: Math.floor(active.bytes / BYTES_PER_MS) };
    // Live transcription is a convenience: whatever goes wrong there never stops the recording.
    try { live.chunkSaved(recordingId, join(this.#dir(recordingId), "audio.pcm"), active.bytes); } catch { /* the queue transcribes the original */ }
    return { savedMs: Math.floor(active.bytes / BYTES_PER_MS), transcribedMs: live.transcribedMs(recordingId) };
  }

  /** Ends the active recording and confirms its original. Safe to call twice. */
  stop({ recordingId }: IpcRequest<"recording.stop">, cause?: ErrorCode): Promise<IpcResponse<"recording.stop">> {
    if (this.#stopping) return this.#stopping;
    const active = this.#active;
    if (!active || active.id !== recordingId) {
      const recording = this.#recording(recordingId);
      const asset = this.#state.assets.find((a) => a.id === recording.originalAssetId);
      return Promise.resolve(asset ? { recording, asset } : { recording });
    }
    this.#active = undefined;
    closeSync(active.fd);
    this.#stopping = this.#confirm(recordingId, "finalized", cause).finally(() => (this.#stopping = undefined));
    return this.#stopping;
  }

  /** Stops whatever is recording, e.g. before the Mac sleeps; tells the renderer through onStopped. */
  async stopActive(cause?: ErrorCode): Promise<void> {
    const id = this.#active?.id;
    if (!id) return;
    const stopped = await this.stop({ recordingId: id }, cause);
    this.#o.onStopped?.(stopped.recording, stopped.asset);
  }

  /**
   * Startup: a recording still marked `recording` was cut off by a quit or
   * crash. Whatever reached the disk becomes a `recovered_partial` original.
   */
  async recover(): Promise<Recording[]> {
    const recovered: Recording[] = [];
    for (const r of this.#state.recordings.filter((x) => x.status === "recording" && x.id !== this.#active?.id)) {
      recovered.push((await this.#confirm(r.id, "recovered_partial")).recording);
    }
    return recovered;
  }

  async #confirm(id: string, status: "finalized" | "recovered_partial", cause?: ErrorCode): Promise<IpcResponse<"recording.stop">> {
    const recording = this.#recording(id);
    const pcmFile = join(this.#dir(id), "audio.pcm");
    const pcmBytes = existsSync(pcmFile) ? statSync(pcmFile).size - (statSync(pcmFile).size % 2) : 0;
    if (pcmBytes === 0) {
      try { this.#o.live?.discard(id); } catch { /* nothing to keep */ }
      rmSync(this.#dir(id), { recursive: true, force: true });
      return { recording: this.#put({ ...recording, status: "failed", errorCode: cause ?? "RECORDING_INTERRUPTED" }) };
    }
    const wav = join(this.#dir(id), "audio.wav");
    const fd = openSync(wav, "w");
    try {
      writeSync(fd, wavHeader(pcmBytes));
      writeSync(fd, readFileSync(pcmFile).subarray(0, pcmBytes));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    let source = wav;
    let mediaType = "audio/wav";
    let ext = "wav";
    try {
      const m4a = join(this.#dir(id), "audio.m4a");
      await (this.#o.encode ?? encodeAac)(wav, m4a);
      if (existsSync(m4a) && statSync(m4a).size > 0) {
        source = m4a;
        mediaType = "audio/mp4";
        ext = "m4a";
      }
    } catch {
      // The WAV is a complete, readable original on its own.
    }
    const bytes = readFileSync(source);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `media/originals/${sha256}.${ext}`;
    const target = join(this.#o.dataRoot, storageKey);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      copyFileSync(source, `${target}.part`);
      renameSync(`${target}.part`, target);
    }
    const durationMs = Math.max(1, Math.floor(pcmBytes / BYTES_PER_MS));
    const asset = MediaAsset.parse({
      schemaVersion: SCHEMA_VERSION,
      id: this.#newId(),
      courseId: recording.courseId,
      role: "original",
      source: { type: "recording", recordingId: id },
      title: recording.title,
      mediaType,
      bytes: bytes.byteLength,
      sha256,
      storageKey,
      durationMs,
      createdAt: this.#stamp(),
    });
    this.#state.assets.push(asset);
    // Read again: the user may have filed it under a week while it was being encoded.
    const done = this.#put({ ...this.#recording(id), status, durationMs, originalAssetId: asset.id });
    // WBS-101: the rest of the audio becomes the last live window before the working copy goes.
    try { this.#o.live?.finish(id, pcmFile, pcmBytes, sha256); } catch { /* the queue transcribes the original */ }
    // The original is safely stored; the working copy is no longer needed.
    rmSync(this.#dir(id), { recursive: true, force: true });
    try {
      this.#o.onOriginalConfirmed?.(asset);
    } catch {
      // Transcription picks up originals again on the next start.
    }
    return { recording: done, asset };
  }

  /**
   * WBS-066: stores audio imported from the user's own folder as a finished
   * recording. The bytes are copied (the user's file is never changed); the
   * same file imported again returns what is already there. It is not handed
   * to transcription here: the caller registers it after keeping any
   * transcript that came with it.
   */
  importOriginal(input: { courseId: string; weekId?: string | undefined; lectureSourceId?: string | undefined; title: string; startedAt: string; durationMs: number; importedFrom: string; bytes: Uint8Array; mediaType: string; ext: AudioImportType; recordingId: string; assetId: string }): { recording: Recording; asset: MediaAsset } {
    const existing = this.#state.recordings.find((r) => r.courseId === input.courseId && r.importedFrom === input.importedFrom);
    const existingAsset = existing && this.#state.assets.find((a) => a.id === existing.originalAssetId);
    if (existing && existingAsset) return { recording: existing, asset: existingAsset };
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    const storageKey = `media/originals/${sha256}.${input.ext}`;
    const target = join(this.#o.dataRoot, storageKey);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) {
      writeFileSync(`${target}.part`, input.bytes);
      renameSync(`${target}.part`, target);
    }
    const durationMs = Math.max(1, Math.round(input.durationMs));
    const asset = MediaAsset.parse({
      schemaVersion: SCHEMA_VERSION, id: input.assetId, courseId: input.courseId, role: "original",
      source: { type: "recording", recordingId: input.recordingId }, title: input.title, mediaType: input.mediaType,
      bytes: input.bytes.byteLength, sha256, storageKey, durationMs, createdAt: this.#stamp(),
    });
    this.#state.assets.push(asset);
    const recording = this.#put({
      schemaVersion: SCHEMA_VERSION, id: input.recordingId, courseId: input.courseId, title: input.title, startedAt: input.startedAt,
      status: "finalized", durationMs, originalAssetId: asset.id, sourceDevice: "가져온 녹음", importedFrom: input.importedFrom,
      ...(input.weekId ? { weekId: input.weekId } : {}), ...(input.lectureSourceId && input.weekId ? { lectureSourceId: input.lectureSourceId } : {}),
    });
    return { recording, asset };
  }

  /** An original for playback, re-hashed before it is handed out. */
  asset({ assetId }: IpcRequest<"media.asset">): IpcResponse<"media.asset"> {
    const asset = this.#state.assets.find((a) => a.id === assetId) ?? fail("NOT_FOUND", "녹음 파일 정보를 찾을 수 없습니다.");
    const path = join(this.#o.dataRoot, asset.storageKey);
    const bytes = existsSync(path) ? readFileSync(path) : undefined;
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      fail("CHECKSUM_MISMATCH", "저장된 녹음 원본이 없거나 손상되었습니다.");
    }
    return { mediaType: asset.mediaType, bytes: new Uint8Array(bytes) };
  }
}
