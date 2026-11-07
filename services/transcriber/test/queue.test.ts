import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MediaAsset } from "@learningxxx/contracts";
import type { TranscriptionJob } from "@learningxxx/contracts";
import { EngineError, TranscriptionQueue, type Engine, type EngineInput, type EngineOutput } from "../src/index.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function asset(body = "audio"): MediaAsset {
  return MediaAsset.parse({
    schemaVersion: 1, id: randomUUID(), courseId: COURSE, role: "original",
    source: { type: "recording", recordingId: randomUUID() }, title: "녹음", mediaType: "audio/ogg",
    bytes: 10, sha256: sha(body), storageKey: `media/originals/${sha(body)}`, createdAt: "2026-11-02T00:00:00Z",
  });
}

const OUTPUT: EngineOutput = {
  language: "Korean",
  text: "래치를 봅니다. 다음은 플립플롭입니다.",
  words: [
    { text: "래치를", start: 0, end: 0.5 }, { text: "봅니다", start: 0.5, end: 1 },
    { text: "다음은", start: 1.2, end: 1.6 }, { text: "플립플롭입니다", start: 1.6, end: 2.4 },
  ],
};

/** An engine the test drives: each call waits until the test answers it. */
function fakeEngine() {
  const calls: { input: EngineInput; resolve: (o: EngineOutput) => void; reject: (e: unknown) => void }[] = [];
  const engine: Engine = {
    info: { name: "fake", version: "1" },
    parameters: { model: "m", language: "Korean" },
    transcribe: (input) =>
      new Promise((resolve, reject) => {
        calls.push({ input, resolve, reject });
        input.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  };
  return { engine, calls };
}

const tick = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

function setup(over: Partial<ConstructorParameters<typeof TranscriptionQueue>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "wbs025-"));
  const { engine, calls } = fakeEngine();
  const changes: TranscriptionJob[] = [];
  const make = (extra: typeof over = {}) =>
    new TranscriptionQueue({ root, engine, pathOf: (a) => `/media/${a.id}`, onChange: (j) => changes.push(j), retryDelaysMs: [0], ...over, ...extra });
  return { root, calls, changes, make, queue: make() };
}

test("an original is transcribed once: the same source, engine and parameters reuse the job", async () => {
  const { queue, calls, root } = setup({ contextFor: async () => "래치 플립플롭" });
  queue.start();
  const original = asset();
  const job = queue.enqueue(original);
  assert.equal(queue.enqueue({ ...original, id: randomUUID() }).id, job.id, "same content, collected again");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input.context, "래치 플립플롭");
  calls[0]!.input.onProgress(0.5);
  assert.equal(queue.job(job.id)!.progress, 0.5);
  calls[0]!.resolve(OUTPUT);
  await tick();
  const done = queue.job(job.id)!;
  assert.equal(done.status, "succeeded");
  const transcript = queue.transcript(done.outputTranscriptId!)!;
  assert.deepEqual(transcript.segments.map((s) => [s.startMs, s.text]), [[0, "래치를 봅니다."], [1200, "다음은 플립플롭입니다."]]);
  assert.equal(transcript.kind, "engine");
  assert.ok(existsSync(join(root, "transcripts", `${transcript.id}.json`)));
  assert.equal(queue.enqueue(original).id, job.id, "still the same job after it finished");
});

test("jobs run one at a time in order", async () => {
  const { queue, calls } = setup();
  queue.start();
  const a = queue.enqueue(asset("a"));
  const b = queue.enqueue(asset("b"));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(queue.job(b.id)!.status, "queued");
  calls[0]!.resolve(OUTPUT);
  await tick();
  assert.equal(queue.job(a.id)!.status, "succeeded");
  assert.equal(calls.length, 2);
});

test("a job left running by a crash is marked interrupted once its lease runs out, and runs again only on retry", async () => {
  let now = new Date("2026-11-02T00:00:00Z");
  const first = setup({ now: () => now, leaseMs: 60_000 });
  first.queue.start();
  const job = first.queue.enqueue(asset());
  await tick();
  assert.equal(first.queue.job(job.id)!.status, "running");
  // The process dies here: nothing is stopped, the file still says running.

  now = new Date("2026-11-02T00:00:30Z");
  const early = first.make({ now: () => now, leaseMs: 60_000 });
  early.start();
  await tick();
  assert.equal(early.job(job.id)!.status, "running", "lease not yet expired");
  await early.stop();

  now = new Date("2026-11-02T00:02:00Z");
  const later = first.make({ now: () => now, leaseMs: 60_000 });
  later.start();
  await tick();
  assert.equal(first.calls.length, 1, "not started again on its own");
  assert.equal(later.job(job.id)!.status, "failed");
  assert.equal(later.job(job.id)!.errorCode, "RUN_INTERRUPTED");
  later.retry(job.id);
  await tick();
  assert.equal(first.calls.length, 2, "the user's retry runs it");
  first.calls[1]!.resolve(OUTPUT);
  await tick();
  assert.equal(later.job(job.id)!.status, "succeeded");
  await later.stop();
});

