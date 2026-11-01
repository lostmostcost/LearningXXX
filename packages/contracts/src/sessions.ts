import { z } from "zod";
import { Id, Sha256, UtcTimestamp } from "./common.ts";
import { ErrorCode } from "./errors.ts";

/** SPEC-002 session model. */

export const SessionMode = z.enum(["course", "independent"]);

/**
 * Independent sessions carry no course context at all (REQ-005): the course a
 * user is browsing is UI state, not a session field, so it cannot leak into
 * the CLI input. Their workspace folder name is a neutral UUID (WBS-002 #3).
 */
export const Session = z
  .object({
    appSessionId: Id,
    mode: SessionMode,
    courseId: Id.optional(),
    /** Set after the first run; independent sessions always start a new UUID. */
    cliSessionId: Id.optional(),
    /** Path relative to the app data root. */
    workspaceKey: z.string().min(1),
    title: z.string().min(1).max(200),
    createdAt: UtcTimestamp,
    lastUsedAt: UtcTimestamp,
    /**
     * Absolute folders the user granted to this one session for writing. Never
     * inherited, and never present on an independent session (SPEC-002).
     */
    externalFolders: z.array(z.string().startsWith("/")).optional(),
    /** Archive hides; it is not delete and does not reset CLI memory. */
    archivedAt: UtcTimestamp.optional(),
    status: z.enum(["idle", "running", "interrupted"]),
  })
  .superRefine((s, ctx) => {
    if (s.mode === "course" && !s.courseId) {
      ctx.addIssue({ code: "custom", message: "course session requires courseId" });
    }
    if (s.mode === "independent") {
      if (s.courseId) ctx.addIssue({ code: "custom", message: "independent session must not carry courseId" });
      if (s.externalFolders?.length) ctx.addIssue({ code: "custom", message: "independent session must not hold external folders" });
      if (!/^sessions\/[0-9a-f-]{36}$/.test(s.workspaceKey)) {
        ctx.addIssue({ code: "custom", message: "independent workspace must be sessions/<uuid> (no course name in path)" });
      }
    }
  });
export type Session = z.infer<typeof Session>;

/** idle → starting → streaming → awaiting_permission | completed | failed | cancelled. */
export const RunStatus = z.enum([
  "starting",
  "streaming",
  "awaiting_permission",
  "completed",
  "failed",
  "cancelled",
  /** Restored on app restart for runs that were active; never auto-resent. */
  "interrupted",
]);
export const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled", "interrupted"] as const;

export const Run = z
  .object({
    runId: Id,
    appSessionId: Id,
    /** De-duplicates double clicks: one requestId → at most one run. */
    requestId: Id,
    startedAt: UtcTimestamp,
    endedAt: UtcTimestamp.optional(),
    status: RunStatus,
    exitCode: z.number().int().optional(),
    errorCode: ErrorCode.optional(),
  })
  .superRefine((r, ctx) => {
    const terminal = (TERMINAL_RUN_STATUSES as readonly string[]).includes(r.status);
    if (terminal !== (r.endedAt !== undefined)) {
      ctx.addIssue({ code: "custom", message: "endedAt is required exactly for terminal runs" });
    }
    if ((r.status === "failed" || r.status === "interrupted") && !r.errorCode) {
      ctx.addIssue({ code: "custom", message: `${r.status} run requires errorCode` });
    }
    if (r.status === "completed" && r.errorCode) {
      ctx.addIssue({ code: "custom", message: "completed run cannot carry errorCode" });
    }
  });
export type Run = z.infer<typeof Run>;

/** Only user-confirmed attachments are sent to the CLI. */
export const Attachment = z.object({
  id: Id,
  runId: Id,
  sourceAssetId: Id.optional(),
  userConfirmed: z.literal(true),
  contentHash: Sha256,
  /** Copy inside the run's attachment folder, relative to the data root. */
  localKey: z.string().min(1),
  provenance: z.enum(["course_asset", "local_file", "capture", "transcript"]),
});
export type Attachment = z.infer<typeof Attachment>;

/** Staged outside the CLI workspace until the user confirms and sends it. */
export const PreparedAttachment = z.object({
  id: Id,
  appSessionId: Id,
  name: z.string().min(1).max(255),
  mediaType: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  contentHash: Sha256,
  provenance: z.enum(["course_asset", "local_file"]),
  sourceAssetId: Id.optional(),
  confirmed: z.boolean(),
});
export type PreparedAttachment = z.infer<typeof PreparedAttachment>;

/** SPEC-003 composer draft; frozen at send time. */
export const TextSelection = z
  .object({
    assetId: Id,
    page: z.number().int().positive().optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    text: z.string().min(1).max(20000),
  })
  .refine((s) => s.start === undefined || s.end === undefined || s.start <= s.end, {
    message: "selection start must not exceed end",
  });

export const ComposerDraft = z
  .object({
    text: z.string().max(100000),
    attachmentIds: z.array(Id),
    selection: TextSelection.optional(),
    captureIds: z.array(Id),
    targetSessionId: Id,
    /** Selection tools: en↔ko translation and easy explanation are separate. */
    intent: z.enum(["chat", "translate_en_ko", "translate_ko_en", "explain_simply"]),
  })
  .refine((d) => d.text.trim() !== "" || d.attachmentIds.length + d.captureIds.length > 0 || d.selection, {
    message: "draft must include text, an attachment, a capture or a selection",
  })
  .refine((d) => d.intent === "chat" || d.selection !== undefined, {
    message: "translate/explain requires a text selection",
  });
export type ComposerDraft = z.infer<typeof ComposerDraft>;
