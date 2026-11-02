import { createHash } from "node:crypto";
import { Course, Week } from "@learningxxx/contracts";
import { z } from "zod";
import type { CanvasClient } from "./canvas-client.ts";
import { collectionError } from "./errors.ts";

const SourceId = z.union([z.number().int(), z.string().min(1)]).transform(String);

const CanvasCourse = z.object({
  id: SourceId,
  name: z.string().min(1),
  enrollment_term_id: SourceId,
});

const CanvasModule = z.object({
  id: SourceId,
  name: z.string().min(1),
  position: z.number().int(),
});

export interface DiscoveryInput {
  client: CanvasClient;
  accountKey: string;
  sourceCourseId: string;
}

export interface DiscoveredCourse {
  course: Course;
  weeks: Week[];
}

/** Reads one course and its modules. Canvas modules are the LMS weeks. */
export async function discoverCourse(input: DiscoveryInput): Promise<DiscoveredCourse> {
  const { client, accountKey, sourceCourseId } = input;
  if (!/^\d+$/.test(sourceCourseId)) throw new Error("sourceCourseId must be numeric");

  const rawCourse = await client.getObject(`/api/v1/courses/${sourceCourseId}`);
  const rawModules = await client.getList(`/api/v1/courses/${sourceCourseId}/modules?per_page=100`);

  const source = parseSource(CanvasCourse, rawCourse);
  if (source.id !== sourceCourseId) {
    throw collectionError("SOURCE_CHANGED", "LMS가 요청과 다른 과목을 돌려주었습니다.");
  }
  const modules = rawModules.map((m) => parseSource(CanvasModule, m));
  if (new Set(modules.map((m) => m.id)).size !== modules.length) {
    throw collectionError("SOURCE_CHANGED", "LMS 주차 목록에 중복이 있습니다.");
  }

  const termId = source.enrollment_term_id;
  const courseId = stableId("course", accountKey, termId, source.id);
  const course = Course.parse({ id: courseId, accountKey, termId, sourceCourseId: source.id, title: source.name });
  const weeks = modules
    .toSorted((a, b) => a.position - b.position)
    .map((m, order) =>
      Week.parse({ id: stableId("week", courseId, m.id), courseId, sourceWeekId: m.id, label: m.name, order }),
    );
  return { course, weeks };
}

const ListedCourse = z.object({
  id: SourceId,
  name: z.string().min(1).optional(),
  access_restricted_by_date: z.boolean().optional(),
});

/**
 * The courses this student is actively enrolled in (WBS-041), in Canvas order.
 * Courses hidden by date restrictions come back without a name and are skipped.
 */
export async function listActiveCourses(client: CanvasClient): Promise<string[]> {
  const raw = await client.getList("/api/v1/courses?enrollment_state=active&enrollment_type=student&per_page=100");
  const ids: string[] = [];
  for (const entry of raw) {
    const course = ListedCourse.safeParse(entry);
    if (!course.success || !course.data.name || course.data.access_restricted_by_date) continue;
    if (/^\d+$/.test(course.data.id) && !ids.includes(course.data.id)) ids.push(course.data.id);
  }
  return ids;
}

/**
 * Deterministic UUID, so collecting twice yields the same IDs and no duplicates.
 * The account partitions identity, so two accounts never share a course ID.
 */
export function stableId(...parts: string[]): string {
  const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function parseSource<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw collectionError("SOURCE_CHANGED", "LMS 응답 형식이 예상과 다릅니다.");
}
