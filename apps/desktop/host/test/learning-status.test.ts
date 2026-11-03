import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Course } from "@learningxxx/contracts";
import { LearningStatusService, mapLearningX, mergeCanvas, utc, watchedSeconds, type LearningSources, type LearningStatusOptions } from "../src/learning-status.ts";

/** Synthetic LearningX modules shaped like the WBS-054 measurement. */
const MODULES = [
  {
    title: "6주차",
    module_items: [
      { module_item_id: 501, content_id: 9001, content_type: "attendance_item", title: "1차시 강의", completed: true, completion_determinable: true, attendance_status: "attendance",
        content_data: { use_attendance: true, lecture_period_status: "late_after", unlock_at: "2026-10-06T00:00:00+09:00", due_at: "2026-10-12T23:59:00+09:00", lock_at: "2027-02-28T23:59:00+09:00",
          item_content_data: { content_type: "movie", content_id: "abc123", duration: 2452, progress_support: true } } },
      { module_item_id: 502, content_id: 9002, content_type: "attendance_item", title: "강의 자료", completed: false, completion_determinable: true, attendance_status: "none",
        content_data: { use_attendance: false, lecture_period_status: "open", item_content_data: { content_type: "pdf", content_id: "pdf777" } } },
      { module_item_id: 503, content_id: 77, content_type: "assignment", title: "6주차 과제", completed: false, completion_determinable: true,
        content_data: { use_attendance: false, due_at: "2026-10-12T23:59:00+09:00" } },
      { content_type: "sub_header", title: "구분선" },
    ],
  },
  { title: "7주차", module_items: [
    { module_item_id: 601, content_id: 9003, content_type: "attendance_item", title: "온라인 실시간", completed: null, completion_determinable: false, attendance_status: "absent",
      content_data: { use_attendance: true, lecture_period_status: "not_open", item_content_data: { content_type: "zoom" } } },
  ] },
];

test("weekly-learning items carry the LMS badges, deadlines in UTC and a join key to collected files", () => {
  const { items, detailIds } = mapLearningX(MODULES);
  assert.deepEqual(items.map((i) => [i.kind, i.weekLabel, i.completed, i.attendance, i.period, i.sourceRef]), [
    ["video", "6주차", true, "attendance", "late_after", "commons:abc123"],
    ["material", "6주차", false, null, "open", "commons:pdf777"],
    ["assignment", "6주차", false, null, null, "assignment:77"],
    ["live", "7주차", null, "absent", "not_open", undefined],
  ]);
  assert.equal(items[0]!.dueAt, "2026-10-12T14:59:00Z");
  assert.equal(items[0]!.durationSec, 2452);
  assert.equal(items[0]!.moduleItemId, "501");
  assert.deepEqual([...detailIds], [[0, "9001"]], "only videos need the watched-time detail");
});

test("watched seconds come from the item detail", () => {
  assert.equal(watchedSeconds({ attendance_data: { progress: 1062.06, completed: false } }), 1062.06);
  assert.equal(watchedSeconds({}), undefined);
});

test("Canvas adds submission state to listed assignments and keeps unlisted ones and quizzes", () => {
  const { items } = mapLearningX(MODULES);
  const merged = mergeCanvas(items, [
    { id: 77, name: "6주차 과제", due_at: "2026-10-12T14:59:00Z", submission_types: ["online_upload"], allowed_extensions: ["PDF"], allowed_attempts: -1,
      submission: { workflow_state: "submitted", submitted_at: "2026-10-11T10:00:00Z", late: false, missing: false, attempt: 1 } },
    { id: 78, name: "기말 보고서", due_at: "2026-12-15T14:59:00Z", submission_types: ["online_upload"], submission: { workflow_state: "unsubmitted", late: false, missing: true, attempt: null } },
    { id: 79, name: "퀴즈 1", quiz_id: 5, submission_types: ["online_quiz"], submission: { workflow_state: "graded", attempt: 1 } },
  ], [{ id: 5, title: "퀴즈 1", require_lockdown_browser: true, allowed_attempts: 1, question_count: 10 }, { id: 6, title: "연습 퀴즈", require_lockdown_browser: false }]);
  const byRef = new Map(merged.map((i) => [i.sourceRef, i]));
  assert.equal(byRef.get("assignment:77")!.submission!.state, "submitted");
  assert.deepEqual(byRef.get("assignment:77")!.submission!.allowedExtensions, ["pdf"]);
  assert.equal(byRef.get("assignment:78")!.submission!.missing, true, "a Canvas-only assignment is still listed");
  assert.equal(byRef.get("assignment:79")!.kind, "quiz");
  assert.equal(byRef.get("assignment:79")!.quiz!.lockdownBrowser, true);
  assert.equal(byRef.get("quiz:6")!.kind, "quiz", "a quiz with no assignment still shows");
  assert.equal(merged.length, items.length + 3);
});

