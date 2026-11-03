import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseLearningStatus, LearningItem } from "@learningxxx/contracts";
import { buildLibrary } from "../src/library.ts";
import { FIXTURE_MANIFEST } from "../src/fixtures.ts";
import { tasksByWeek } from "../src/tasks.ts";

const base = { completed: null, attendance: null, usesAttendance: false, period: null, unlockAt: null, lockAt: null, dueAt: null } as const;
const submission = (state: "submitted" | "unsubmitted") => ({ state, submittedAt: null, late: false, missing: false, attempt: null, types: ["online_upload"], allowedExtensions: [], allowedAttempts: -1 });

test("WBS-075: tasks are grouped by week in course order, split into to-do and submitted", () => {
  const library = buildLibrary(FIXTURE_MANIFEST);
  const assignments = [...library.weeks.flatMap((w) => w.entries), ...library.other].filter((e) => e.resource.kind === "assignment");
  const [first, second] = assignments;
  const status: CourseLearningStatus = { schemaVersion: 1, courseId: library.course.id, fetchedAt: "2026-11-03T00:00:00Z", errors: [], items: [
    { ...base, kind: "assignment", title: first!.resource.title, sourceRef: `assignment:${first!.resource.sourceId}`, submission: submission("submitted") } as LearningItem,
    { ...base, kind: "quiz", title: "LMS에만 있는 퀴즈", weekLabel: library.weeks[0]!.week.label, sourceRef: "quiz:9", dueAt: "2026-11-10T00:00:00Z" } as LearningItem,
    { ...base, kind: "assignment", title: "주차 없는 과제", sourceRef: "assignment:999", submission: submission("unsubmitted") } as LearningItem,
  ] };
  const weeks = tasksByWeek(library, status);
  const labelOf = (id: string | undefined) => library.weeks.find((w) => w.week.id === id)?.week.label;
  const firstWeek = weeks.find((w) => w.label === labelOf(first!.resource.weekId))!;
  assert.deepEqual(firstWeek.done.map((r) => r.title), [first!.resource.title], "submitted goes under 제출한 과제");
  const secondWeek = weeks.find((w) => w.label === labelOf(second!.resource.weekId))!;
  assert.ok(secondWeek.todo.some((r) => r.title === second!.resource.title && r.done === undefined), "no LMS state yet: listed to do, marked unknown");
  assert.deepEqual(weeks.find((w) => w.label === library.weeks[0]!.week.label)!.todo.map((r) => [r.title, r.kind]), [["LMS에만 있는 퀴즈", "quiz"]]);
  assert.equal(weeks.at(-1)!.label, "주차 없음");
  assert.deepEqual(weeks.at(-1)!.todo.map((r) => r.title), ["주차 없는 과제"]);
  const order = library.weeks.map((w) => w.week.label);
  const shown = weeks.filter((w) => w.label !== "주차 없음").map((w) => order.indexOf(w.label));
  assert.deepEqual(shown, [...shown].sort((a, b) => a - b), "course week order");
  assert.ok(weeks.every((w) => w.todo.length + w.done.length > 0), "weeks without tasks are left out");
});
