import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Course, MANUAL_ENGINE, MediaAsset, RunEvent } from "@learningxxx/contracts";
import type { Engine } from "@learningxxx/transcriber";
import { MediaService } from "../src/media-service.ts";
import { createReadableRunner, readablePrompt } from "../src/readable-note.ts";
import type { StartCli } from "../src/session-service.ts";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }); });
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2)); };

async function setup(readable?: (input: { title: string; text: string; signal: AbortSignal }) => Promise<string>) {
  const root = await mkdtemp(join(tmpdir(), "wbs069-")); roots.push(root);
  const course = Course.parse({ id: randomUUID(), accountKey: "acct_synthetic01", termId: "t", sourceCourseId: "1", title: "합성" });
  const bytes = Buffer.from("synthetic"), sha = createHash("sha256").update(bytes).digest("hex");
  const asset = MediaAsset.parse({ schemaVersion: 1, id: randomUUID(), courseId: course.id, role: "original", source: { type: "recording", recordingId: randomUUID() }, title: "합성 녹음", mediaType: "audio/wav", bytes: bytes.length, sha256: sha, storageKey: `media/originals/${sha}.wav`, createdAt: "2026-11-03T00:00:00Z" });
  await mkdir(join(root, "media/originals"), { recursive: true }); await writeFile(join(root, asset.storageKey), bytes);
  const engine: Engine = { info: { name: "synthetic", version: "1" }, parameters: {}, transcribe: async () => ({ language: "ko", text: "첫 문장. 둘째 문장.", words: [{ text: "첫", start: 0, end: 0.4 }, { text: "문장.", start: 0.4, end: 1 }, { text: "둘째", start: 3, end: 3.5 }, { text: "문장.", start: 3.5, end: 4 }] }) };
  const media = new MediaService({ dataRoot: root, accountKey: () => course.accountKey, courses: async () => [course], originals: () => [asset], recordings: () => [], engine,
    videos: async () => [], openOriginal: async () => {}, video: () => { throw new Error("unused"); }, ...(readable ? { readable } : {}) });
  await media.recover(); await tick();
  return { root, course, asset, media };
}

test("a hand correction is a new version based on the edited one; the original version stays", async () => {
  const s = await setup();
  const before = await s.media.list(s.course.id);
  const engineVersion = before.transcripts[0]!;
  const texts = engineVersion.segments.map((seg, i) => (i === 0 ? "고친 첫 문장" : seg.text));
  const { transcriptId } = await s.media.saveCorrection(s.course.id, s.asset.id, engineVersion.id, texts);
  const after = await s.media.list(s.course.id);
  const corrected = after.transcripts.find((t) => t.id === transcriptId)!;
  assert.equal(corrected.kind, "corrected");
  assert.equal(corrected.engine.name, MANUAL_ENGINE);
  assert.equal(corrected.basedOnTranscriptId, engineVersion.id);
  assert.equal(corrected.segments[0]!.text, "고친 첫 문장");
  assert.deepEqual(corrected.segments.map((x) => [x.startMs, x.endMs]), engineVersion.segments.map((x) => [x.startMs, x.endMs]), "times are kept");
  assert.deepEqual(after.transcripts.find((t) => t.id === engineVersion.id), engineVersion, "the edited version is unchanged");
  await assert.rejects(s.media.saveCorrection(s.course.id, s.asset.id, engineVersion.id, ["하나만"]), /문장 수/);
  await assert.rejects(s.media.saveCorrection(s.course.id, s.asset.id, randomUUID(), texts), /전사 판/);
  // A correction of the correction keeps the chain.
  const second = await s.media.saveCorrection(s.course.id, s.asset.id, transcriptId, corrected.segments.map((x) => x.text + "!"));
  assert.equal((await s.media.list(s.course.id)).transcripts.find((t) => t.id === second.transcriptId)!.basedOnTranscriptId, transcriptId);
  await s.media.stop();
});

test("a readable note is made from the chosen version and kept as a document; one at a time", async () => {
  let release!: (note: string) => void;
  const asked: string[] = [];
  const s = await setup(({ text }) => { asked.push(text); return new Promise<string>((r) => { release = r; }); });
  const version = (await s.media.list(s.course.id)).transcripts[0]!;
  const making = s.media.makeReadable(s.course.id, s.asset.id, version.id);
  await tick();
  await assert.rejects(s.media.makeReadable(s.course.id, s.asset.id, version.id), /만드는 중/);
  release("## 정리\n[00:00] 첫 문장");
  assert.deepEqual(await making, { doc: "readable_app" });
  assert.match(asked[0]!, /^\[00:00\] /);
  const listing = await s.media.list(s.course.id);
  assert.deepEqual(listing.importedDocs?.[s.asset.id], ["readable_app"]);
  assert.equal((await s.media.importedDoc(s.course.id, s.asset.id, "readable_app")).text, "## 정리\n[00:00] 첫 문장");
  assert.equal(listing.jobs.filter((j) => j.status === "succeeded").length, 1, "a note does not stop or replace transcription");
  await s.media.stop();
});

test("the readable runner uses an independent CLI session in an empty folder, returns the text and cleans up", async () => {
  const root = await mkdtemp(join(tmpdir(), "wbs069-run-")); roots.push(root);
  const requests: Parameters<StartCli>[0][] = [];
  const ev = (seq: number, type: string, payload: unknown) => RunEvent.parse({ schemaVersion: 1, eventId: randomUUID(), runId: "11111111-1111-4111-8111-000000000001", seq, occurredAt: new Date().toISOString(), type, payload });
  const startCli: StartCli = async (request) => {
    requests.push(request);
    assert.deepEqual(await readdir(request.workspacePath), [], "the workspace is empty");
    return { ok: true, events: (async function* () { yield ev(0, "text.delta", { text: "## 정리" }); yield ev(1, "text.delta", { text: "\n본문" }); yield ev(2, "run.completed", { exitCode: 0 }); })() };
  };
  const run = createReadableRunner(startCli, root);
  assert.equal(await run({ title: "합성", text: "[00:00] 문장", signal: new AbortController().signal }), "## 정리\n본문");
  assert.equal(requests[0]!.mode, "independent");
  assert.equal(requests[0]!.prompt, readablePrompt("합성", "[00:00] 문장"));
  assert.deepEqual(await readdir(root), [], "the run folder is removed");
  const failing = createReadableRunner(async () => ({ ok: true, events: (async function* () { yield ev(0, "run.failed", { error: { code: "AUTH_REQUIRED", message: "로그인 필요", retryable: false } }); })() }), root);
  await assert.rejects(failing({ title: "x", text: "y", signal: new AbortController().signal }), /로그인 필요/);
});