test("dates that are missing or unreadable stay null", () => {
  assert.equal(utc(null), null);
  assert.equal(utc("not a date"), null);
});

function service(sources: Partial<LearningSources>, at = "2026-11-03T00:00:00Z", openItemPage?: LearningStatusOptions["openItemPage"]) {
  const root = mkdtempSync(join(tmpdir(), "wbs055-"));
  const course: Course = { id: "11111111-1111-4111-8111-000000000001", accountKey: "acct_synthetic01", termId: "1", sourceCourseId: "95899", title: "합성" };
  let now = new Date(at);
  const calls = { modules: 0 };
  const full: LearningSources = {
    modules: async () => { calls.modules += 1; return MODULES; },
    attendanceItem: async () => ({ attendance_data: { progress: 600 } }),
    assignments: async () => [],
    quizzes: async () => { throw new Error("quizzes off"); },
    ...sources,
  };
  const s = new LearningStatusService({ root, sources: full, ensureSignedIn: async () => {}, courses: async () => [course], accountKey: () => course.accountKey, now: () => now, ...(openItemPage ? { openItemPage } : {}) });
  return { s, course, calls, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

test("the status is cached, refreshed on request, and a course with quizzes turned off still reads", async () => {
  const { s, course, calls, advance } = service({});
  const first = (await s.status(course.id))!;
  assert.equal(first.items.find((i) => i.kind === "video")!.progressSec, 600);
  assert.deepEqual(first.errors, []);
  await s.status(course.id);
  assert.equal(calls.modules, 1, "served from cache");
  await s.status(course.id, true);
  assert.equal(calls.modules, 2, "refresh asks the LMS again");
  advance(11 * 60_000);
  await s.status(course.id);
  assert.equal(calls.modules, 3, "an old cache is renewed");
  assert.equal(await s.status("22222222-2222-4222-8222-000000000002"), undefined, "unknown course");
});

test("when the LMS cannot be read at all, the last good status stays with the error", async () => {
  let fail = false;
  const { s, course } = service({ modules: async () => { if (fail) throw Object.assign(new Error("x"), { appError: { code: "AUTH_REQUIRED" } }); return MODULES; } });
  await s.status(course.id);
  fail = true;
  const after = (await s.status(course.id, true))!;
  assert.ok(after.items.length > 0);
  assert.equal(after.errors[0]!.code, "AUTH_REQUIRED");
});

test("a view record opens only an open, unfinished LMS material and reads the status again", async () => {
  const opened: string[] = [];
  let viewed = false;
  const modules = async () => viewed ? [{ ...MODULES[0]!, module_items: MODULES[0]!.module_items.map((i) => i.module_item_id === 502 ? { ...i, completed: true } : i) }] : MODULES;
  const { s, course, calls } = service({ modules: async () => { calls.modules += 1; return modules(); } }, undefined, async (page) => { opened.push(`${page.sourceCourseId}/${page.moduleItemId}`); viewed = true; return true; });
  const after = (await s.recordView(course.id, "502"))!;
  assert.deepEqual(opened, ["95899/502"]);
  assert.equal(after.items.find((i) => i.moduleItemId === "502")!.completed, true, "status is read again after the record");
  await s.recordView(course.id, "502");
  assert.equal(opened.length, 1, "a completed material is not opened again");
  const code = (e: unknown) => (e as { appError: { code: string } }).appError.code;
  await assert.rejects(s.recordView(course.id, "501"), (e) => code(e) === "SCOPE_VIOLATION", "videos need real watching (WBS-057)");
  await assert.rejects(s.recordView(course.id, "503"), (e) => code(e) === "SCOPE_VIOLATION", "assignments are not views");
  await assert.rejects(s.recordView(course.id, "999"), (e) => code(e) === "SCOPE_VIOLATION");
  await assert.rejects(s.recordView("22222222-2222-4222-8222-000000000002", "502"), (e) => code(e) === "NOT_FOUND");
  assert.equal(opened.length, 1);
});

test("a view the LMS did not record fails retryably; the same item is opened once at a time", async () => {
  let release!: (ok: boolean) => void;
  let opens = 0;
  const { s, course } = service({}, undefined, () => { opens += 1; return new Promise<boolean>((r) => { release = r; }); });
  const a = s.recordView(course.id, "502");
  const b = s.recordView(course.id, "502");
  await new Promise((r) => setTimeout(r, 10));
  release(false);
  for (const p of [a, b]) await assert.rejects(p, (e) => (e as { appError: { code: string; retryable: boolean } }).appError.retryable === true);
  assert.equal(opens, 1);
});

test("without a page opener view records are not offered", async () => {
  const { s, course } = service({});
  await assert.rejects(s.recordView(course.id, "502"), (e) => (e as { appError: { code: string } }).appError.code === "NOT_FOUND");
});
