import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Course, MediaAsset } from "@learningxxx/contracts";
import type { Engine, EngineOutput } from "@learningxxx/transcriber";
import { MediaService, type MediaServiceOptions } from "../src/media-service.ts";
import { RecordingService } from "../src/recording-service.ts";
import { createHandlers } from "../src/handlers.ts";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }); });
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2)); };
const output: EngineOutput = { language: "Korean", text: "합성 전사입니다.", words: [] };
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "wbs027-")); roots.push(root);
  let account = "acct_synthetic01", calls = 0, release: ((o: EngineOutput) => void) | undefined;
  const course = Course.parse({ id: randomUUID(), accountKey: account, termId: "test", sourceCourseId: "123", title: "합성 과목" });
  const bytes = Buffer.from("synthetic original"), hash = createHash("sha256").update(bytes).digest("hex");
  const asset = MediaAsset.parse({ schemaVersion: 1, id: randomUUID(), courseId: course.id, role: "original", source: { type: "recording", recordingId: randomUUID() }, title: "합성 녹음", mediaType: "audio/wav", bytes: bytes.length, sha256: hash, storageKey: `media/originals/${hash}.wav`, createdAt: "2026-11-03T00:00:00Z" });
  await mkdir(join(root, "media/originals"), { recursive: true }); await writeFile(join(root, asset.storageKey), bytes);
  const engine: Engine = { info: { name: "synthetic", version: "1" }, parameters: {}, transcribe: async (input) => { calls++; return new Promise((resolve, reject) => { release = resolve; input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); } };
  const opened: string[] = [];
  const make = (originals = [asset], extra: Partial<MediaServiceOptions> = {}) => new MediaService({ dataRoot: root, accountKey: () => account, courses: async () => account === course.accountKey ? [course] : [], originals: () => originals, recordings: () => [], engine,
    videos: async () => [{ sourceId: "synthetic", title: "합성 영상" }], openOriginal: async (path) => { opened.push(path); },
    video: () => ({ fetch: (async () => new Response("denied", { status: 403 })) as typeof fetch, resolveSource: async () => ({ url: "https://test.invalid/video", referer: "https://test.invalid/view" }), allowedOrigins: ["https://test.invalid"] }), ...extra,
  });
  return { root, asset, course, bytes, make, calls: () => calls, finish: () => release!(output), opened, switchAccount: () => { account = "acct_synthetic02"; } };
}

test("confirmed original automatically enqueues once; startup recovers a missing job and existing output", async () => {
  const s = await setup(), media = s.make();
  await media.recover(); await tick(); assert.equal(s.calls(), 1);
  await media.recover(); await media.register(s.asset); assert.equal(s.calls(), 1);
  s.finish(); await tick(); const listing = await media.list(s.course.id);
  assert.equal(listing.jobs.length, 1); assert.equal(listing.jobs[0]!.status, "succeeded"); assert.equal(listing.transcripts.length, 1);
  await media.stop();
  const restarted = s.make(); await restarted.recover(); await tick(); assert.equal(s.calls(), 1);
  assert.equal((await restarted.list(s.course.id)).transcripts.length, 1);
  assert.deepEqual(await readFile(join(s.root, s.asset.storageKey)), s.bytes);
  await restarted.open(s.course.id, s.asset.id); assert.equal(s.opened.length, 1); await restarted.stop();
});

test("durable catalog without a queue job is automatically reconciled after a restart", async () => {
  const s = await setup(), path = join(s.root, "media/accounts", s.course.accountKey);
  await mkdir(path, { recursive: true }); await writeFile(join(path, "catalog.json"), JSON.stringify({ assets: [s.asset], downloads: [] }));
  const media = s.make([]); await media.recover(); await tick(); assert.equal(s.calls(), 1); s.finish(); await tick(); await media.stop();
});

test("wrong course/account cannot list, play or retry media; switching accounts stops the old worker", async () => {
  const s = await setup(), media = s.make(); await media.recover(); await tick();
  await assert.rejects(media.list(randomUUID()), /현재 계정/);
  await assert.rejects(media.asset(s.course.id, randomUUID()), /현재 과목/);
  s.switchAccount(); await assert.rejects(media.list(s.course.id), /현재 계정/);
  assert.equal(s.calls(), 1); await media.stop();
});

test("changed original is rejected and never fed to the engine or player", async () => {
  const s = await setup(), media = s.make(); await writeFile(join(s.root, s.asset.storageKey), "tampered");
  await assert.rejects(media.register(s.asset), /크기|내용/); assert.equal(s.calls(), 0); assert.equal(s.opened.length, 0); await media.stop();
});

