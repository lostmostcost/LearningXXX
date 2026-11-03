import assert from "node:assert/strict";
import { test } from "node:test";
import { queueStatus } from "../src/job-queue.ts";

test("WBS-073: queue lines say running with progress, paused, or how many are ahead", () => {
  const base = { kind: "transcription" as const, id: "1", title: "녹음" };
  assert.equal(queueStatus({ ...base, status: "running", progress: 0.494 }, false), "진행 중 49%");
  assert.equal(queueStatus({ ...base, status: "queued", ahead: 2 }, false), "대기 · 앞에 2개");
  assert.equal(queueStatus({ ...base, status: "queued", ahead: 2 }, true), "일시 정지됨");
  assert.equal(queueStatus({ ...base, kind: "download", status: "queued" }, true), "대기");
});
