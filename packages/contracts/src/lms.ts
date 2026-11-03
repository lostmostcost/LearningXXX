import { z } from "zod";
import { AccountKey, Id, SchemaVersion, Sha256, StorageKey, UtcTimestamp } from "./common.ts";
import { AppError } from "./errors.ts";

/** SPEC-001 data model, local manual collection (CR-001, ADR-002). */

export const Course = z.object({
  id: Id,
  accountKey: AccountKey,
  termId: z.string().min(1),
  sourceCourseId: z.string().min(1),
  title: z.string().min(1),
});
export type Course = z.infer<typeof Course>;

export const Week = z.object({
  id: Id,
  courseId: Id,
  sourceWeekId: z.string().min(1),
  /** Original LMS label, shown as-is. */
  label: z.string().min(1),
  /** Display order, independent from the label. */
  order: z.number().int().nonnegative(),
});
export type Week = z.infer<typeof Week>;

/** `manual` = user upload; never confused with LMS-collected material. */
export const ResourceKind = z.enum(["file", "notice", "assignment"]);
export const ResourceSource = z.enum(["lms", "manual"]);

export const Resource = z.object({
  id: Id,
  courseId: Id,
  /** Absent for course-level notices. */
  weekId: Id.optional(),
  kind: ResourceKind,
  source: ResourceSource,
  sourceId: z.string().min(1),
  sourceUrl: z.url().optional(),
  title: z.string().min(1),
  /** Increments only when the source content changes; title edits keep the id. */
  revision: z.number().int().positive(),
  updatedAt: UtcTimestamp,
});
export type Resource = z.infer<typeof Resource>;

export const Asset = z.object({
  id: Id,
  resourceId: Id,
  mediaType: z.string().regex(/^[a-z]+\/[0-9a-z.+-]+$/),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256,
  /** Content-addressed location; identical hashes reuse one stored original. */
  storageKey: StorageKey,
  originalName: z.string().min(1),
});
export type Asset = z.infer<typeof Asset>;

/** No submission/grading actions. Unclear deadlines stay null. */
export const AssignmentMetadata = z.object({
  resourceId: Id,
  dueAt: UtcTimestamp.nullable(),
  timezone: z.string().min(1),
  /** How dueAt was interpreted when the LMS gave no explicit zone. */
  timezoneBasis: z.enum(["source_explicit", "assumed_asia_seoul"]),
  submissionUrl: z.url().optional(),
});
export type AssignmentMetadata = z.infer<typeof AssignmentMetadata>;

/** A partial failure is never reported as success. */
export const SyncRunStatus = z.enum(["running", "succeeded", "partial", "failed", "interrupted"]);

export const SyncRun = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    accountKey: AccountKey,
    courseId: Id.optional(),
    trigger: z.literal("manual"),
    scope: z.enum(["course", "all_courses"]),
    cursor: z.string().optional(),
    startedAt: UtcTimestamp,
    endedAt: UtcTimestamp.optional(),
    status: SyncRunStatus,
    errors: z.array(AppError.and(z.object({ resourceSourceId: z.string().optional() }))),
  })
  .superRefine((r, ctx) => {
    const ended = r.status !== "running";
    if (ended !== (r.endedAt !== undefined)) {
      ctx.addIssue({ code: "custom", message: "endedAt is required exactly when status is not running" });
    }
    if ((r.status === "partial" || r.status === "failed") && r.errors.length === 0) {
      ctx.addIssue({ code: "custom", message: `${r.status} sync run must record at least one error` });
    }
    if (r.status === "succeeded" && r.errors.length > 0) {
      ctx.addIssue({ code: "custom", message: "succeeded sync run cannot carry errors; use partial" });
    }
  });
export type SyncRun = z.infer<typeof SyncRun>;

/** WBS-067: the LMS's own HTML of a notice or assignment, kept as sent; the UI shows it through an allow-list, never as HTML. */
export const MAX_BODY_CHARS = 300_000;

export const ManifestItem = z.object({
  resource: Resource,
  assets: z.array(Asset),
  assignment: AssignmentMetadata.optional(),
  body: z.string().max(MAX_BODY_CHARS).optional(),
});

export const Tombstone = z.object({
  resourceId: Id,
  removedAt: UtcTimestamp,
  reason: z.enum(["deleted_at_source", "hidden_at_source"]),
});

/**
 * Local collection manifest (replaces the server DeliveryManifest of v0.1.0).
 * The previous good manifest stays active until this one is fully verified.
 */
export const CollectionManifest = z
  .object({
    schemaVersion: SchemaVersion,
    course: Course,
    weeks: z.array(Week),
    revision: z.number().int().positive(),
    syncRunId: Id,
    generatedAt: UtcTimestamp,
    items: z.array(ManifestItem),
    tombstones: z.array(Tombstone),
  })
  .superRefine((m, ctx) => {
    const weekIds = new Set(m.weeks.map((w) => w.id));
    const resourceIds = new Set<string>();
    for (const w of m.weeks) {
      if (w.courseId !== m.course.id) ctx.addIssue({ code: "custom", message: `week ${w.id} belongs to another course` });
    }
    for (const { resource, assets, assignment } of m.items) {
      if (resourceIds.has(resource.id)) ctx.addIssue({ code: "custom", message: `duplicate resource ${resource.id}` });
      resourceIds.add(resource.id);
      if (resource.courseId !== m.course.id) ctx.addIssue({ code: "custom", message: `resource ${resource.id} belongs to another course` });
      if (resource.weekId && !weekIds.has(resource.weekId)) ctx.addIssue({ code: "custom", message: `resource ${resource.id} references unknown week` });
      for (const a of assets) {
        if (a.resourceId !== resource.id) ctx.addIssue({ code: "custom", message: `asset ${a.id} is attached to the wrong resource` });
      }
      if ((resource.kind === "assignment") !== (assignment !== undefined)) {
        ctx.addIssue({ code: "custom", message: `assignment metadata must exist exactly for assignment ${resource.id}` });
      }
      if (assignment && assignment.resourceId !== resource.id) ctx.addIssue({ code: "custom", message: "assignment metadata resource mismatch" });
    }
    for (const t of m.tombstones) {
      if (resourceIds.has(t.resourceId)) ctx.addIssue({ code: "custom", message: `resource ${t.resourceId} is both live and tombstoned` });
    }
  });
export type CollectionManifest = z.infer<typeof CollectionManifest>;
