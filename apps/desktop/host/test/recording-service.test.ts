import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MediaAsset } from "@learningxxx/contracts";
import { MIN_FREE_TO_CONTINUE, MIN_FREE_TO_START, RecordingService, encodeAac, wavHeader } from "../src/recording-service.ts";

const COURSE = "11111111-1111-4111-8111-000000000001";
const pcm = (ms: number, value = 1000) => {
  const b = Buffer.alloc(ms * 32);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(value, i);
  return new Uint8Array(b);
};

async function code(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    return (error as { appError: { code: string } }).appError.code;
  }
  return assert.fail("expected a failure");
}

function setup(over: Partial<ConstructorParameters<typeof RecordingService>[0]> = {}) {
  const dataRoot = mkdtempSync(join(tmpdir(), "wbs023-"));
  const confirmed: MediaAsset[] = [];
  const state = { free: 10 * 1024 ** 3, permission: "granted" as "granted" | "denied" };
  const make = (extra: typeof over = {}) =>
    new RecordingService({
      dataRoot,
      micPermission: async () => state.permission,
      freeBytes: () => state.free,
      // The real encoder is macOS-only; the container keeps the WAV.
      encode: async (wav, out) => copyFileSync(wav, out),
      onOriginalConfirmed: (a) => confirmed.push(a),
      ...over,
      ...extra,
    });
  return { dataRoot, confirmed, state, make, service: make() };
}

test("chunks are flushed in order and stopping confirms one original, handed on once", async () => {
  const { service, confirmed, dataRoot } = setup();
  const r = await service.start({ courseId: COURSE });
  assert.equal(r.status, "recording");
  assert.deepEqual(await service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(1000) }), { savedMs: 1000 });
  assert.deepEqual(await service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(1000) }), { savedMs: 1000 }, "a resent chunk is not written twice");
  assert.deepEqual(await service.chunk({ recordingId: r.id, seq: 1, pcm: pcm(500) }), { savedMs: 1500 });
  assert.equal(await code(service.chunk({ recordingId: r.id, seq: 5, pcm: pcm(10) })), "INVALID_REQUEST");
  const { recording, asset } = await service.stop({ recordingId: r.id });
  assert.equal(recording.status, "finalized");
  assert.equal(recording.durationMs, 1500);
  assert.equal(recording.originalAssetId, asset!.id);
  const bytes = readFileSync(join(dataRoot, asset!.storageKey));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), asset!.sha256);
  assert.equal(bytes.byteLength, 44 + 1500 * 32, "WAV header + every saved sample");
  assert.deepEqual(confirmed.map((a) => a.id), [asset!.id]);
  assert.deepEqual(await service.stop({ recordingId: r.id }), { recording, asset }, "stopping again changes nothing");
  assert.equal(confirmed.length, 1);
  assert.deepEqual(service.asset({ assetId: asset!.id }).bytes.byteLength, bytes.byteLength);
});

test("a recording cut off by a crash is recovered as a partial original on the next start", async () => {
  const first = setup();
  const r = await first.service.start({ courseId: COURSE });
  await first.service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(2000) });
  // The app dies here: no stop.
  const next = first.make();
  const [recovered] = await next.recover();
  assert.equal(recovered!.status, "recovered_partial");
  assert.equal(recovered!.durationMs, 2000);
  assert.equal(first.confirmed.length, 1);
  assert.equal(next.list({ courseId: COURSE }).assets.length, 1);
});

test("a recording with nothing saved fails instead of making an empty original", async () => {
  const first = setup();
  const r = await first.service.start({ courseId: COURSE });
  const next = first.make();
  const [failed] = await next.recover();
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.errorCode, "RECORDING_INTERRUPTED");
  assert.equal(first.confirmed.length, 0);
  assert.equal(next.list({ courseId: COURSE }).recordings[0]!.id, r.id);
});

test("no microphone permission or no space: nothing starts", async () => {
  const { service, state } = setup();
  state.permission = "denied";
  assert.equal(await code(service.start({ courseId: COURSE })), "MIC_PERMISSION_DENIED");
  state.permission = "granted";
  state.free = MIN_FREE_TO_START - 1;
  assert.equal(await code(service.start({ courseId: COURSE })), "DISK_FULL");
  assert.equal(service.list({ courseId: COURSE }).recordings.length, 0);
});

test("running out of space stops the recording and keeps what was saved", async () => {
  const stopped: string[] = [];
  const { service, state, confirmed } = setup({ onStopped: (r) => stopped.push(r.status) });
  const r = await service.start({ courseId: COURSE });
  await service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(1000) });
  state.free = MIN_FREE_TO_CONTINUE - 1;
  assert.equal(await code(service.chunk({ recordingId: r.id, seq: 1, pcm: pcm(1000) })), "DISK_FULL");
  assert.deepEqual(stopped, ["finalized"]);
  assert.equal(confirmed[0]!.durationMs, 1000);
  assert.equal(service.activeId, undefined);
});

test("only one recording at a time", async () => {
  const { service } = setup();
  await service.start({ courseId: COURSE });
  assert.equal(await code(service.start({ courseId: COURSE })), "RUN_ALREADY_ACTIVE");
});

test("stopping before sleep confirms the original and tells the renderer", async () => {
  const stopped: string[] = [];
  const { service } = setup({ onStopped: (r) => stopped.push(r.status) });
  const r = await service.start({ courseId: COURSE });
  await service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(300) });
  await service.stopActive("RECORDING_INTERRUPTED");
  assert.deepEqual(stopped, ["finalized"]);
  await service.stopActive();
  assert.equal(stopped.length, 1, "nothing left to stop");
});

test("if compression fails the WAV is kept as the original", async () => {
  const { service } = setup({ encode: async () => { throw new Error("no encoder"); } });
  const r = await service.start({ courseId: COURSE });
  await service.chunk({ recordingId: r.id, seq: 0, pcm: pcm(100) });
  const { asset } = await service.stop({ recordingId: r.id });
  assert.equal(asset!.mediaType, "audio/wav");
});

test("the compressed original is readable by the transcription decoder (macOS)", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "wbs023-aac-"));
  const wav = join(dir, "a.wav");
  writeFileSync(wav, Buffer.concat([wavHeader(16000 * 32), Buffer.from(pcm(16000))]));
  await encodeAac(wav, join(dir, "a.m4a"));
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(dir, "a.m4a"), join(dir, "back.wav")]);
  assert.ok(existsSync(join(dir, "back.wav")));
});
