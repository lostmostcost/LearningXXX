import { z } from "zod";
import { Id, SchemaVersion, Sha256, StorageKey, UtcTimestamp } from "./common.ts";
import { ErrorCode } from "./errors.ts";

/**
 * SPEC-004 / ADR-003 (WBS-022): lecture recordings, online lecture videos and
 * their automatic transcripts. Originals are never deleted or overwritten
 * without the user asking; every derived file names what it came from.
 */

/** A lecture recorded on this Mac. Chunks are kept so a forced quit leaves a recoverable part. */
export const RecordingStatus = z.enum(["recording", "finalized", "recovered_partial", "failed"]);
/** An LMS online lecture's own id (as in `media.videos`), kept opaque. */
export const LectureSourceId = z.string().regex(/^[\w-]{1,64}$/);
export const Recording = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    courseId: Id,
    /**
     * WBS-065: the manifest week the user filed it under. Absent only for
     * recordings made before weeks were chosen; the user confirms one later.
     */
    weekId: Id.optional(),
    /** WBS-065: the week's online lecture it belongs to, if the user picked one. */
    lectureSourceId: LectureSourceId.optional(),
    title: z.string().min(1).max(200),
    startedAt: UtcTimestamp,
    /** Known once stopped (or recovered); absent while recording. */
    durationMs: z.number().int().nonnegative().optional(),
    /** Device name as macOS reports it, for "which microphone was this". */
    sourceDevice: z.string().max(200).optional(),
    status: RecordingStatus,
    /** The confirmed original; set exactly when the recording is finalized or recovered. */
    originalAssetId: Id.optional(),
    errorCode: ErrorCode.optional(),
  })
  .superRefine((r, ctx) => {
    if (r.lectureSourceId !== undefined && r.weekId === undefined) ctx.addIssue({ code: "custom", message: "a lecture is chosen within a week" });
    const done = r.status === "finalized" || r.status === "recovered_partial";
    if (done !== (r.originalAssetId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "originalAssetId is required exactly for finalized or recovered recordings" });
    }
    if (done && r.durationMs === undefined) ctx.addIssue({ code: "custom", message: `${r.status} recording requires durationMs` });
    if ((r.status === "failed") !== (r.errorCode !== undefined)) {
      ctx.addIssue({ code: "custom", message: "errorCode is required exactly for failed recordings" });
    }
  });
export type Recording = z.infer<typeof Recording>;

/** Where a media file came from. Extracted audio always points at its original. */
export const MediaSource = z.discriminatedUnion("type", [
  z.object({ type: z.literal("recording"), recordingId: Id }),
  /** An online lecture the user's LMS account may view; `sourceId` is the LMS's own id, kept opaque. */
  z.object({ type: z.literal("lms_video"), resourceId: Id, sourceId: z.string().min(1) }),
  z.object({ type: z.literal("extracted_audio"), fromAssetId: Id }),
]);
export type MediaSource = z.infer<typeof MediaSource>;

export const MediaAsset = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    courseId: Id,
    /** `original` is what the user recorded or downloaded; `derived` may be cleaned up and remade. */
    role: z.enum(["original", "derived"]),
    source: MediaSource,
    title: z.string().min(1).max(200),
    mediaType: z.string().regex(/^(audio|video)\/[0-9a-z.+-]+$/),
    bytes: z.number().int().positive(),
    sha256: Sha256,
    storageKey: StorageKey,
    durationMs: z.number().int().positive().optional(),
    createdAt: UtcTimestamp,
  })
  .superRefine((a, ctx) => {
    if ((a.source.type === "extracted_audio") !== (a.role === "derived")) {
      ctx.addIssue({ code: "custom", message: "only extracted audio is derived; recordings and downloads are originals" });
    }
  });
export type MediaAsset = z.infer<typeof MediaAsset>;