test("unknown video source cannot trigger a download; interrupted intent is visible after restart", async () => {
  const s = await setup(), path = join(s.root, "media/accounts", s.course.accountKey);
  const id = randomUUID(); await mkdir(path, { recursive: true });
  await writeFile(join(path, "catalog.json"), JSON.stringify({ assets: [], downloads: [{ id, resourceId: randomUUID(), courseId: s.course.id, sourceId: "synthetic", title: "합성 영상", status: "running" }] }));
  const media = s.make([]); await assert.rejects(media.download(s.course.id, "another"), /접근 가능한/);
  const listing = await media.list(s.course.id); assert.equal(listing.downloads[0]!.status, "failed"); assert.equal(listing.downloads[0]!.errorCode, "RUN_INTERRUPTED"); await media.stop();
});

test("corrupt catalog is reported and preserved rather than replaced by an empty catalog", async () => {
  const s = await setup(), path = join(s.root, "media/accounts", s.course.accountKey); await mkdir(path, { recursive: true });
  await writeFile(join(path, "catalog.json"), "broken"); const media = s.make();
  await assert.rejects(media.recover(), /미디어 목록/); assert.equal(await readFile(join(path, "catalog.json"), "utf8"), "broken"); await media.stop();
});

test("authorized video download persists an original before automatic transcription; a double click reuses its intent", async () => {
  const s = await setup();
  const bytes = await readFile(new URL("../../../../packages/collector/test/fixtures/video/black.mp4", import.meta.url));
  const media = s.make([], { video: () => ({ fetch: (async () => new Response(bytes, { headers: { "content-type": "video/mp4", "content-length": String(bytes.length) } })) as typeof fetch, resolveSource: async () => ({ url: "https://test.invalid/v", referer: "https://test.invalid/em" }), allowedOrigins: ["https://test.invalid"] }) });
  const first = await media.download(s.course.id, "synthetic"), again = await media.download(s.course.id, "synthetic"); assert.equal(first.downloadId, again.downloadId);
  for (let n = 0; n < 100 && !(await media.list(s.course.id)).assets.length; n++) await new Promise((r) => setTimeout(r, 10));
  await tick(); const listed = await media.list(s.course.id); assert.equal(listed.assets.length, 1); assert.equal(listed.assets[0]!.source.type, "lms_video"); assert.equal(s.calls(), 1);
  s.finish(); await tick(); assert.equal((await media.list(s.course.id)).jobs[0]!.status, "succeeded");
  assert.deepEqual((await media.asset(s.course.id, listed.assets[0]!.id)).bytes, new Uint8Array(bytes)); await media.stop();
  const restarted = s.make([]); await restarted.recover(); assert.equal((await restarted.list(s.course.id)).assets.length, 1); assert.equal(s.calls(), 1); await restarted.stop();
});

test("recording stop callback hands a real finalized WAV to the automatic queue without a second user action", async () => {
  const s = await setup(); let media: MediaService;
  const recorder = new RecordingService({ dataRoot: s.root, micPermission: async () => "granted", freeBytes: () => 1024 ** 3, encode: async () => { throw new Error("synthetic WAV fallback"); }, onOriginalConfirmed: (asset) => { void media.register(asset); } });
  media = s.make([], { originals: () => recorder.originals(), recordings: (courseId) => recorder.list({ courseId }).recordings });
  const recording = await recorder.start({ courseId: s.course.id }); await recorder.chunk({ recordingId: recording.id, seq: 0, pcm: new Uint8Array(3200) });
  const stopped = await recorder.stop({ recordingId: recording.id }); assert.equal(stopped.asset!.mediaType, "audio/wav");
  await tick(); assert.equal(s.calls(), 1); s.finish(); await tick();
  const listing = await media.list(s.course.id); assert.equal(listing.recordings[0]!.status, "finalized"); assert.equal(listing.jobs[0]!.status, "succeeded");
  await media.stop();
});

test("legacy recording IPC cannot list or play another account and rejects/stops further capture", async () => {
  const s = await setup(), recorder = new RecordingService({ dataRoot: s.root, micPermission: async () => "granted", freeBytes: () => 1024 ** 3, encode: async () => { throw new Error("WAV"); } });
  const media = s.make([], { originals: () => recorder.originals(), recordings: (courseId) => recorder.list({ courseId }).recordings });
  type Args = Parameters<typeof createHandlers>;
  const handlers = createHandlers({} as Args[0], {} as Args[1], {} as Args[2], undefined, undefined, undefined, recorder, media);
  const started = await handlers["recording.start"]!({ courseId: s.course.id });
  await handlers["recording.chunk"]!({ recordingId: started.recording.id, seq: 0, pcm: new Uint8Array(3200) });
  s.switchAccount();
  await assert.rejects(handlers["recording.list"]!({ courseId: s.course.id }), /현재 계정/);
  await assert.rejects(handlers["recording.chunk"]!({ recordingId: started.recording.id, seq: 1, pcm: new Uint8Array(3200) }), /현재 계정/);
  assert.equal(recorder.activeId, undefined);
  const original = recorder.originals()[0]!; assert.ok(original);
  await assert.rejects(handlers["media.asset"]!({ assetId: original.id }), /현재 계정/);
  await assert.rejects(handlers["recording.stop"]!({ recordingId: started.recording.id }), /현재 계정/);
  assert.equal(s.calls(), 0); await media.stop();
});

