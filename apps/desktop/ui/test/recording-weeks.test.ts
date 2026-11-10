import assert from "node:assert/strict";
import { test } from "node:test";
import type { CourseLearningStatus, Recording, Week } from "@learningxxx/contracts";
import { estimateWeek, mediaWeekGroups, placeLabel, semesterStart, unfiledRecordings, weekNumber, weekRecordings } from "../src/recording-weeks.ts";
import { SAMPLE_MEDIA, SAMPLE_VIDEO } from '../src/transcript-fixtures.ts';

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
  assert.equal(at("2026-09-06T15:00:00Z"), "1주차", "WBS-105: Monday 9/7 is still week 1 (the semester opened on Tuesday 9/1)");
  assert.equal(at("2026-09-07T14:59:00Z"), "1주차", "Monday 23:59 Seoul is still week 1");
  assert.equal(at("2026-09-07T15:00:00Z"), "2주차", "Tuesday 00:00 Seoul starts week 2");
  assert.equal(at("2026-11-09T03:00:00Z"), "10주차", "Monday 11/9 is week 10");
  assert.equal(at("2026-10-20T03:00:00Z"), undefined, "week 8 has no LMS week (exam): the user picks");
  assert.equal(at("2026-12-30T03:00:00Z"), "10주차", "after the last week → last week");
  assert.equal(estimateWeek(weeks, undefined, new Date("2026-09-15T03:00:00Z"))?.label, "3주차", "WBS-105: without LMS openings the academic calendar decides");
});

const recording = (over: Partial<Recording>): Recording => ({
  schemaVersion: 1, id: "33333333-3333-4333-8333-000000000001", courseId: COURSE, title: "녹음", startedAt: "2026-09-15T01:00:00Z", status: "finalized",
  durationMs: 1000, originalAssetId: "44444444-4444-4444-8444-000000000001", ...over,
} as Recording);

test('media browsing keeps every LMS week, groups saved originals, and retains unfiled and orphan originals', () => {
  const first = recording({ id: 'first', weekId: weekId(1) });
  const missing = recording({ id: 'missing', weekId: 'removed-week' });
  const original = { ...SAMPLE_MEDIA, courseId: COURSE, source: { type: 'recording' as const, recordingId: first.id } };
  const orphan = { ...original, id: 'orphan', source: { type: 'recording' as const, recordingId: 'unknown' } };
  const oldWeek = { ...original, id: 'old-week', source: { type: 'recording' as const, recordingId: missing.id } };
  const video = { ...SAMPLE_VIDEO, courseId: COURSE };
  const groups = mediaWeekGroups(COURSE, weeks, { assets: [original, video, oldWeek, orphan, { ...original, id: 'foreign', courseId: 'another-course' }], recordings: [first, missing] }, [{ sourceId: 'synthetic-video', week: '2주차' }]);
  assert.equal(groups.length, weeks.length + 1);
  assert.deepEqual(groups[0]!.assets.map(a => a.id), [original.id]);
  assert.deepEqual(groups[1]!.assets.map(a => a.id), [video.id]);
  assert.equal(groups[2]!.assets.length, 0, 'An empty week remains selectable');
  assert.deepEqual(groups.at(-1)!.assets.map(a => a.id).sort(), ['old-week', 'orphan']);
  assert.deepEqual(groups.at(-1)!.recordings.map(r => r.id), [missing.id]);
  const moved = mediaWeekGroups(COURSE, weeks, { assets: [original], recordings: [{ ...first, weekId: weekId(2) }] }, []);
  assert.equal(moved[0]!.assets.length, 0);
  assert.equal(moved[1]!.assets[0]!.id, original.id, 'Reassignment changes the group, never the original ID');
});

test('media grouping does not use another course metadata or guess ambiguous video weeks', () => {
  const asset = { ...SAMPLE_MEDIA, courseId: COURSE };
  const groups = mediaWeekGroups(COURSE, [...weeks, { ...weeks[0]!, id: 'duplicate-label' }], {
    assets: [asset, { ...SAMPLE_VIDEO, courseId: COURSE }],
    recordings: [recording({ id: SAMPLE_MEDIA.source.type === 'recording' ? SAMPLE_MEDIA.source.recordingId : '', courseId: 'another-course', weekId: weekId(1) })],
  }, [{ sourceId: 'synthetic-video', week: '1주차' }]);
  assert.equal(groups.at(-1)!.assets.length, 2);
  assert.equal(groups.flatMap(g => g.recordings).length, 0);
});

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

test("WBS-105: the course opens on the current week, counted from the opening day", async () => {
  const { academicStart, calendarSemesterStart, currentWeekIndex } = await import("../src/recording-weeks.ts");
  const at = (iso: string) => new Date(iso);
  const many: Week[] = Array.from({ length: 15 }, (_, i) => ({ id: weekId(i + 1), courseId: COURSE, sourceWeekId: `w${i + 1}`, label: `${i + 1}주차`, order: i }));
  const label = (w: readonly Week[], s: CourseLearningStatus | undefined, iso: string) => w[currentWeekIndex(w, s, at(iso))]!.label;
  // 2026 fall opened Tue 9/1: Mon 11/9 is week 10, Tue 11/10 week 11 (owner's count).
  assert.equal(new Date(calendarSemesterStart(at("2026-11-09T03:00:00Z"))).toISOString(), "2026-08-31T15:00:00.000Z", "Tue 2026-09-01 00:00 Seoul");
  assert.equal(new Date(academicStart(weeks, status, at("2026-11-09T03:00:00Z"))).toISOString(), "2026-08-31T15:00:00.000Z", "the LMS agrees on the week");
  assert.equal(label(many, status, "2026-11-09T03:00:00Z"), "10주차");
  assert.equal(label(many, undefined, "2026-11-09T03:00:00Z"), "10주차", "no LMS openings: the calendar alone");
  assert.equal(label(many, status, "2026-11-09T15:00:00Z"), "11주차", "Tue 11/10 00:00 Seoul");
  // Week 8 has no module (exam week): the closest earlier week; before/after the semester: first/last.
  assert.equal(label(weeks, status, "2026-10-20T03:00:00Z"), "7주차");
  assert.equal(label(weeks, status, "2026-08-20T03:00:00Z"), "1주차");
  assert.equal(label(weeks, status, "2026-12-30T03:00:00Z"), "10주차");
  // LMS openings a week later than the calendar move the start by that week, keeping the weekday.
  const late = { ...status, items: status.items.map((i) => ({ ...i, unlockAt: i.unlockAt ? new Date(Date.parse(i.unlockAt) + 7 * 86_400_000).toISOString() : null })) };
  assert.equal(new Date(academicStart(weeks, late, at("2026-11-09T03:00:00Z"))).toISOString(), "2026-09-07T15:00:00.000Z");
  // Spring 2027 opens Tue 3/2; an opening on a weekend moves to Monday (2025-03-02 was a Sunday); January is still fall.
  assert.equal(new Date(calendarSemesterStart(at("2027-04-01T03:00:00Z"))).toISOString(), "2027-03-01T15:00:00.000Z");
  assert.equal(new Date(calendarSemesterStart(at("2025-04-01T03:00:00Z"))).toISOString(), "2025-03-02T15:00:00.000Z");
  assert.equal(new Date(calendarSemesterStart(at("2027-01-10T03:00:00Z"))).toISOString(), "2026-08-31T15:00:00.000Z");
  assert.equal(currentWeekIndex([{ ...weeks[0]!, label: "오리엔테이션" }], status, at("2026-11-09T03:00:00Z")), -1);
});
