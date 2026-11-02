import { z } from "zod";
import { RunChanges } from "./files.ts";
import { Id, SchemaVersion } from "./common.ts";
import { AppError } from "./errors.ts";
import { RunEvent } from "./events.ts";
import { MediaAsset, Recording, Transcript, TranscriptionJob } from "./media.ts";
import { ModifyJob } from "./modify.ts";
import { CollectionManifest, Course, SyncRun } from "./lms.ts";
import { ChatTurn, ComposerDraft, PreparedAttachment, Run, Session } from "./sessions.ts";

export const CredentialStatus = z.object({
  school: z.boolean(),
  /** The school refused the saved password; nothing is retried until it is saved again. */
  schoolRejected: z.boolean(),
  canvasToken: z.boolean(),
  /** False when the Mac's Keychain-backed encryption is unavailable, so nothing can be saved. */
  available: z.boolean(),
});
export type CredentialStatus = z.infer<typeof CredentialStatus>;

/**
 * Renderer → host request channels (ADR-002: preload exposes only these).
 * The host re-validates every request with the same schema; renderer-side
 * validation is a convenience, not a security boundary.
 */
export const IpcChannels = {
  "collection.run": {
    request: z.object({ scope: z.enum(["course", "all_courses"]), courseId: Id.optional() }),
    response: z.object({ syncRunId: Id }),
  },
  "collection.status": {
    request: z.object({}),
    response: z.object({ lastSucceeded: SyncRun.optional(), current: SyncRun.optional() }),
  },
  /** Whether sign-in details are saved on this Mac; values are never sent back (WBS-040). */
  "credentials.status": {
    request: z.object({}),
    response: CredentialStatus,
  },
  /** Tries the school sign-in once with these details and saves them only if the school accepts. */
  "credentials.saveSchool": {
    request: z.object({ schoolId: z.string().trim().min(1).max(64), password: z.string().min(1).max(256) }),
    response: CredentialStatus,
  },
  /** Checks the Canvas access token against Canvas and saves it only if it works. */
  "credentials.saveCanvasToken": {
    request: z.object({ token: z.string().trim().min(10).max(512) }),
    response: CredentialStatus,
  },
  "credentials.clear": {
    request: z.object({ which: z.enum(["school", "canvasToken"]) }),
    response: CredentialStatus,
  },
  "library.manifest": {
    request: z.object({ courseId: Id }),
    response: z.object({ manifest: CollectionManifest.optional() }),
  },
  /** Courses that have a collected manifest on this Mac, for the signed-in account. */
  "library.courses": {
    request: z.object({}),
    response: z.object({ courses: z.array(Course) }),
  },
  /**
   * One stored original, looked up through the course manifest so the renderer
   * can never name a file path. The host re-hashes it before answering.
   */
  "library.asset": {
    request: z.object({ courseId: Id, assetId: Id }),
    response: z.object({ mediaType: z.string().min(1), bytes: z.instanceof(Uint8Array) }),
  },
  "session.create": {
    request: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("course"), courseId: Id, title: z.string().min(1).max(200) }),
      // No courseId field at all: the browsing course cannot be passed in.
      z.strictObject({ mode: z.literal("independent"), title: z.string().min(1).max(200) }),
    ]),
    response: z.object({ session: Session }),
  },
  "session.list": {
    request: z.object({ courseId: Id.optional(), includeArchived: z.boolean() }),
    response: z.object({ sessions: z.array(Session) }),
  },
  "session.rename": {
    request: z.object({ appSessionId: Id, title: z.string().min(1).max(200) }),
    response: z.object({ session: Session }),
  },
  /** What this session's chat showed before, oldest first, including runs cut off by a quit. */
  "session.transcript": {
    request: z.object({ appSessionId: Id }),
    response: z.object({ turns: z.array(ChatTurn) }),
  },
  "session.archive": {
    request: z.object({ appSessionId: Id, archived: z.boolean() }),
    response: z.object({ session: Session }),
  },
  "captures.start": {
    request: z.object({ appSessionId: Id }),
    response: z.object({ capture: z.object({ attachment: PreparedAttachment, preview: z.instanceof(Uint8Array) }).optional() }),
  },
  "attachments.chooseLocal": {
    request: z.object({ appSessionId: Id }),
    response: z.object({ attachment: PreparedAttachment.optional() }),
  },
  "attachments.prepareAsset": {
    request: z.object({ appSessionId: Id, courseId: Id, assetId: Id }),
    response: z.object({ attachment: PreparedAttachment }),
  },
  "attachments.confirm": {
    request: z.object({ appSessionId: Id, attachmentId: Id }),
    response: z.object({ attachment: PreparedAttachment }),
  },
  "attachments.remove": {
    request: z.object({ appSessionId: Id, attachmentId: Id }),
    response: z.object({ removed: z.boolean() }),
  },
  "run.start": {
    request: z.object({
      requestId: Id,
      draft: ComposerDraft,
      /**
       * PNG of the page in `draft.viewing`, drawn by the viewer, so the AI can
       * look at slides that are mostly pictures. Used for course sessions
       * only; not kept in the transcript.
       */
      viewingImage: z.instanceof(Uint8Array).refine((b) => b.byteLength <= 8_000_000, "page image too large").optional(),
    }),
    response: z.object({ run: Run }),
  },
  /** Opens the system folder picker in the host; the renderer never names a path. */
  "files.chooseFolder": {
    request: z.object({ appSessionId: Id }),
    response: z.object({ session: Session }),
  },
  "files.removeFolder": {
    request: z.object({ appSessionId: Id, folder: z.string().min(1) }),
    response: z.object({ session: Session }),
  },
  "files.changes": {
    request: z.object({ runId: Id }),
    response: z.object({ changes: RunChanges.optional() }),
  },
  /** Every recorded change in a session, newest first, including runs cut off by a quit. */
  "files.sessionChanges": {
    request: z.object({ appSessionId: Id }),
    response: z.object({ records: z.array(RunChanges) }),
  },
  "files.restore": {
    request: z.object({ runId: Id }),
    response: z.object({ restored: z.array(z.string()), skipped: z.array(z.string()) }),
  },
  /** Moves one file to the macOS Trash after the host asks the user, showing its path. */
  "files.trash": {
    request: z.object({ appSessionId: Id, runId: Id, key: z.string().min(1) }),
    response: z.object({ trashed: z.boolean() }),
  },
  "run.cancel": {
    request: z.object({ runId: Id }),
    response: z.object({ run: Run }),
  },
  /**
   * REQ-007 (WBS-023). The host checks microphone permission and free space,
   * then the renderer captures 16 kHz mono PCM and sends it in chunks.
   */
  "recording.start": {
    request: z.object({ courseId: Id, title: z.string().trim().min(1).max(200).optional() }),
    response: z.object({ recording: Recording }),
  },
  /** One chunk of 16-bit little-endian PCM, appended and flushed before the answer. `seq` starts at 0. */
  "recording.chunk": {
    request: z.object({
      recordingId: Id,
      seq: z.number().int().nonnegative(),
      pcm: z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= 2_000_000 && b.byteLength % 2 === 0, "pcm chunk"),
    }),
    response: z.object({ savedMs: z.number().int().nonnegative() }),
  },
  /** Ends the recording and confirms the original; `reason` says why it stopped when the user did not. */
  "recording.stop": {
    request: z.object({ recordingId: Id, reason: z.enum(["user", "device_lost", "app_closing"]).optional() }),
    response: z.object({ recording: Recording, asset: MediaAsset.optional() }),
  },
  "recording.list": {
    request: z.object({ courseId: Id }),
    response: z.object({ recordings: z.array(Recording), assets: z.array(MediaAsset) }),
  },
  /** The stored original, re-hashed before it is handed out, for playback. */
  "media.asset": {
    request: z.object({ assetId: Id }),
    response: z.object({ mediaType: z.string().min(1), bytes: z.instanceof(Uint8Array) }),
  },
  "media.list": {
    request: z.object({ courseId: Id }),
    response: z.object({ assets: z.array(MediaAsset), recordings: z.array(Recording), jobs: z.array(TranscriptionJob), transcripts: z.array(Transcript), downloads: z.array(z.object({ id: Id, courseId: Id, title: z.string(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), receivedBytes: z.number().optional(), totalBytes: z.number().optional(), errorCode: z.string().optional() })) }),
  },
  "media.videos": { request: z.object({ courseId: Id }), response: z.object({ videos: z.array(z.object({ sourceId: z.string().regex(/^[\w-]{1,64}$/), title: z.string().min(1).max(200) })) }) },
  "media.download": { request: z.object({ courseId: Id, sourceId: z.string().regex(/^[\w-]{1,64}$/) }), response: z.object({ downloadId: Id }) },
  "media.cancelDownload": { request: z.object({ courseId: Id, downloadId: Id }), response: z.object({}) },
  "media.original": { request: z.object({ courseId: Id, assetId: Id }), response: z.object({ bytes: z.instanceof(Uint8Array), mediaType: z.string() }) },
  "media.open": { request: z.object({ courseId: Id, assetId: Id }), response: z.object({}) },
  "media.retry": { request: z.object({ courseId: Id, jobId: Id }), response: z.object({}) },
  /** REQ-011. Also tells a freshly restarted app that its renderer really came up. */
  "modify.status": {
    request: z.object({}),
    response: z.object({ sourceConfigured: z.boolean(), job: ModifyJob.optional() }),
  },
  /** The host opens the folder picker and accepts only this app's own source. */
  "modify.chooseSource": {
    request: z.object({}),
    response: z.object({ sourceConfigured: z.boolean() }),
  },
  /** The host asks the user again before anything runs; the renderer cannot skip it. */
  "modify.start": {
    request: z.object({ requestId: Id, prompt: z.string().trim().min(1).max(4000) }),
    response: z.object({ job: ModifyJob }),
  },
  "modify.cancel": { request: z.object({ jobId: Id }), response: z.object({ job: ModifyJob }) },
  "modify.verify": { request: z.object({ jobId: Id }), response: z.object({ job: ModifyJob }) },
  "modify.apply": { request: z.object({ jobId: Id }), response: z.object({ job: ModifyJob }) },
  "modify.rollback": { request: z.object({ jobId: Id }), response: z.object({ job: ModifyJob }) },
  "modify.discard": { request: z.object({ jobId: Id }), response: z.object({ job: ModifyJob }) },
} as const;
export type IpcChannel = keyof typeof IpcChannels;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof IpcChannels)[C]["request"]>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof IpcChannels)[C]["response"]>;

/** Host → renderer push messages. */
export const HostPush = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.event"), event: RunEvent }),
  z.object({ kind: z.literal("collection.progress"), syncRun: SyncRun }),
  z.object({ kind: z.literal("modify.job"), job: ModifyJob }),
  /** The host stopped a recording on its own (sleep, low disk): the renderer stops capturing. */
  z.object({ kind: z.literal("recording.stopped"), recording: Recording, asset: MediaAsset.optional() }),
]);
export type HostPush = z.infer<typeof HostPush>;

export const IpcEnvelope = z.object({
  schemaVersion: SchemaVersion,
  channel: z.enum(Object.keys(IpcChannels) as [IpcChannel, ...IpcChannel[]]),
  payload: z.unknown(),
});

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppError };
export const ipcResult = <T extends z.ZodType>(data: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: AppError }),
  ]);
