import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Course, DEFAULT_AUTOMATION, MANUAL_ENGINE, MediaAsset, RunEvent } from "@learningxxx/contracts";
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
  await assert.rejects(s.media.makeReadable(s.course.id, s.asset.id, version.id), /이미 진행 중/);
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

test("WBS-070: candidates are parsed from the answer; the evidence time and quote come from the transcript", async () => {
  const { parseMentions } = await import("../src/readable-note.ts");
  const transcript = { id: "11111111-1111-4111-8111-0000000000aa", segments: [{ startMs: 0, endMs: 60_000, text: "오늘은 3장" }, { startMs: 60_000, endMs: 125_000, text: "과제는 다음 주 화요일까지 제출" }, { startMs: 3_600_000, endMs: 3_610_000, text: "중간고사는 4장까지" }] };
  const answer = `여기 있습니다:\n[{"kind":"assignment","title":"과제 1","detail":"보고서 제출","due":"다음 주 화요일","at":"01:30"},{"kind":"exam","title":"중간고사","detail":"범위 4장","at":"1:00:02"},{"kind":"party","title":"x","at":"00:10"},{"kind":"other","title":"","at":"00:10"},{"kind":"other","title":"먼 곳","at":"300:00"}]`;
  const out = parseMentions(answer, transcript);
  assert.deepEqual(out.map((c) => [c.title, c.startMs, c.quote, c.due ?? null]), [
    ["과제 1", 60_000, "과제는 다음 주 화요일까지 제출", "다음 주 화요일"],
    ["중간고사", 3_600_000, "중간고사는 4장까지", null],
  ]);
  assert.deepEqual(parseMentions("없습니다", transcript), []);
  assert.deepEqual(parseMentions("[]", transcript), []);
});

test("WBS-070: confirmed candidates are kept once, checked against the transcript, and can be removed", async () => {
  const s = await setup();
  const version = (await s.media.list(s.course.id)).transcripts[0]!;
  const seg = version.segments[0]!;
  const candidate = { kind: "exam" as const, title: "중간고사", detail: "범위", transcriptId: version.id, startMs: seg.startMs, quote: "모델이 쓴 문장" };
  const { mentions } = await s.media.addMentions(s.course.id, s.asset.id, [candidate, candidate]);
  assert.equal(mentions.length, 1, "the same one twice is kept once");
  assert.equal(mentions[0]!.quote, seg.text, "the quote is the transcript's own text");
  assert.equal((await s.media.addMentions(s.course.id, s.asset.id, [candidate])).mentions.length, 0);
  await assert.rejects(s.media.addMentions(s.course.id, s.asset.id, [{ ...candidate, startMs: seg.startMs + 7 }]), /근거 시각/);
  assert.equal((await s.media.mentions(s.course.id)).mentions.length, 1);
  await s.media.removeMention(s.course.id, mentions[0]!.id);
  assert.equal((await s.media.mentions(s.course.id)).mentions.length, 0);
  await assert.rejects(s.media.removeMention(s.course.id, mentions[0]!.id), /찾지 못했습니다/);
  await s.media.stop();
});

test("WBS-071: a translation keeps every sentence's place; missing ones keep the original and are counted; saved for next time", async () => {
  const { parseTranslation, translatePrompt, TRANSLATE_BATCH } = await import("../src/readable-note.ts");
  assert.deepEqual(parseTranslation('ok {"1":"one","3":"three","2":7}', 3), ["one", undefined, "three"]);
  assert.match(translatePrompt("en", ["가", "나"]), /\n1\t가\n2\t나$/);
  const batches: number[] = [];
  const root = await mkdtemp(join(tmpdir(), "wbs071-")); roots.push(root);
  const s = await setup();
  // A long synthetic version (250 sentences), attached as an imported transcript of the same original.
  const long = { schemaVersion: 1 as const, id: randomUUID(), sourceAssetId: s.asset.id, kind: "engine" as const, engine: { name: "imported", version: "x" }, parametersHash: "c".repeat(64), language: "ko", createdAt: "2026-11-03T00:00:00Z",
    segments: Array.from({ length: 250 }, (_, i) => ({ startMs: i * 1000, endMs: i * 1000 + 900, text: i === 5 ? "  " : `문장 ${i}` })) };
  await s.media.adoptImport(s.course.id, { sha256: s.asset.sha256, transcript: long, docs: [] });
  await s.media.stop();
  const version = long;
  const media = new MediaService({ dataRoot: s.root, accountKey: () => s.course.accountKey, courses: async () => [s.course], originals: () => [s.asset], recordings: () => [],
    engine: { info: { name: "synthetic", version: "1" }, parameters: {}, transcribe: async () => ({ language: "ko", text: "", words: [] }) },
    videos: async () => [], openOriginal: async () => {}, video: () => { throw new Error("unused"); },
    translate: async ({ lines }) => { batches.push(lines.length); return lines.map((l, i) => (i === 0 ? undefined : `EN:${l}`)); } });
  await media.recover();
  assert.deepEqual(await media.translation(s.course.id, s.asset.id, version.id, "en"), {}, "nothing before it is made");
  const done = await media.translate(s.course.id, s.asset.id, version.id, "en");
  assert.equal(done.texts.length, version.segments.length);
  assert.equal(done.texts[0], version.segments[0]!.text, "a missing translation keeps the original");
  assert.equal(done.texts[5], "  ", "a blank sentence stays blank");
  assert.equal(done.texts[1], "EN:문장 1");
  assert.equal(done.untranslated, Math.ceil(version.segments.length / TRANSLATE_BATCH), "the first of each batch came back missing");
  assert.deepEqual(batches, [120, 120, 10]);
  assert.deepEqual((await media.translation(s.course.id, s.asset.id, version.id, "en")).texts, done.texts);
  assert.deepEqual(await media.translation(s.course.id, s.asset.id, version.id, "ja"), {}, "per language");
  await media.stop();
});

test("WBS-071: preferences default to Korean and survive a restart", async () => {
  const { Preferences } = await import("../src/preferences.ts");
  const root = await mkdtemp(join(tmpdir(), "wbs071-pref-")); roots.push(root);
  const file = join(root, "preferences.json");
  assert.deepEqual(new Preferences(file).get(), { language: "ko", automation: DEFAULT_AUTOMATION, theme: "system" });
  new Preferences(file).set({ language: "en" });
  assert.deepEqual(new Preferences(file).get(), { language: "en", automation: DEFAULT_AUTOMATION, theme: "system" });
  new Preferences(file).set({ automation: { review: true } });
  assert.deepEqual(new Preferences(file).get(), { language: "en", automation: { ...DEFAULT_AUTOMATION, review: true }, theme: "system" }, "one setting changes, the rest stay");
  await writeFile(file, "{ broken");
  assert.deepEqual(new Preferences(file).get(), { language: "ko", automation: DEFAULT_AUTOMATION, theme: "system" }, "an unreadable file falls back to defaults");
});