test("quit during partition initialization cannot start a worker after stop returned", async () => {
  const s = await setup(), media = s.make();
  const recovering = assert.rejects(media.recover(), /종료/);
  await media.stop(); await recovering; await tick(); assert.equal(s.calls(), 0);
  await assert.rejects(media.recover(), /종료/);
});

test("engine recovery retries unavailable jobs once without duplicating originals or finished versions", async () => {
  const { EngineError } = await import('@learningxxx/transcriber');
  const s = await setup(); let ready = false, calls = 0;
  const engine: Engine = { info: { name: 'synthetic', version: 'repair' }, parameters: {}, transcribe: async () => { calls++; if (!ready) throw new EngineError('ENGINE_UNAVAILABLE', 'missing', false); return output; } };
  const media = s.make([s.asset], { engine }); await media.recover(); await tick();
  assert.equal((await media.list(s.course.id)).jobs[0]!.errorCode, 'ENGINE_UNAVAILABLE');
  ready = true; await media.retryUnavailable(); await tick(); await media.retryUnavailable(); await tick();
  const result = await media.list(s.course.id); assert.equal(calls, 2); assert.equal(result.assets.length, 1); assert.equal(result.jobs.length, 1); assert.equal(result.transcripts.length, 1);
  await media.stop();
});

test("retry of an obsolete engine job uses the current configuration and retains earlier output", async () => {
  const s = await setup(), old = s.make(); await old.recover(); await tick(); s.finish(); await tick();
  const oldId = (await old.list(s.course.id)).jobs[0]!.id; await old.stop();
  let calls = 0;
  const engine: Engine = { info: { name: 'synthetic', version: 'updated' }, parameters: { version: '2' }, transcribe: async () => { calls++; return output; } };
  const current = s.make([], { engine }); await current.recover(); await tick(); await current.retry(s.course.id, oldId); await tick();
  const result = await current.list(s.course.id); assert.equal(calls, 1); assert.equal(result.jobs.length, 2); assert.equal(result.transcripts.length, 2); await current.stop();
});

test("WBS-065: recordings are filed only under a week of their own course, and not across accounts", async () => {
  const s = await setup(), recorder = new RecordingService({ dataRoot: s.root, micPermission: async () => "granted", freeBytes: () => 1024 ** 3, encode: async () => { throw new Error("WAV"); } });
  const media = s.make([], { originals: () => recorder.originals(), recordings: (courseId) => recorder.list({ courseId }).recordings });
  const week = "33333333-3333-4333-8333-000000000001";
  const library = { manifest: async (courseId: string) => (courseId === s.course.id ? { weeks: [{ id: week }] } : undefined) };
  type Args = Parameters<typeof createHandlers>;
  const handlers = createHandlers({} as Args[0], library as unknown as Args[1], {} as Args[2], undefined, undefined, undefined, recorder, media);
  const invalid = (e: unknown) => (e as { appError?: { code: string } }).appError?.code === "INVALID_REQUEST";
  await assert.rejects(handlers["recording.start"]!({ courseId: s.course.id, weekId: "33333333-3333-4333-8333-000000000099" }), invalid);
  assert.equal(recorder.activeId, undefined, "an unknown week starts nothing");
  const started = await handlers["recording.start"]!({ courseId: s.course.id, weekId: week, lectureSourceId: "lec-1" });
  assert.equal(started.recording.weekId, week);
  await handlers["recording.stop"]!({ recordingId: started.recording.id });
  await assert.rejects(handlers["recording.assign"]!({ recordingId: started.recording.id, weekId: "33333333-3333-4333-8333-000000000099" }), invalid);
  assert.equal((await handlers["recording.assign"]!({ recordingId: started.recording.id, weekId: week })).recording.lectureSourceId, undefined);
  s.switchAccount();
  await assert.rejects(handlers["recording.assign"]!({ recordingId: started.recording.id, weekId: week }), /현재 계정/);
  await media.stop();
});
