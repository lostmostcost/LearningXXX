import assert from "node:assert/strict";
import { test } from "node:test";
import { MediaAsset } from "@learningxxx/contracts";
import { videoRows } from "../src/video-lectures.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const sha = "a".repeat(64);
const asset = MediaAsset.parse({
  schemaVersion: 1, id: "22222222-2222-4222-8222-000000000001", courseId: COURSE, role: "original",
  source: { type: "lms_video", resourceId: "33333333-3333-4333-8333-000000000001", sourceId: "v1" }, title: "1차시",
  mediaType: "video/mp4", bytes: 10, sha256: sha, storageKey: `video-originals/aa/${sha}.mp4`, createdAt: "2026-11-03T00:00:00Z",
});
const videos = [
  { sourceId: "v1", title: "1차시", week: "1주차" },
  { sourceId: "v2", title: "2차시", week: "1주차" },
  { sourceId: "v3", title: "3차시" },
  { sourceId: "v4", title: "4차시", week: "2주차" },
];
const job = (status: "running" | "succeeded", progress?: number) => ({
  schemaVersion: 1 as const, id: "44444444-4444-4444-8444-000000000001", sourceAssetId: asset.id, engine: { name: "e", version: "1" },
  parametersHash: sha, idempotencyKey: sha, status, attempt: 1, createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z",
  ...(progress === undefined ? {} : { progress }), ...(status === "running" ? { leaseExpiresAt: "2026-11-03T00:01:00Z" } : { outputTranscriptId: "55555555-5555-4555-8555-000000000001" }),
});

test("each lecture shows what this Mac has: downloaded, downloading, failed or not yet", () => {
  const rows = videoRows(videos, {
    assets: [asset], recordings: [], transcripts: [], jobs: [job("running", 0.42)],
    downloads: [
      { id: "66666666-6666-4666-8666-000000000001", courseId: COURSE, sourceId: "v2", title: "2차시", status: "running", receivedBytes: 25, totalBytes: 100 },
      { id: "66666666-6666-4666-8666-000000000002", courseId: COURSE, sourceId: "v3", title: "3차시", status: "failed", errorCode: "DOWNLOAD_FAILED" },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.sourceId, r.week, r.state, r.status]), [
    ["v1", "1주차", "downloaded", "받음 · 전사 중 42%"],
    ["v2", "1주차", "downloading", "받는 중 25%"],
    ["v3", "주차 없음", "failed", "받기 실패 · 다시 받을 수 있음"],
    ["v4", "2주차", "available", "아직 받지 않음"],
  ]);
});

test("no size known means no percentage, and a finished transcript says so", () => {
  const rows = videoRows(videos.slice(0, 2), {
    assets: [asset], recordings: [], transcripts: [], jobs: [job("succeeded")],
    downloads: [{ id: "66666666-6666-4666-8666-000000000003", courseId: COURSE, sourceId: "v2", title: "2차시", status: "queued" }],
  });
  assert.deepEqual(rows.map((r) => r.status), ["받음 · 전사 완료", "받는 중"]);
});
