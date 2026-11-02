import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MediaAsset } from "@learningxxx/contracts";
import { TranscriptionQueue, type Engine, type EngineOutput } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), "wbs046-")); roots.push(path); return path; };
const output: EngineOutput = { language: "Korean", text: "합성 결과입니다.", words: [] };
const asset = () => MediaAsset.parse({ schemaVersion: 1, id: randomUUID(), courseId: randomUUID(), role: "original", source: { type: "recording", recordingId: randomUUID() }, title: "합성 원본", mediaType: "audio/wav", bytes: 1, sha256: createHash("sha256").update(randomUUID()).digest("hex"), storageKey: "synthetic.wav", createdAt: "2026-11-02T00:00:00Z" });
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve)); };
function fake(version = "1", parameters = { model: "synthetic-1" }) {
  let resolve!: (value: EngineOutput) => void;
  let onProgress!: (value: number) => void;
  let calls = 0;
  // Intentionally ignores abort: the queue must defend its own commit boundary.
  const engine: Engine = { info: { name: "fake", version }, parameters, transcribe: (input) => {
    calls++; onProgress = input.onProgress;
    return new Promise((done) => { resolve = done; });
  } };
  return { engine, calls: () => calls, resolve: () => resolve(output), progress: (n: number) => onProgress(n) };
}

test("restored pending jobs never run with a different engine/version/parameters; old and new results stay distinct", async () => {
  for (const change of ["version", "name", "parameters"] as const) {
    const path = root(), old = fake(), current = fake(change === "version" ? "2" : "1", { model: change === "parameters" ? "synthetic-2" : "synthetic-1" });
    if (change === "name") current.engine.info.name = "other";
    const original = asset();
    const oldQueue = new TranscriptionQueue({ root: path, engine: old.engine, pathOf: () => "unused" });
    const pending = oldQueue.enqueue(original);
    const queue = new TranscriptionQueue({ root: path, engine: current.engine, pathOf: () => "unused" });
    queue.start(); await tick();
    assert.equal(current.calls(), 0, change);
    assert.equal(queue.job(pending.id)!.status, "failed");
    assert.equal(queue.job(pending.id)!.errorCode, "ENGINE_UNAVAILABLE");
    const next = queue.enqueue(original); assert.notEqual(next.id, pending.id);
    await tick(); current.resolve(); await tick();
    const transcript = queue.transcript(queue.job(next.id)!.outputTranscriptId!)!;
    assert.deepEqual(transcript.engine, current.engine.info);
    assert.equal(transcript.parametersHash, queue.parametersHash);
    assert.equal(queue.job(pending.id)!.outputTranscriptId, undefined);
    await queue.stop();
  }
});

test("late success after user cancellation creates no transcript and stale progress cannot change terminal state", async () => {
  const path = root(), engine = fake();
  const queue = new TranscriptionQueue({ root: path, engine: engine.engine, pathOf: () => "unused" });
  queue.start(); const job = queue.enqueue(asset()); await tick();
  const cancelling = queue.cancel(job.id);
  engine.resolve(); await cancelling; await tick();
  assert.equal(queue.job(job.id)!.status, "cancelled");
  assert.equal(queue.job(job.id)!.outputTranscriptId, undefined);
  engine.progress(0.9);
  assert.equal(queue.job(job.id)!.progress, undefined);
  assert.equal(existsSync(join(path, "transcripts")) && readdirSync(join(path, "transcripts")).length > 0, false);
  await queue.stop();
});

test("late success after shutdown stays recoverable instead of committing a transcript", async () => {
  const path = root(), engine = fake();
  const queue = new TranscriptionQueue({ root: path, engine: engine.engine, pathOf: () => "unused" });
  queue.start(); const job = queue.enqueue(asset()); await tick();
  const stopping = queue.stop(); engine.resolve(); await stopping;
  assert.equal(queue.job(job.id)!.status, "running");
  assert.equal(queue.job(job.id)!.outputTranscriptId, undefined);
  engine.progress(0.9); assert.equal(queue.job(job.id)!.progress, undefined);
});

