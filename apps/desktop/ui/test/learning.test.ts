import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseLearningStatus, LearningItem, Resource } from "@learningxxx/contracts";
import { badges, canRecordView, itemForResource, notOpenYet, todos, upcoming, weekProgress } from "../src/learning.ts";

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

test("WBS-057: the next lecture to watch is the earliest-due open one not attended", async () => {
  const { nextUnwatched, canWatch } = await import("../src/learning.ts");
  const base = { completed: false, usesAttendance: true, unlockAt: null, lockAt: null, attendance: "none" as const, period: "open" as const };
  const status = { schemaVersion: 1 as const, courseId: "11111111-1111-4111-8111-000000000001", fetchedAt: "2026-11-03T00:00:00Z", errors: [], items: [
    { ...base, kind: "video" as const, title: "attended", moduleItemId: "1", dueAt: "2026-11-01T00:00:00Z", attendance: "attendance" as const },
    { ...base, kind: "video" as const, title: "later", moduleItemId: "2", dueAt: "2026-11-20T00:00:00Z" },
    { ...base, kind: "video" as const, title: "sooner", moduleItemId: "3", dueAt: "2026-11-10T00:00:00Z" },
    { ...base, kind: "video" as const, title: "not open", moduleItemId: "4", dueAt: "2026-11-05T00:00:00Z", period: "not_open" as const },
    { ...base, kind: "video" as const, title: "closed", moduleItemId: "5", dueAt: "2026-10-01T00:00:00Z", lockAt: "2026-10-02T00:00:00Z" },
    { ...base, kind: "material" as const, title: "pdf", moduleItemId: "6", dueAt: "2026-11-04T00:00:00Z" },
  ] };
  assert.equal(nextUnwatched(status, new Date("2026-11-03T00:00:00Z"))?.title, "sooner");
  assert.equal(nextUnwatched(undefined, new Date()), undefined);
  assert.equal(canWatch(status.items[3]), false);
  assert.equal(canWatch(status.items[1]), true);
  assert.equal(canWatch(status.items[5]), false);
});

test("WBS-059: quizzes list their state, period and why one cannot open here", async () => {
  const { quizRows } = await import("../src/learning.ts");
  const q = { kind: "quiz" as const, completed: null, attendance: null, usesAttendance: false, period: null, unlockAt: null, lockAt: null, dueAt: null };
  const status = { schemaVersion: 1 as const, courseId: "11111111-1111-4111-8111-000000000001", fetchedAt: "2026-11-03T00:00:00Z", errors: [], items: [
    { ...q, title: "잠금", dueAt: "2026-11-05T00:00:00Z", quiz: { quizId: "5", lockdownBrowser: true, allowedAttempts: 1, questionCount: 10 } },
    { ...q, title: "연습", dueAt: "2026-11-04T00:00:00Z", quiz: { quizId: "6", lockdownBrowser: false, allowedAttempts: -1, questionCount: null },
      submission: { state: "graded" as const, submittedAt: null, late: false, missing: false, attempt: 1, types: ["online_quiz"], allowedExtensions: [], allowedAttempts: -1 } },
    { ...q, title: "예정", unlockAt: "2026-12-01T00:00:00Z", quiz: { lockdownBrowser: false, allowedAttempts: null, questionCount: null } },
  ] };
  const rows = quizRows(status, new Date("2026-11-03T00:00:00Z"), (u) => u.slice(5, 10));
  assert.deepEqual(rows.map((r) => [r.item.title, r.status, r.blocked ?? null]), [
    ["연습", "응시함 · 채점됨 · 마감 11-04 · 응시 횟수 제한 없음", null],
    ["잠금", "미응시 · 마감 11-05 · 응시 1회 · 10문항", "학교 전용 브라우저(LockDown Browser)가 필요합니다"],
    ["예정", "미응시 · 12-01부터", "LMS에서 직접 여세요"],
  ]);
});

test("WBS-084: work whose start time is still ahead is not a to-do but listed as upcoming", () => {
  const now = new Date("2026-11-03T00:00:00Z");
  const s = status([
    item({ title: "다음 주에 열림", kind: "assignment", completed: null, period: null, unlockAt: "2026-11-05T00:00:00Z", dueAt: "2026-11-12T00:00:00Z", submission: submission("unsubmitted") }),
    item({ title: "LMS가 공개 전", completed: false, period: "not_open" }),
    item({ title: "열림", completed: false, unlockAt: "2026-11-01T00:00:00Z" }),
    item({ title: "이미 제출, 나중에 열림", kind: "assignment", completed: null, unlockAt: "2026-11-05T00:00:00Z", submission: submission("submitted") }),
  ]);
  assert.deepEqual(todos([s], now).map((t) => t.item.title), ["열림"]);
  assert.deepEqual(upcoming([s], now).map((t) => t.item.title), ["다음 주에 열림", "LMS가 공개 전"]);
  assert.equal(notOpenYet(item({ unlockAt: "2026-11-02T23:59:59Z" }), now), false);
});
