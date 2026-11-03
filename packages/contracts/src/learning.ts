import { z } from "zod";
import { AppError } from "./errors.ts";
import { Id, SchemaVersion, UtcTimestamp } from "./common.ts";

/**
 * CR-054 / WBS-055: what the LMS itself shows as learning progress, read only.
 * Field meanings were measured in WBS-054 (spikes/lms-status/README.md).
 */

export const LearningItemKind = z.enum(["material", "video", "live", "file", "assignment", "quiz", "other"]);
export type LearningItemKind = z.infer<typeof LearningItemKind>;

/** LearningX `attendance_status`: attended, not yet, or absent after the period. */
export const AttendanceState = z.enum(["attendance", "none", "absent"]);
/** LearningX `lecture_period_status`: open, not open yet, or in the late period. */
export const LecturePeriod = z.enum(["open", "not_open", "late_after"]);
export const SubmissionState = z.enum(["unsubmitted", "submitted", "pending_review", "graded"]);

export const LearningItem = z.object({
  /** Canvas module item id of the weekly-learning entry; opens the LMS page for it. Absent for items only Canvas lists. */
  moduleItemId: z.string().min(1).optional(),
  kind: LearningItemKind,
  title: z.string().min(1).max(300),
  /** The week (LearningX module) it sits in, as the LMS labels it. */
  weekLabel: z.string().max(200).optional(),
  /**
   * Joins the item to collected material: `commons:<contentId>` for LearningX
   * files (same as the manifest's sourceId), `assignment:<canvasId>` for assignments.
   */
  sourceRef: z.string().min(1).max(200).optional(),
  /** null where the LMS cannot judge completion for this item. */
  completed: z.boolean().nullable(),
  attendance: AttendanceState.nullable(),
  /** Counts toward attendance. */
  usesAttendance: z.boolean(),
  period: LecturePeriod.nullable(),
  unlockAt: UtcTimestamp.nullable(),
  dueAt: UtcTimestamp.nullable(),
  lockAt: UtcTimestamp.nullable(),
  /** Videos: seconds watched as the LMS counts them, and the video length. */
  progressSec: z.number().nonnegative().optional(),
  durationSec: z.number().positive().optional(),
  submission: z
    .object({
      state: SubmissionState,
      submittedAt: UtcTimestamp.nullable(),
      late: z.boolean(),
      missing: z.boolean(),
      attempt: z.number().int().nonnegative().nullable(),
      /** Canvas submission types, e.g. online_upload. */
      types: z.array(z.string().max(40)).max(10),
      allowedExtensions: z.array(z.string().max(20)).max(50),
      /** -1 = unlimited. */
      allowedAttempts: z.number().int().nullable(),
    })
    .optional(),
  quiz: z
    .object({
      /** WBS-059: Canvas quiz id, to open the quiz page when the weekly page does not list it. */
      quizId: z.string().regex(/^\d{1,20}$/).optional(),
      /** Needs the school's lockdown browser; cannot be taken in an app window. */
      lockdownBrowser: z.boolean(),
      allowedAttempts: z.number().int().nullable(),
      questionCount: z.number().int().nonnegative().nullable(),
    })
    .optional(),
});
export type LearningItem = z.infer<typeof LearningItem>;

export const CourseLearningStatus = z.object({
  schemaVersion: SchemaVersion,
  courseId: Id,
  fetchedAt: UtcTimestamp,
  items: z.array(LearningItem),
  /** Parts that could not be read (e.g. a course with quizzes turned off); the rest still shows. */
  errors: z.array(AppError),
});
export type CourseLearningStatus = z.infer<typeof CourseLearningStatus>;

/** WBS-082/085: one weekly class meeting as a syllabus states it (Seoul time). */
export const CourseMeeting = z.object({
  day: z.enum(["월", "화", "수", "목", "금", "토", "일"]),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  place: z.string().max(100).optional(),
}).refine((m) => m.start < m.end, { message: "end after start" });
export type CourseMeeting = z.infer<typeof CourseMeeting>;

/** WBS-086: the student's memo of a course week, with an AI-tidied copy beside it when asked. */
export const Memo = z.object({
  text: z.string(), updatedAt: z.string().nullable(),
  cleaned: z.object({ text: z.string(), at: z.string() }).optional(),
  /** The text before the tidied copy was used can be brought back. */
  canUndo: z.boolean(),
});
export type Memo = z.infer<typeof Memo>;
