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
