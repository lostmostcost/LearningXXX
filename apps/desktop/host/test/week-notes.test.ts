import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CollectionManifest } from "@learningxxx/contracts";
import { htmlToText, weekNotes } from "../src/week-notes.ts";

const course = randomUUID(), w4 = randomUUID(), w5 = randomUUID(), report = randomUUID();
const manifest = CollectionManifest.parse({ schemaVersion: 1, course: { id: course, title: "합성", accountKey: "acct_synthetic01", termId: "t", sourceCourseId: "1" },
  weeks: [{ id: w4, courseId: course, sourceWeekId: "a", label: "4주차", order: 0 }, { id: w5, courseId: course, sourceWeekId: "b", label: "5주차", order: 1 }],
  revision: 1, syncRunId: randomUUID(), generatedAt: "2026-11-03T00:00:00Z", tombstones: [],
  items: [{ resource: { id: report, courseId: course, weekId: w5, kind: "assignment", source: "lms", sourceId: "7", title: "보고서", revision: 1, updatedAt: "2026-11-03T00:00:00Z" }, assets: [], assignment: { resourceId: report, dueAt: "2026-11-10T14:59:00Z", timezone: "Asia/Seoul", timezoneBasis: "source_explicit" }, body: "<p>원가 <b>표</b> 작성</p><script>x()</script>" }] });
const sha = "a".repeat(64);
const rec = randomUUID(), recAsset = randomUUID(), vidAsset = randomUUID();
const asset = (id: string, source: object, title: string) => ({ schemaVersion: 1 as const, id, courseId: course, role: "original" as const, source, title, mediaType: "audio/mp4", bytes: 1, sha256: sha, storageKey: `media/originals/${sha}.m4a`, createdAt: "2026-11-03T00:00:00Z" });
const transcript = (sourceAssetId: string, createdAt: string, text: string, kind: "engine" | "corrected" = "engine") => ({ schemaVersion: 1 as const, id: randomUUID(), sourceAssetId, kind, engine: { name: "e", version: "1" }, parametersHash: sha, language: "ko", createdAt, segments: [{ startMs: 61_000, endMs: 62_000, text }], ...(kind === "corrected" ? { basedOnTranscriptId: randomUUID() } : {}) });

test("WBS-078: transcripts go to their week (recording by filing, lecture video by LMS week); the newest version is used; assignments carry their text", async () => {
  const notes = await weekNotes({
    manifest, formatTime: (u) => u.slice(0, 10),
    media: {
      assets: [asset(recAsset, { type: "recording", recordingId: rec }, "4주차 녹음") as never, asset(vidAsset, { type: "lms_video", resourceId: randomUUID(), sourceId: "abc" }, "5주차 영상") as never],
      recordings: [{ schemaVersion: 1, id: rec, courseId: course, weekId: w4, title: "4주차 녹음", startedAt: "2026-11-03T00:00:00Z", status: "finalized", durationMs: 1, originalAssetId: recAsset }],
      transcripts: [transcript(recAsset, "2026-11-03T00:00:00Z", "옛 문장") as never, transcript(recAsset, "2026-11-04T00:00:00Z", "고친 문장", "corrected") as never, transcript(vidAsset, "2026-11-03T00:00:00Z", "영상 문장") as never],
      importedDocs: { [recAsset]: ["readable_app"] },
    },
    doc: async () => "## 정리",
    learning: { schemaVersion: 1, courseId: course, fetchedAt: "2026-11-03T00:00:00Z", errors: [], items: [{ kind: "video", title: "영상", weekLabel: "5주차", sourceRef: "commons:abc", completed: null, attendance: null, usesAttendance: true, period: "open", unlockAt: null, dueAt: null, lockAt: null }] },
    mentions: [{ id: randomUUID(), courseId: course, assetId: recAsset, kind: "exam", title: "중간고사", detail: "3장까지", transcriptId: randomUUID(), startMs: 61_000, quote: "중간고사는", confirmedAt: "2026-11-04T00:00:00Z" }],
  });
  const find = (kind: string, title: string) => notes.find((n) => n.kind === kind && n.title.startsWith(title))!;
  assert.equal(find("transcript", "4주차 녹음").weekId, w4);
  assert.match(find("transcript", "4주차 녹음").text, /\[01:01\] 고친 문장/);
  assert.doesNotMatch(find("transcript", "4주차 녹음").text, /옛 문장/, "only the newest version");
  assert.equal(find("transcript", "5주차 영상").weekId, w5, "lecture video placed by its LMS week");
  assert.equal(find("note", "4주차 녹음").text, "## 정리");
  const a = find("assignment", "보고서");
  assert.equal(a.weekId, w5);
  assert.match(a.text, /마감: 2026-11-10/);
  assert.match(a.text, /원가 표 작성/);
  assert.doesNotMatch(a.text, /x\(\)|<p>/);
  assert.match(find("mentions", "강의에서").text, /중간고사: 3장까지 — 근거 01:01/);
  assert.equal(find("mentions", "강의에서").weekId, w4);
});

test("htmlToText keeps paragraphs and drops scripts", () => {
  assert.equal(htmlToText("<p>a&amp;b</p><ul><li>c</li></ul><style>p{}</style>"), "a&b\n- c");
});