test("cancel stops a queued or running job and keeps it retryable; the original is untouched", async () => {
  const { queue, calls } = setup();
  queue.start();
  const running = queue.enqueue(asset("a"));
  const waiting = queue.enqueue(asset("b"));
  await tick();
  assert.equal((await queue.cancel(waiting.id)).status, "cancelled");
  assert.equal((await queue.cancel(running.id)).status, "cancelled");
  assert.equal(calls[0]!.input.signal.aborted, true);
  assert.equal(queue.retry(running.id).status, "queued");
  await tick();
  assert.equal(calls.length, 2);
});

test("a retryable failure is tried again up to the limit, then fails with its reason", async () => {
  const { queue, calls } = setup({ maxAttempts: 2 });
  queue.start();
  const job = queue.enqueue(asset());
  await tick();
  calls[0]!.reject(new EngineError("TRANSCRIBE_FAILED", "x", true));
  await tick();
  await new Promise((r) => setTimeout(r, 5));
  await tick();
  assert.equal(calls.length, 2, "second attempt");
  calls[1]!.reject(new EngineError("TRANSCRIBE_FAILED", "x", true));
  await tick();
  const failed = queue.job(job.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "TRANSCRIBE_FAILED");
  assert.equal(failed.attempt, 2);
});

test("a failure no retry can fix stops at once", async () => {
  const { queue, calls } = setup();
  queue.start();
  const job = queue.enqueue(asset());
  await tick();
  calls[0]!.reject(new EngineError("ENGINE_UNAVAILABLE", "x", false));
  await tick();
  assert.equal(queue.job(job.id)!.status, "failed");
  assert.equal(queue.job(job.id)!.errorCode, "ENGINE_UNAVAILABLE");
  assert.equal(calls.length, 1);
});

test("a re-run after a crash rewrites the same transcript instead of adding another", async () => {
  const { queue, calls, root } = setup();
  queue.start();
  const job = queue.enqueue(asset());
  await tick();
  calls[0]!.resolve(OUTPUT);
  await tick();
  const id = queue.job(job.id)!.outputTranscriptId!;
  const stored = JSON.parse(readFileSync(join(root, "jobs.json"), "utf8")) as { entries: { transcriptId: string }[] };
  assert.equal(stored.entries[0]!.transcriptId, id, "the slot was fixed before the run");
});

test("quitting the app marks the running job interrupted; the next start leaves it until the user retries", async () => {
  const { queue, calls, make } = setup();
  queue.start();
  const job = queue.enqueue(asset());
  const waiting = queue.enqueue(asset("not started yet"));
  await tick();
  await queue.stop();
  assert.equal(calls[0]!.input.signal.aborted, true);
  const stopped = queue.job(job.id)!;
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.errorCode, "RUN_INTERRUPTED");
  assert.equal(stopped.leaseExpiresAt, undefined);
  const next = make();
  next.start();
  await tick();
  assert.equal(calls.length, 2, "only the job that never started runs");
  assert.equal(calls[1]!.input.audioPath.endsWith(waiting.sourceAssetId), true);
  assert.equal(next.job(job.id)!.status, "failed", "the interrupted one waits for the user");
  await next.stop();
});

test("pause stops the running job without cancelling it; resume starts it again, also after a restart", async () => {
  const { queue, calls, make } = setup();
  queue.start();
  const job = queue.enqueue(asset("paused"));
  await tick();
  await queue.pause();
  assert.equal(calls[0]!.input.signal.aborted, true);
  assert.equal(queue.job(job.id)!.status, "queued");
  assert.equal(queue.paused, true);
  await tick();
  assert.equal(calls.length, 1, "nothing starts while paused");
  await queue.stop();
  const next = make();
  next.start();
  await tick();
  assert.equal(next.paused, true, "still paused after a restart");
  assert.equal(calls.length, 1);
  next.resume();
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(next.job(job.id)!.status, "running");
  await next.stop();
});

test("WBS-101: the engine's reason stays with a failed job and is cleared when it runs again; the source hash reaches the engine", async () => {
  const { queue, calls } = setup({ maxAttempts: 2 });
  const a = asset("long lecture");
  const job = queue.enqueue(a);
  queue.start();
  await tick();
  assert.equal(calls[0]!.input.sourceSha256, a.sha256);
  calls[0]!.reject(new EngineError("TRANSCRIBE_FAILED", "메모리가 부족해 전사하지 못했습니다.", true, "RuntimeError: Insufficient Memory"));
  await tick();
  // Retryable: back in the queue, with the reason kept while it waits.
  await tick();
  assert.equal(calls.length, 2, "retried");
  assert.equal(queue.job(job.id)!.status, "running");
  assert.equal(queue.job(job.id)!.errorDetail, undefined, "a running job shows no old reason");
  calls[1]!.reject(new EngineError("TRANSCRIBE_FAILED", "메모리가 부족해 전사하지 못했습니다.", true, "RuntimeError: Insufficient Memory"));
  await tick();
  const failed = queue.job(job.id)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.errorCode, "TRANSCRIBE_FAILED");
  assert.equal(failed.errorDetail, "RuntimeError: Insufficient Memory");
  await queue.stop();
});
