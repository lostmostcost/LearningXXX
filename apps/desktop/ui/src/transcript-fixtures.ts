import { MediaAsset, Recording, Transcript, TranscriptionJob } from "@learningxxx/contracts";

/** Schema-valid metadata only. No recording/video/private content and no fabricated playback URL. */
const id = (n: number) => `26000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const MEDIA_COURSE_ID = id(1);
const at = "2026-11-02T00:00:00Z";
const engine = { name: "synthetic-engine", version: "fixture-only" };
export const SAMPLE_MEDIA = MediaAsset.parse({ schemaVersion: 1, id: id(2), courseId: MEDIA_COURSE_ID,
  role: "original", source: { type: "recording", recordingId: id(3) }, title: "합성 강의 녹음",
  mediaType: "audio/wav", bytes: 160044, sha256: "a".repeat(64), storageKey: "fixtures/not-a-real-recording.wav", durationMs: 10000, createdAt: at });
export const SAMPLE_RECOVERED_MEDIA = MediaAsset.parse({ ...SAMPLE_MEDIA, id: id(8), source: { type: "recording", recordingId: id(5) },
  title: "부분 복구 원본 예시", durationMs: 5000, bytes: 80044, storageKey: "fixtures/not-a-real-recovered-recording.wav" });
export const SAMPLE_VIDEO = MediaAsset.parse({ ...SAMPLE_MEDIA, id: id(9), source: { type: "lms_video", resourceId: id(20), sourceId: "synthetic-video" },
  title: "합성 온라인 강의 원본 메타데이터", mediaType: "video/mp4", storageKey: "fixtures/not-a-real-video.mp4" });
export const SAMPLE_RECORDINGS = [
  Recording.parse({ schemaVersion: 1, id: id(3), courseId: MEDIA_COURSE_ID, title: "합성 강의 녹음", startedAt: at, status: "finalized", durationMs: 10000, originalAssetId: SAMPLE_MEDIA.id }),
  Recording.parse({ schemaVersion: 1, id: id(4), courseId: MEDIA_COURSE_ID, title: "녹음 진행 상태 예시", startedAt: at, status: "recording" }),
  Recording.parse({ schemaVersion: 1, id: id(5), courseId: MEDIA_COURSE_ID, title: "부분 복구 상태 예시", startedAt: at, status: "recovered_partial", durationMs: 5000, originalAssetId: SAMPLE_RECOVERED_MEDIA.id }),
];
export const SAMPLE_TRANSCRIPT = Transcript.parse({ schemaVersion: 1, id: id(6), sourceAssetId: SAMPLE_MEDIA.id, kind: "engine", engine,
  parametersHash: "b".repeat(64), language: "ko", createdAt: at, segments: [
    { startMs: 0, endMs: 2500, text: "논리 회로의 입력과 출력을 살펴봅니다." },
    { startMs: 3000, endMs: 5500, text: "선택하지 않은 문장은 자동으로 첨부하지 않습니다." },
    { startMs: 6000, endMs: 10000, text: "진리표를 이용해 결과를 확인합니다." },
  ] });
export const SAMPLE_CORRECTED = Transcript.parse({ ...SAMPLE_TRANSCRIPT, id: id(7), kind: "corrected", basedOnTranscriptId: SAMPLE_TRANSCRIPT.id,
  createdAt: "2026-11-02T00:01:00Z", segments: SAMPLE_TRANSCRIPT.segments.map((s) => ({ ...s })) });
// Alternative snapshots of one job, not five jobs to enqueue or display as a real queue.
export const SAMPLE_JOBS = ["queued", "running", "succeeded", "failed", "cancelled"].map((status, index) => TranscriptionJob.parse({
  schemaVersion: 1, id: id(10 + index), sourceAssetId: SAMPLE_MEDIA.id, engine, parametersHash: "b".repeat(64), idempotencyKey: "c".repeat(64),
  status, attempt: status === "queued" ? 0 : 1, createdAt: at, updatedAt: at,
  ...(status === "running" ? { leaseExpiresAt: "2026-11-02T00:05:00Z" } : {}),
  ...(status === "succeeded" ? { outputTranscriptId: SAMPLE_TRANSCRIPT.id } : {}),
  ...(status === "failed" ? { errorCode: "INTERNAL" } : {}),
}));
