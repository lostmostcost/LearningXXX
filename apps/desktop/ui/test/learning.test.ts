import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseLearningStatus, LearningItem, Resource } from "@learningxxx/contracts";
import { badges, canRecordView, itemForResource, todos, weekProgress } from "../src/learning.ts";

const base: LearningItem = { kind: "material", title: "자료", completed: false, attendance: null, usesAttendance: false, period: "open", unlockAt: null, dueAt: null, lockAt: null };
const item = (over: Partial<LearningItem>): LearningItem => ({ ...base, ...over });
const status = (items: LearningItem[]): CourseLearningStatus => ({ schemaVersion: 1, courseId: "11111111-1111-4111-8111-000000000001", fetchedAt: "2026-11-03T00:00:00Z", items, errors: [] });
const submission = (state: NonNullable<LearningItem["submission"]>["state"], over: Partial<NonNullable<LearningItem["submission"]>> = {}) => ({ state, submittedAt: null, late: false, missing: false, attempt: null, types: ["online_upload"], allowedExtensions: [], allowedAttempts: null, ...over });

test("badges read like the LMS: completion, attendance, submission, watched share", () => {
  assert.deepEqual(badges(item({ completed: true })).map((b) => b.text), ["완료"]);
  assert.deepEqual(badges(item({ kind: "video", usesAttendance: true, attendance: "none", durationSec: 200, progressSec: 50 })).map((b) => b.text), ["미출석", "시청 25%"]);
  assert.deepEqual(badges(item({ kind: "video", usesAttendance: true, attendance: "attendance", durationSec: 200, progressSec: 200 })).map((b) => b.text), ["출석"]);
  assert.deepEqual(badges(item({ kind: "assignment", submission: submission("submitted", { late: true }) })).map((b) => b.text), ["제출함", "지각 제출"]);
  assert.deepEqual(badges(item({ kind: "quiz", completed: null, quiz: { lockdownBrowser: true, allowedAttempts: 1, questionCount: 5 } })).map((b) => b.text), ["전용 브라우저 필요"]);
  assert.deepEqual(badges(item({ completed: null, period: "not_open" })).map((b) => b.text), ["공개 전"]);
});

test("a collected file finds its status by commons id, an assignment by Canvas id", () => {
  const s = status([item({ sourceRef: "commons:abc" }), item({ kind: "assignment", sourceRef: "assignment:77" })]);
  const res = (kind: Resource["kind"], sourceId: string) => ({ kind, sourceId }) as Resource;
  assert.equal(itemForResource(s, res("file", "commons:abc"))?.sourceRef, "commons:abc");
  assert.equal(itemForResource(s, res("assignment", "77"))?.sourceRef, "assignment:77");
  assert.equal(itemForResource(s, res("file", "999")), undefined);
});

test("week progress counts only items the LMS can judge", () => {
  assert.deepEqual(weekProgress([item({ completed: true }), item({ completed: false }), item({ completed: null }), item({ kind: "assignment", completed: null, submission: submission("graded") })]), { done: 2, total: 3 });
});

test("to-do lists open, unfinished work, earliest first, and leaves closed or finished items out", () => {
  const now = new Date("2026-11-03T00:00:00Z");
  const list = todos([status([
    item({ title: "다음 주 과제", kind: "assignment", completed: null, submission: submission("unsubmitted"), dueAt: "2026-11-10T00:00:00Z" }),
    item({ title: "지난 강의", kind: "video", usesAttendance: true, attendance: "none", period: "late_after", dueAt: "2026-10-20T00:00:00Z", lockAt: "2027-02-28T00:00:00Z" }),
    item({ title: "끝난 자료", completed: false, lockAt: "2026-10-01T00:00:00Z" }),
    item({ title: "다 본 자료", completed: true }),
    item({ title: "공개 전", completed: false, period: "not_open" }),
    item({ title: "종이 제출", kind: "assignment", completed: null, submission: submission("unsubmitted", { types: ["on_paper"] }) }),
    item({ title: "제출함", kind: "assignment", completed: null, submission: submission("submitted") }),
  ])], now);
  assert.deepEqual(list.map((t) => [t.item.title, t.overdue]), [["지난 강의", true], ["다음 주 과제", false]]);
});

test("only an open, unfinished LMS PDF in the viewer is recorded as viewed", () => {
  const now = new Date("2026-11-03T00:00:00Z");
  assert.equal(canRecordView(item({ moduleItemId: "502" }), now), true);
  assert.equal(canRecordView(item({ moduleItemId: "502", completed: true }), now), false, "already complete");
  assert.equal(canRecordView(item({ moduleItemId: "502", completed: null }), now), false, "the LMS does not judge it");
  assert.equal(canRecordView(item({ moduleItemId: "502", period: "not_open" }), now), false);
  assert.equal(canRecordView(item({ moduleItemId: "502", lockAt: "2026-11-01T00:00:00Z" }), now), false, "closed");
  assert.equal(canRecordView(item({ moduleItemId: "501", kind: "video", usesAttendance: true, attendance: "none" }), now), false, "videos need watching");
  assert.equal(canRecordView(item({}), now), false, "no LMS item page");
  assert.equal(canRecordView(undefined, now), false);
});
