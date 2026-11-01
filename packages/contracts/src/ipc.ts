import { z } from "zod";
import { RunChanges } from "./files.ts";
import { Id, SchemaVersion } from "./common.ts";
import { AppError } from "./errors.ts";
import { RunEvent } from "./events.ts";
import { CollectionManifest, Course, SyncRun } from "./lms.ts";
import { ComposerDraft, PreparedAttachment, Run, Session } from "./sessions.ts";

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
    request: z.object({ requestId: Id, draft: ComposerDraft }),
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
} as const;
export type IpcChannel = keyof typeof IpcChannels;
export type IpcRequest<C extends IpcChannel> = z.infer<(typeof IpcChannels)[C]["request"]>;
export type IpcResponse<C extends IpcChannel> = z.infer<(typeof IpcChannels)[C]["response"]>;

/** Host → renderer push messages. */
export const HostPush = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("run.event"), event: RunEvent }),
  z.object({ kind: z.literal("collection.progress"), syncRun: SyncRun }),
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
