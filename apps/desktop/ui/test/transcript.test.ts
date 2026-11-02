import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaAsset, Recording, Transcript, TranscriptionJob } from "@learningxxx/contracts";
import { downloadView, excerptFor, jobView, mediaTime, playbackRange, versionsFor } from "../src/transcript-model.ts";
import { MEDIA_COURSE_ID, SAMPLE_MEDIA, SAMPLE_RECOVERED_MEDIA, SAMPLE_VIDEO, SAMPLE_RECORDINGS, SAMPLE_JOBS, SAMPLE_TRANSCRIPT, SAMPLE_CORRECTED } from "../src/transcript-fixtures.ts";

test("fixture metadata conforms to the merged media contracts", () => {
  const assets = [SAMPLE_MEDIA, SAMPLE_RECOVERED_MEDIA, SAMPLE_VIDEO];
  for (const a of assets) MediaAsset.parse(a);
  for (const r of SAMPLE_RECORDINGS) {
    Recording.parse(r);
    if (!r.originalAssetId) continue;
    const original = assets.find((a) => a.id === r.originalAssetId)!;
    assert.equal(original.source.type, "recording");
    if (original.source.type === "recording") assert.equal(original.source.recordingId, r.id);
    assert.equal(original.courseId, r.courseId);
    assert.equal(original.durationMs, r.durationMs);
  }
  for (const j of SAMPLE_JOBS) TranscriptionJob.parse(j);
  for (const v of [SAMPLE_TRANSCRIPT, SAMPLE_CORRECTED]) Transcript.parse(v);
});

test("unknown progress never becomes a fabricated percentage", () => {
  const running = SAMPLE_JOBS.find((j) => j.status === "running")!;
  assert.deepEqual(jobView(running), { label: "전사 중 · 진행량 알 수 없음", retry: false });
  assert.equal(jobView({ ...running, progress: 0 }).progress, 0);
  assert.equal(jobView({ ...running, progress: 0.4 }).progress, 0.4);
  for (const progress of [NaN, Infinity, -1, 1.1]) assert.equal(jobView({ ...running, progress }).progress, undefined);
});

test("download percentages require finite, consistent byte counts and never imply a finished original", () => {
  const job = { id: "sample", courseId: MEDIA_COURSE_ID, title: "video", status: "running" as const };
  assert.equal(downloadView(job).progress, undefined);
  assert.equal(downloadView({ ...job, receivedBytes: 25, totalBytes: 100 }).progress, 0.25);
  for (const [receivedBytes, totalBytes] of [[0, 0], [101, 100], [-1, 100], [1, NaN], [Infinity, Infinity]] as const) {
    assert.equal(downloadView({ ...job, receivedBytes, totalBytes }).progress, undefined);
  }
  assert.equal(downloadView({ ...job, status: "failed", receivedBytes: 100, totalBytes: 100 }).progress, undefined);
  assert.match(downloadView({ ...job, status: "failed" }).label, /완성 전/);
});

test("terminal states discard stale progress and expose retry only after failure/cancel", () => {
  for (const job of SAMPLE_JOBS.filter((j) => j.status !== "running")) {
    const view = jobView({ ...job, progress: 1 });
    assert.equal(view.progress, undefined);
    assert.equal(view.retry, job.status === "failed" || job.status === "cancelled");
  }
});

test("versions stay attached to their own original; corrected version does not erase engine output", () => {
  const unrelated = { ...SAMPLE_TRANSCRIPT, id: "other-version", sourceAssetId: "other-source" };
  assert.deepEqual(versionsFor(SAMPLE_MEDIA, [SAMPLE_TRANSCRIPT, unrelated, SAMPLE_CORRECTED]).map((t) => t.id), [SAMPLE_CORRECTED.id, SAMPLE_TRANSCRIPT.id]);
});

test("version order compares UTC instants even when milliseconds are optional", () => {
  const fractional = { ...SAMPLE_TRANSCRIPT, id: "26000000-0000-4000-8000-000000000099", createdAt: "2026-11-02T00:00:00.100Z" };
  const input = [SAMPLE_TRANSCRIPT, fractional];
  assert.deepEqual(versionsFor(SAMPLE_MEDIA, input).map((t) => t.id), [fractional.id, SAMPLE_TRANSCRIPT.id]);
  assert.equal(input[0], SAMPLE_TRANSCRIPT);
});

test("timestamp seeks use seconds and stop at actual duration", () => {
  assert.deepEqual(playbackRange({ startMs: 1500, endMs: 5000, text: "x" }, 3000), { startSeconds: 1.5, endSeconds: 3 });
  for (const duration of [0, -1, NaN, 1000]) assert.equal(playbackRange({ startMs: 1500, endMs: 5000, text: "x" }, duration), undefined);
  assert.equal(playbackRange({ startMs: 1, endMs: 1, text: "point" }), undefined);
  assert.equal(playbackRange({ startMs: -1, endMs: 1, text: "invalid" }), undefined);
  assert.equal(mediaTime(3661000), "1:01:01");
  assert.equal(mediaTime(10000), "0:10");
  assert.equal(mediaTime(NaN), "—");
});

test("only explicit rows are copied, deduplicated and kept in timeline order", () => {
  const result = excerptFor(SAMPLE_MEDIA, SAMPLE_TRANSCRIPT, [2, 0, 2], MEDIA_COURSE_ID);
  assert.ok(result.ok);
  assert.deepEqual(result.excerpt.segments.map((s) => s.startMs), [0, 6000]);
  assert.ok(!result.excerpt.text.includes("선택하지 않은"));
  assert.equal(result.excerpt.sourceAssetId, SAMPLE_MEDIA.id);
  assert.equal(result.excerpt.transcriptId, SAMPLE_TRANSCRIPT.id);
  result.excerpt.segments[0]!.text = "new draft";
  assert.notEqual(SAMPLE_TRANSCRIPT.segments[0]!.text, "new draft");
});

test("course/source changes and invalid or empty selections cannot reuse a previous excerpt", () => {
  assert.deepEqual(excerptFor(SAMPLE_MEDIA, SAMPLE_TRANSCRIPT, [0], "other-course"), { ok: false, reason: "wrong_course" });
  assert.deepEqual(excerptFor(SAMPLE_MEDIA, { ...SAMPLE_TRANSCRIPT, sourceAssetId: "other" }, [0], MEDIA_COURSE_ID), { ok: false, reason: "wrong_source" });
  assert.deepEqual(excerptFor(SAMPLE_MEDIA, SAMPLE_TRANSCRIPT, [], MEDIA_COURSE_ID), { ok: false, reason: "no_selection" });
  for (const indices of [[-1], [0.5], [99]]) assert.deepEqual(excerptFor(SAMPLE_MEDIA, SAMPLE_TRANSCRIPT, indices, MEDIA_COURSE_ID), { ok: false, reason: "invalid_selection" });
  const blank = { ...SAMPLE_TRANSCRIPT, segments: [{ startMs: 0, endMs: 1, text: "  " }] };
  assert.deepEqual(excerptFor(SAMPLE_MEDIA, blank, [0], MEDIA_COURSE_ID), { ok: false, reason: "empty" });
  const oversized = { ...blank, segments: [{ startMs: 0, endMs: 1, text: "x".repeat(20000) }] };
  assert.deepEqual(excerptFor(SAMPLE_MEDIA, oversized, [0], MEDIA_COURSE_ID), { ok: false, reason: "too_large" });
});
