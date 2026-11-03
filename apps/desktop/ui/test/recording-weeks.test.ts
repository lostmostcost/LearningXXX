import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseLearningStatus, Recording, Week } from "@learningxxx/contracts";
import { estimateWeek, placeLabel, semesterStart, unfiledRecordings, weekNumber, weekRecordings } from "../src/recording-weeks.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const weekId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const weeks: Week[] = [1, 2, 3, 4, 5, 6, 7, 9, 10].map((n, order) => ({ id: weekId(n), courseId: COURSE, sourceWeekId: `m${n}`, label: `${n}주차`, order }));
const item = (week: string, unlockAt: string | null) => ({
  kind: "material" as const, title: "자료", weekLabel: week, completed: null, attendance: null, usesAttendance: false, period: null, unlockAt, dueAt: null, lockAt: null,
});
// Synthetic semester: week 1 is the week of Monday 2026-08-31 (Seoul). Week 1 opens Tue 00:00 Seoul,
// later weeks on Wednesdays; week 5's item opened a week late and week 6 has no opening time.
const status: CourseLearningStatus = {
  schemaVersion: 1, courseId: COURSE, fetchedAt: "2026-11-03T00:00:00Z", errors: [],
  items: [
    item("1주차", "2026-08-31T15:00:00Z"), item("2주차", "2026-09-09T05:45:00Z"), item("2주차", "2026-09-10T05:45:00Z"),
    item("3주차", "2026-09-16T05:45:00Z"), item("4주차", "2026-09-23T05:50:00Z"), item("5주차", "2026-10-07T05:50:00Z"), item("6주차", null),
  ],
};

test("week numbers come from the LMS label", () => {
  assert.equal(weekNumber("3주차"), 3);
  assert.equal(weekNumber("12 주차"), 12);
  assert.equal(weekNumber("오리엔테이션"), undefined);
});

test("the semester start is the Monday most weeks agree on, in Seoul time", () => {
  assert.equal(new Date(semesterStart(weeks, status)!).toISOString(), "2026-08-30T15:00:00.000Z", "Mon 2026-08-31 00:00 Seoul");
  assert.equal(semesterStart(weeks, undefined), undefined);
  assert.equal(semesterStart(weeks, { ...status, items: [item("6주차", null)] }), undefined);
});

test("today's week: by date from the start, clamped to the semester, nothing for a week the LMS does not have", () => {
  const at = (iso: string) => estimateWeek(weeks, status, new Date(iso))?.label;
  assert.equal(at("2026-11-03T03:00:00Z"), "10주차", "Tue 2026-11-03");
  assert.equal(at("2026-08-30T14:59:00Z"), "1주차", "Sunday before the semester → first week");
  assert.equal(at("2026-09-06T14:59:00Z"), "1주차", "Sunday 23:59 Seoul is still week 1");
  assert.equal(at("2026-09-06T15:00:00Z"), "2주차", "Monday 00:00 Seoul starts week 2");
  assert.equal(at("2026-10-20T03:00:00Z"), undefined, "week 8 has no LMS week (exam): the user picks");
  assert.equal(at("2026-12-30T03:00:00Z"), "10주차", "after the last week → last week");
  assert.equal(estimateWeek(weeks, undefined, new Date()), undefined);
});

const recording = (over: Partial<Recording>): Recording => ({
  schemaVersion: 1, id: "33333333-3333-4333-8333-000000000001", courseId: COURSE, title: "녹음", startedAt: "2026-09-15T01:00:00Z", status: "finalized",
  durationMs: 1000, originalAssetId: "44444444-4444-4444-8444-000000000001", ...over,
} as Recording);

test("older recordings without a week get a suggestion from their date; failed ones are left out", () => {
  const rows = unfiledRecordings([
    recording({ id: "33333333-3333-4333-8333-000000000002", startedAt: "2026-10-20T01:00:00Z" }),
    recording({}),
    recording({ id: "33333333-3333-4333-8333-000000000003", weekId: weekId(1) }),
    recording({ id: "33333333-3333-4333-8333-000000000007", weekId: weekId(99), startedAt: "2026-09-02T01:00:00Z" }),
    { schemaVersion: 1, id: "33333333-3333-4333-8333-000000000004", courseId: COURSE, title: "x", startedAt: "2026-09-15T01:00:00Z", status: "failed", errorCode: "RECORDING_INTERRUPTED" },
  ], weeks, status);
  assert.deepEqual(rows.map((r) => [r.recording.startedAt, r.suggested?.label]), [["2026-09-02T01:00:00Z", "1주차"], ["2026-09-15T01:00:00Z", "3주차"], ["2026-10-20T01:00:00Z", undefined]], "a week the LMS no longer lists counts as unfiled");
});

test("a week's recordings show their saved original and transcription state", () => {
  const asset = { id: "44444444-4444-4444-8444-000000000001" } as never;
  const media = { assets: [asset], jobs: [], recordings: [
    recording({ weekId: weekId(3), startedAt: "2026-09-17T01:00:00Z" }),
    recording({ id: "33333333-3333-4333-8333-000000000005", weekId: weekId(3), startedAt: "2026-09-15T01:00:00Z", status: "recording", durationMs: undefined, originalAssetId: undefined } as never),
    recording({ id: "33333333-3333-4333-8333-000000000006", weekId: weekId(4) }),
  ] };
  assert.deepEqual(weekRecordings(media, weekId(3)).map((r) => r.status), ["녹음 중", "녹음 · 전사 대기"]);
  assert.equal(placeLabel(recording({ weekId: weekId(3), lectureSourceId: "v1" }), weeks, [{ sourceId: "v1", title: "1차시" }]), "3주차 · 1차시");
  assert.equal(placeLabel(recording({ weekId: weekId(3), lectureSourceId: "gone" }), weeks, []), "3주차");
  assert.equal(placeLabel(recording({}), weeks, []), "주차 미정");
});