/** Which engine run produced a transcript; part of the idempotency key. */
export const TranscriptEngine = z.object({
  /** e.g. "qwen3-asr" (ADR-003). */
  name: z.string().min(1),
  /** Model and runtime version, e.g. "Qwen3-ASR-1.7B/mlx-qwen3-asr-0.4.4". */
  version: z.string().min(1),
});
export type TranscriptEngine = z.infer<typeof TranscriptEngine>;

export const TranscriptSegment = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    text: z.string(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((s) => s.startMs <= s.endMs, { message: "segment start must not exceed end" });
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/**
 * One version of a transcript. `engine` output is kept as produced (after the
 * rule clean-up that is part of the engine step); `corrected` is the
 * on-request Claude version and always names the version it corrected.
 */
export const Transcript = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    sourceAssetId: Id,
    kind: z.enum(["engine", "corrected"]),
    engine: TranscriptEngine,
    parametersHash: Sha256,
    basedOnTranscriptId: Id.optional(),
    language: z.string().min(2).max(16),
    createdAt: UtcTimestamp,
    segments: z.array(TranscriptSegment),
  })
  .superRefine((t, ctx) => {
    if ((t.kind === "corrected") !== (t.basedOnTranscriptId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "basedOnTranscriptId is required exactly for corrected transcripts" });
    }
    for (let i = 1; i < t.segments.length; i += 1) {
      if (t.segments[i]!.startMs < t.segments[i - 1]!.startMs) {
        ctx.addIssue({ code: "custom", message: "segments must be in time order" });
        break;
      }
    }
  });
export type Transcript = z.infer<typeof Transcript>;

export const TranscriptionJobStatus = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled"] as const;

/**
 * SPEC-004 전사 파이프라인. One job per idempotency key: the same source,
 * engine and parameters never produce two transcripts. A running job holds a
 * lease; a worker that dies lets it expire and the job is picked up again.
 */
export const TranscriptionJob = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    sourceAssetId: Id,
    engine: TranscriptEngine,
    parametersHash: Sha256,
    idempotencyKey: Sha256,
    status: TranscriptionJobStatus,
    /** 0..1 only when the worker really knows; absent means "in progress, amount unknown". */
    progress: z.number().min(0).max(1).optional(),
    attempt: z.number().int().nonnegative(),
    leaseExpiresAt: UtcTimestamp.optional(),
    errorCode: ErrorCode.optional(),
    outputTranscriptId: Id.optional(),
    createdAt: UtcTimestamp,
    updatedAt: UtcTimestamp,
  })
  .superRefine((j, ctx) => {
    if ((j.status === "succeeded") !== (j.outputTranscriptId !== undefined)) {
      ctx.addIssue({ code: "custom", message: "outputTranscriptId is required exactly for succeeded jobs" });
    }
    if ((j.status === "failed") !== (j.errorCode !== undefined)) {
      ctx.addIssue({ code: "custom", message: "errorCode is required exactly for failed jobs" });
    }
    if ((j.status === "running") !== (j.leaseExpiresAt !== undefined)) {
      ctx.addIssue({ code: "custom", message: "leaseExpiresAt is required exactly for running jobs" });
    }
    if (j.status === "running" && j.attempt < 1) ctx.addIssue({ code: "custom", message: "a running job has started at least once" });
  });
export type TranscriptionJob = z.infer<typeof TranscriptionJob>;

/**
 * Canonical text of engine parameters, keys sorted so their order never
 * changes the hash. Hash it with sha256 to get `parametersHash` (the host
 * hashes; this package stays free of Node APIs for the renderer).
 */
export function canonicalParameters(parameters: Record<string, string | number | boolean | readonly string[]>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(parameters).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

/** SPEC-004 idempotency: source content + engine + parameters. sha256 of this is `idempotencyKey`. */
export function transcriptionKeyInput(sourceSha256: string, engine: TranscriptEngine, parametersHash: string): string {
  return [Sha256.parse(sourceSha256), engine.name, engine.version, Sha256.parse(parametersHash)].join("\n");
}