test("an onChange observer that throws cannot abort enqueue or turn successful output into failure", async () => {
  const engine = fake();
  const queue = new TranscriptionQueue({ root: root(), engine: engine.engine, pathOf: () => "unused", onChange: () => { throw new Error("UI disconnected"); } });
  queue.start(); let id = "";
  assert.doesNotThrow(() => { id = queue.enqueue(asset()).id; });
  await tick(); engine.progress(0.4); engine.resolve(); await tick();
  assert.equal(queue.job(id)!.status, "succeeded");
  assert.ok(queue.transcript(queue.job(id)!.outputTranscriptId!));
  await queue.stop();
});

test("an asynchronous observer rejection is isolated from the queue and process", async () => {
  const engine = fake(), queue = new TranscriptionQueue({ root: root(), engine: engine.engine, pathOf: () => "unused", onChange: async () => { throw new Error("async UI disconnected"); } });
  queue.start(); const job = queue.enqueue(asset()); await tick();
  engine.resolve(); await tick(); assert.equal(queue.job(job.id)!.status, "succeeded");
  await queue.stop();
});

test("cancel immediately after enqueue does not start the reserved worker", async () => {
  const engine = fake(), queue = new TranscriptionQueue({ root: root(), engine: engine.engine, pathOf: () => "unused" });
  queue.start(); const job = queue.enqueue(asset());
  await queue.cancel(job.id); await tick();
  assert.equal(engine.calls(), 0); assert.equal(queue.job(job.id)!.status, "cancelled");
  await queue.stop();
});

test("observer reentry still reserves one worker and mutation touches only its notification copy", async () => {
  const engine = fake(); let extra: string | undefined;
  const queue = new TranscriptionQueue({ root: root(), engine: engine.engine, pathOf: () => "unused", onChange: (job) => {
    if (job.status === "running" && extra === undefined) {
      extra = "reserving";
      extra = queue.enqueue(asset()).id;
    }
    job.status = "cancelled";
  } });
  queue.start(); const first = queue.enqueue(asset()); await tick();
  assert.equal(engine.calls(), 1); assert.equal(queue.job(first.id)!.status, "running");
  assert.equal(queue.job(extra!)!.status, "queued");
  engine.progress(Number.NaN); engine.progress(2); assert.equal(queue.job(first.id)!.progress, undefined);
  engine.resolve(); await tick();
  assert.equal(engine.calls(), 2); assert.equal(queue.job(first.id)!.status, "succeeded");
  engine.resolve(); await tick(); await queue.stop();
});

test("a new engine run preserves the bytes of the completed previous transcript", async () => {
  const path = root(), original = asset(), old = fake();
  const first = new TranscriptionQueue({ root: path, engine: old.engine, pathOf: () => "unused" });
  first.start(); const previous = first.enqueue(original); await tick(); old.resolve(); await tick(); await first.stop();
  const previousId = first.job(previous.id)!.outputTranscriptId!;
  const file = join(path, "transcripts", `${previousId}.json`), saved = readFileSync(file);
  const current = fake("2"), second = new TranscriptionQueue({ root: path, engine: current.engine, pathOf: () => "unused" });
  second.start(); const next = second.enqueue(original); await tick(); current.resolve(); await tick();
  assert.notEqual(second.job(next.id)!.outputTranscriptId, previousId);
  assert.deepEqual(readFileSync(file), saved);
  assert.equal(second.job(previous.id)!.status, "succeeded");
  await second.stop();
});

test("cancellation during context lookup never starts the engine; changes during a run never get an old label", async () => {
  const engine = fake(); let finish!: (value: string) => void;
  const queue = new TranscriptionQueue({ root: root(), engine: engine.engine, pathOf: () => "unused", contextFor: () => new Promise((resolve) => { finish = resolve; }) });
  queue.start(); const job = queue.enqueue(asset()); await tick();
  const cancelling = queue.cancel(job.id); finish("synthetic terms"); await cancelling;
  assert.equal(engine.calls(), 0); assert.equal(queue.job(job.id)!.status, "cancelled"); await queue.stop();

  const path = root(), changed = new TranscriptionQueue({ root: path, engine: engine.engine, pathOf: () => "unused" });
  changed.start(); const pending = changed.enqueue(asset()); await tick();
  engine.engine.parameters.model = "changed"; engine.resolve(); await tick();
  assert.equal(changed.job(pending.id)!.status, "failed");
  assert.equal(changed.job(pending.id)!.errorCode, "ENGINE_UNAVAILABLE");
  assert.equal(changed.job(pending.id)!.outputTranscriptId, undefined);
  assert.equal(existsSync(join(path, "transcripts")), false);
  await changed.stop();
});
