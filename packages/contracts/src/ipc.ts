import { z } from "zod";
import { RunChanges } from "./files.ts";
import { Id, SchemaVersion, UtcTimestamp } from "./common.ts";
import { AppError } from "./errors.ts";
import { RunEvent } from "./events.ts";
import { CourseLearningStatus, CourseMeeting, Memo } from "./learning.ts";
import { AutomationSettings, ImportedDocKind, LectureMention, LectureSourceId, PdfTranslationSkip, PreferredLanguage, MentionCandidate, MAX_CORRECTION_SEGMENTS, MAX_SEGMENT_TEXT, MediaAsset, Recording, Transcript, TranscriptionJob } from "./media.ts";
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
const TerminalId = z.string().uuid();
/** WBS-081: a file a conversation made (in its folder, or written elsewhere by its file tools). */
export const ChatOutput = z.object({
  id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string(), location: z.string(), where: z.enum(["folder", "elsewhere"]),
  bytes: z.number().int().nonnegative(), modifiedAt: z.string(), kind: z.enum(["text", "pdf", "image", "other"]), openable: z.boolean(),
});
export type ChatOutput = z.infer<typeof ChatOutput>;
export const ConversationState = z.object({
  messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'assistant', 'system']), text: z.string(), tools: z.array(z.object({ id: z.string(), name: z.string(), input: z.string() })) })),
  busy: z.boolean(), connected: z.boolean(), error: z.string(), model: z.string(), effort: z.string(), mode: z.string(),
  models: z.array(z.object({ value: z.string(), resolvedModel: z.string().optional(), displayName: z.string(), supportedEffortLevels: z.array(z.string()).optional(), supportsAutoMode: z.boolean().optional() })),
  commands: z.array(z.object({ name: z.string(), description: z.string(), argumentHint: z.string() })),
  permissions: z.array(z.object({ id: z.string(), tool: z.string(), input: z.record(z.string(), z.unknown()) })), totalCost: z.number(), tokens: z.number(), sessionId: z.string(),
});
export const SttStatus = z.object({ state: z.enum(['missing', 'installing', 'ready', 'failed', 'unsupported']), message: z.string() });
export const IpcChannels = {
  'stt.status': { request: z.object({ refresh: z.boolean().optional() }), response: SttStatus },
  'stt.prepare': { request: z.object({}), response: SttStatus },
  'stt.cancel': { request: z.object({}), response: SttStatus },
  /** WBS-081: files the conversation made; a text one can be read in the app, any listed one shown in Finder or opened. */
  'chat.outputs': { request: z.object({ appSessionId: TerminalId }), response: z.object({ files: z.array(ChatOutput), folder: z.string() }) },
  'chat.readOutput': { request: z.object({ appSessionId: TerminalId, id: ChatOutput.shape.id }), response: z.object({ text: z.string() }) },
  'chat.showOutput': { request: z.object({ appSessionId: TerminalId, id: ChatOutput.shape.id, how: z.enum(["open", "reveal"]) }), response: z.object({}) },
  'chat.open': { request: z.object({ appSessionId: TerminalId }), response: ConversationState },
  'chat.state': { request: z.object({ appSessionId: TerminalId }), response: ConversationState },
  /** `viewing` (WBS-082): what the user has open, so the course chat looks at that week's material first. */
  'chat.send': { request: z.object({ appSessionId: TerminalId, requestId: TerminalId, text: z.string().trim().min(1).max(100000), viewing: z.object({ week: z.string().max(200).optional(), title: z.string().max(300).optional(), page: z.number().int().positive().optional() }).optional() }), response: ConversationState },
  'chat.configure': { request: z.object({ appSessionId: TerminalId, model: z.string().max(200).optional(), effort: z.string().max(30).optional(), mode: z.string().max(30).optional() }), response: ConversationState },
  'chat.answer': { request: z.object({ appSessionId: TerminalId, permissionId: TerminalId, allow: z.boolean(), answers: z.record(z.string(), z.string()).optional() }), response: ConversationState },
  'chat.interrupt': { request: z.object({ appSessionId: TerminalId }), response: ConversationState },
  'chat.info': { request: z.object({ appSessionId: TerminalId, kind: z.enum(['context', 'cost', 'usage', 'mcp', 'skills']) }), response: z.object({ text: z.string() }) },
  'chat.rewind': { request: z.object({ appSessionId: TerminalId, messageId: TerminalId, preview: z.boolean() }), response: z.object({ canRewind: z.boolean(), error: z.string().optional(), filesChanged: z.array(z.string()).optional(), insertions: z.number().optional(), deletions: z.number().optional(), skippedLinks: z.number().optional() }) },
  'chat.detach': { request: z.object({ appSessionId: TerminalId }), response: z.object({}) },
  "terminal.stage": { request: z.object({ appSessionId: TerminalId, attachmentId: TerminalId }), response: z.object({ text: z.string() }) },
  "collection.run": {
    request: z.object({ scope: z.enum(["course", "all_courses"]), courseId: Id.optional() }),
    response: z.object({ syncRunId: Id }),
  },
  "collection.status": {
    request: z.object({}),
    response: z.object({ lastSucceeded: SyncRun.optional(), current: SyncRun.optional() }),
  },
  /**
   * CR-061 / WBS-061: the code a development run was built from (branch,
   * commit, WBS task, worktree folder). A packaged app answers `dev: false`.
   */
  /** WBS-071: this Mac's app preferences. */
  /** WBS-080: open the macOS Settings pane for a permission (screen recording, microphone). */
  "app.openSettings": { request: z.object({ pane: z.enum(["screen", "microphone"]) }), response: z.object({}) },
  "app.preferences": { request: z.object({}), response: z.object({ language: PreferredLanguage, automation: AutomationSettings }) },
  /** Either part may be given; the other stays as it is. */
  "app.setPreferences": { request: z.object({ language: PreferredLanguage.optional(), automation: AutomationSettings.partial().optional() }), response: z.object({ language: PreferredLanguage, automation: AutomationSettings }) },
  /** WBS-083: automatic steps waiting, running and recently finished. */
  "automation.status": { request: z.object({}), response: z.object({ running: z.string().optional(), waiting: z.number().int().nonnegative(), recent: z.array(z.object({ title: z.string(), at: z.string(), ok: z.boolean(), message: z.string().optional() })) }) },
  /** WBS-083: review/preview notes per course week, made automatically or on request. */
  "study.list": { request: z.object({ courseId: Id }), response: z.object({ notes: z.array(z.object({ weekId: Id, kind: z.enum(["review", "preview"]), markdown: z.string(), generatedAt: z.string() })) }) },
  "study.make": { request: z.object({ courseId: Id, weekId: Id, kind: z.enum(["review", "preview"]) }), response: z.object({ weekId: Id, kind: z.enum(["review", "preview"]), markdown: z.string(), generatedAt: z.string() }) },
  "app.build": {
    request: z.object({}),
    response: z.object({
      dev: z.boolean(),
      branch: z.string().max(200).optional(),
      commit: z.string().regex(/^[0-9a-f]{4,40}$/).optional(),
      task: z.string().regex(/^WBS-\d{3}$/).optional(),
      dirty: z.boolean().optional(),
      folder: z.string().max(200).optional(),
    }),
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
  /**
   * CR-054 / WBS-055: completion, attendance, deadlines and submission state
   * as the LMS shows them, read only. Cached; `refresh` reads the LMS again.
   */
  "learning.status": {
    request: z.object({ courseId: Id, refresh: z.boolean().optional() }),
    response: z.object({ status: CourseLearningStatus.optional() }),
  },
  /**
   * CR-054 / WBS-056: the user opened this LMS material (PDF) in the app; let
   * the LMS's own viewer record the view. Answers with the status read again.
   */
  /**
   * CR-054 / WBS-057: opens the lecture's LMS page in a visible app window for the
   * user to watch in the official player. Returns once it is open; a
   * `learning.watchClosed` push follows when the user closes it.
   */
  /** CR-054 / WBS-059: a quiz's LMS page in a visible app window; the user takes it there. Not for lockdown-browser quizzes. */
  "learning.openQuiz": {
    request: z.object({ courseId: Id, moduleItemId: z.string().regex(/^\d{1,20}$/).optional(), quizId: z.string().regex(/^\d{1,20}$/).optional() })
      .refine((r) => r.moduleItemId !== undefined || r.quizId !== undefined, "moduleItemId or quizId"),
    response: z.object({}),
  },
  "learning.watch": {
    request: z.object({ courseId: Id, moduleItemId: z.string().regex(/^\d{1,20}$/) }),
    response: z.object({}),
  },
  "learning.recordView": {
    request: z.object({ courseId: Id, moduleItemId: z.string().regex(/^\d{1,20}$/) }),
    response: z.object({ status: CourseLearningStatus.optional() }),
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
  /** WBS-072: the translated copy of a collected PDF made before (pages translated, pages left as the original). */
  "library.pdfTranslation": {
    request: z.object({ courseId: Id, assetId: Id, language: PreferredLanguage }),
    response: z.object({ bytes: z.instanceof(Uint8Array).optional(), pages: z.array(z.number().int().positive()), skipped: z.array(PdfTranslationSkip) }),
  },
  /** WBS-072: on request, Claude Code translates pages from–to (at most 40) and they are added to the copy. */
  "library.translatePdf": {
    request: z.object({ courseId: Id, assetId: Id, language: PreferredLanguage, from: z.number().int().positive(), to: z.number().int().positive() }),
    response: z.object({ bytes: z.instanceof(Uint8Array), pages: z.array(z.number().int().positive()), skipped: z.array(PdfTranslationSkip), untranslated: z.number().int().nonnegative(), stopped: z.boolean() }),
  },
  "library.cancelPdfTranslation": { request: z.object({}), response: z.object({}) },
  /** WBS-082: the course's summary file (course.md) made by Claude Code on request; `stale` when material changed since. */
  "course.knowledge": {
    request: z.object({ courseId: Id }),
    response: z.object({ markdown: z.string().optional(), generatedAt: z.string().optional(), stale: z.boolean(), meetings: z.array(CourseMeeting), running: z.boolean() }),
  },
  "course.makeKnowledge": {
    request: z.object({ courseId: Id }),
    response: z.object({ markdown: z.string().optional(), generatedAt: z.string().optional(), stale: z.boolean(), meetings: z.array(CourseMeeting), running: z.boolean() }),
  },
  "course.cancelKnowledge": { request: z.object({ courseId: Id }), response: z.object({}) },
  /** WBS-086: memos per course week (weekId absent = "주차 없음"). */
  "memo.get": { request: z.object({ courseId: Id, weekId: Id.optional() }), response: Memo },
  "memo.save": { request: z.object({ courseId: Id, weekId: Id.optional(), text: z.string().max(200_000), base: z.string().nullable() }), response: Memo },
  "memo.cleanup": { request: z.object({ courseId: Id, weekId: Id.optional() }), response: Memo },
  "memo.apply": { request: z.object({ courseId: Id, weekId: Id.optional(), action: z.enum(["use_cleaned", "undo", "discard_cleaned"]) }), response: Memo },
  /** The text of one page of a collected PDF, to put the page being read into a memo. */
  "memo.pageText": { request: z.object({ courseId: Id, assetId: Id, page: z.number().int().positive() }), response: z.object({ text: z.string() }) },
  /** WBS-088: the student's own files for a course week or 기타 자료 (weekId absent). Picked in a file dialog, copied into the app. */
  "materials.choose": { request: z.object({}), response: z.object({ planId: Id.optional(), files: z.array(z.object({ id: Id, name: z.string(), bytes: z.number().int().nonnegative(), problem: z.string().optional() })) }) },
  "materials.add": { request: z.object({ planId: Id, courseId: Id, files: z.array(z.object({ id: Id, title: z.string().max(300), weekId: Id.optional() })).min(1).max(50) }), response: z.object({ added: z.number().int().nonnegative(), failed: z.array(z.object({ id: Id, message: z.string() })) }) },
  /** Move to another week (null = 기타 자료), rename, or remove from the course (the app's copy only). */
  "materials.change": { request: z.object({ courseId: Id, resourceId: Id, weekId: Id.nullable().optional(), title: z.string().max(300).optional(), remove: z.boolean().optional() }), response: z.object({}) },
  /** WBS-085: class times per course — the student's own, else those found in course.md. */
  "timetable.get": { request: z.object({}), response: z.object({ courses: z.array(z.object({ courseId: Id, title: z.string(), meetings: z.array(CourseMeeting), source: z.enum(["manual", "course_md", "none"]) })) }) },
  /** `meetings: null` drops the student's times and uses course.md again. */
  "timetable.set": { request: z.object({ courseId: Id, meetings: z.array(CourseMeeting).max(20).nullable() }), response: z.object({ courses: z.array(z.object({ courseId: Id, title: z.string(), meetings: z.array(CourseMeeting), source: z.enum(["manual", "course_md", "none"]) })) }) },
  /** WBS-058: picks a file for a collected LMS assignment and reads the assignment again; nothing is sent. */
  "submit.choose": { request: z.object({ courseId: Id, resourceId: Id }), response: z.object({ planId: Id.optional(), fileName: z.string().optional(), bytes: z.number().int().nonnegative().optional(), problem: z.string().optional(),
    assignment: z.object({ name: z.string(), dueAt: z.string().nullable(), lockAt: z.string().nullable(), extensions: z.array(z.string()), attempt: z.number().int().nullable(), allowedAttempts: z.number().int().nullable(), submittedAt: z.string().nullable(), files: z.array(z.string()) }).optional() }) },
  /** The student confirmed: submit the chosen file now. */
  "submit.confirm": { request: z.object({ planId: Id }), response: z.object({ attempt: z.number().int().nullable(), submittedAt: z.string().nullable(), files: z.array(z.string()) }) },
  /** The student confirmed a rule: submit the chosen file this many minutes before the deadline if still not submitted. */
  "submit.schedule": { request: z.object({ planId: Id, minutesBefore: z.number().int().min(1).max(10080) }), response: z.object({ ruleId: Id, at: z.string() }) },
  "submit.rules": { request: z.object({}), response: z.object({ rules: z.array(z.object({ id: Id, courseId: Id, resourceId: Id, title: z.string(), fileName: z.string(), at: z.string(), state: z.enum(["waiting", "submitting", "done", "already", "failed", "cancelled"]), message: z.string().optional(), finishedAt: z.string().optional() })) }) },
  "submit.cancelRule": { request: z.object({ ruleId: Id }), response: z.object({}) },
  "session.create": {
    request: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("course"), courseId: Id, engine: z.enum(["structured", "native", "chat"]).optional(), title: z.string().min(1).max(200) }),
      // No courseId field at all: the browsing course cannot be passed in.
      z.strictObject({ mode: z.literal("independent"), engine: z.enum(["structured", "native", "chat"]).optional(), title: z.string().min(1).max(200) }),
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
    request: z.object({ courseId: Id, title: z.string().trim().min(1).max(200).optional(), weekId: Id.optional(), lectureSourceId: LectureSourceId.optional() })
      .refine((r) => r.lectureSourceId === undefined || r.weekId !== undefined, "a lecture is chosen within a week"),
    response: z.object({ recording: Recording }),
  },
  /** WBS-065: files a recording (also an older one without a week) under a week and, optionally, one of its lectures. */
  "recording.assign": {
    request: z.object({ recordingId: Id, weekId: Id, lectureSourceId: LectureSourceId.optional() }),
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
    response: z.object({ assets: z.array(MediaAsset), recordings: z.array(Recording), jobs: z.array(TranscriptionJob), transcripts: z.array(Transcript), transcriptionPaused: z.boolean().optional(), importedDocs: z.record(Id, z.array(ImportedDocKind)).optional(),
      /** WBS-087: originals deleted to free space (their transcripts stay). */
      removed: z.array(Id).optional(),
      /** WBS-073: for each queued transcription, how many run before it and what is running now. */
      waiting: z.record(Id, z.object({ ahead: z.number().int().nonnegative(), runningTitle: z.string().max(300).optional(), runningProgress: z.number().min(0).max(1).optional() })).optional(), downloads: z.array(z.object({ id: Id, courseId: Id, sourceId: z.string().regex(/^[\w-]{1,64}$/).optional(), title: z.string(), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]), receivedBytes: z.number().optional(), totalBytes: z.number().optional(), errorCode: z.string().optional() })) }),
  },
  /** Online lectures the account may download; `week` is the LMS module (주차) title, shown as given. */
  /** WBS-087: recordings and downloaded videos kept on this Mac, per course of the signed-in account. */
  "media.storage": { request: z.object({}), response: z.object({ courses: z.array(z.object({ courseId: Id, title: z.string(), items: z.array(z.object({ assetId: Id, title: z.string(), kind: z.enum(["recording", "video"]), bytes: z.number().int().nonnegative(), createdAt: z.string(), transcribed: z.boolean(), removedAt: z.string().optional() })) })) }) },
  /** WBS-087: deletes chosen originals that have a finished transcript; transcripts and notes stay. */
  "media.removeOriginals": { request: z.object({ courseId: Id, assetIds: z.array(Id).min(1).max(500) }), response: z.object({ removed: z.number().int().nonnegative(), freedBytes: z.number().int().nonnegative(), skipped: z.array(z.object({ assetId: Id, reason: z.string() })) }) },
  "media.videos": { request: z.object({ courseId: Id }), response: z.object({ videos: z.array(z.object({ sourceId: z.string().regex(/^[\w-]{1,64}$/), title: z.string().min(1).max(200), week: z.string().min(1).max(200).optional() })) }) },
  "media.download": { request: z.object({ courseId: Id, sourceId: z.string().regex(/^[\w-]{1,64}$/) }), response: z.object({ downloadId: Id }) },
  "media.cancelDownload": { request: z.object({ courseId: Id, downloadId: Id }), response: z.object({}) },
  "media.original": { request: z.object({ courseId: Id, assetId: Id }), response: z.object({ bytes: z.instanceof(Uint8Array), mediaType: z.string() }) },
  "media.open": { request: z.object({ courseId: Id, assetId: Id }), response: z.object({}) },
  "media.retry": { request: z.object({ courseId: Id, jobId: Id }), response: z.object({}) },
  /**
   * WBS-077: the user picks audio files (any common format). The host checks
   * each (readable, size, duration) and keeps the paths; the screen gets names only.
   */
  "media.chooseAudio": {
    request: z.object({}),
    response: z.object({
      planId: Id.optional(),
      files: z.array(z.object({ id: Id, name: z.string().max(200), bytes: z.number().int().nonnegative(), durationMs: z.number().int().positive().optional(), startedAt: UtcTimestamp, problem: z.string().max(200).optional() })),
    }),
  },
  /** Copies the chosen files as recordings of the course, each under the week (and lecture) the user set; then transcribed. */
  "media.importAudio": {
    request: z.object({ planId: Id, courseId: Id, files: z.array(z.object({ id: Id, title: z.string().trim().min(1).max(200), weekId: Id.optional(), lectureSourceId: LectureSourceId.optional() })).min(1).max(200) }),
    response: z.object({ imported: z.number().int().nonnegative(), failed: z.array(z.object({ id: Id, message: z.string() })) }),
  },
  /** A copied note (정리본·교정 기록·전사 md·srt) of an imported original, as text. */
  /**
   * WBS-069: saves the user's corrections of a transcript version as a new
   * "corrected" version (same times, new text). The version edited stays as it was.
   */
  "media.saveCorrection": {
    request: z.object({ courseId: Id, assetId: Id, basedOnTranscriptId: Id, texts: z.array(z.string().max(MAX_SEGMENT_TEXT)).min(1).max(MAX_CORRECTION_SEGMENTS) }),
    response: z.object({ transcriptId: Id }),
  },
  /**
   * WBS-069: on request, the official Claude Code (subscription login, read-only
   * isolated run) turns a transcript version into a readable note, kept as the
   * "readable_app" document of that original. One at a time.
   */
  "media.makeReadable": { request: z.object({ courseId: Id, assetId: Id, transcriptId: Id }), response: z.object({ doc: z.literal("readable_app") }) },
  /** WBS-070: on request, Claude Code proposes assignment/exam announcements from a transcript version; nothing is saved. */
  "media.findMentions": { request: z.object({ courseId: Id, assetId: Id, transcriptId: Id }), response: z.object({ candidates: z.array(MentionCandidate) }) },
  /** WBS-070: the candidates the user confirmed go to the 과제 tab as "강의에서 언급됨". */
  "media.addMentions": { request: z.object({ courseId: Id, assetId: Id, candidates: z.array(MentionCandidate).min(1).max(50) }), response: z.object({ mentions: z.array(LectureMention) }) },
  "media.mentions": { request: z.object({ courseId: Id }), response: z.object({ mentions: z.array(LectureMention) }) },
  "media.removeMention": { request: z.object({ courseId: Id, mentionId: Id }), response: z.object({}) },
  /** WBS-071: a saved translation of a transcript version, if one was made (texts in segment order). */
  "media.translation": { request: z.object({ courseId: Id, assetId: Id, transcriptId: Id, language: PreferredLanguage }), response: z.object({ texts: z.array(z.string()).optional() }) },
  /** WBS-071: on request, Claude Code translates a version sentence by sentence; saved for next time. */
  "media.translate": { request: z.object({ courseId: Id, assetId: Id, transcriptId: Id, language: PreferredLanguage }), response: z.object({ texts: z.array(z.string()), untranslated: z.number().int().nonnegative() }) },
  /** WBS-073: everything running or waiting on this Mac (transcriptions in run order, downloads, Claude Code, import). */
  "media.queue": {
    request: z.object({}),
    response: z.object({
      transcriptionPaused: z.boolean(),
      items: z.array(z.object({
        kind: z.enum(["transcription", "download", "claude", "import"]),
        id: z.string().min(1).max(100),
        courseId: Id.optional(),
        courseTitle: z.string().max(200).optional(),
        title: z.string().max(400),
        status: z.enum(["running", "queued"]),
        progress: z.number().min(0).max(1).optional(),
        /** Queued transcriptions: how many run before it. */
        ahead: z.number().int().nonnegative().optional(),
      })),
    }),
  },
  "media.importedDoc": { request: z.object({ courseId: Id, assetId: Id, doc: ImportedDocKind }), response: z.object({ text: z.string() }) },
  /** Pauses all transcription on this Mac (the running job goes back to waiting and starts over on resume). */
  "media.pauseTranscription": { request: z.object({}), response: z.object({ paused: z.boolean() }) },
  "media.resumeTranscription": { request: z.object({}), response: z.object({ paused: z.boolean() }) },
  /** Stops one job; its original stays and "retry" can start it again. */
  "media.cancelTranscription": { request: z.object({ courseId: Id, jobId: Id }), response: z.object({}) },
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
  /** WBS-057: the LMS watch window closed; the status was read again. */
  z.object({ kind: z.literal("learning.watchClosed"), courseId: Id, moduleItemId: z.string() }),
  /** WBS-058: a confirmed automatic submission ran (or found the work already submitted, or failed). */
  z.object({ kind: z.literal("submit.auto"), courseId: Id, title: z.string(), ok: z.boolean(), message: z.string().optional() }),
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
