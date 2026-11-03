import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Course, IMPORTED_ENGINE } from "@learningxxx/contracts";
import type { Week } from "@learningxxx/contracts";
import type { Engine } from "@learningxxx/transcriber";
import { LegacyImporter, importStore, toTranscript } from "../src/legacy-import.ts";
import { MediaService } from "../src/media-service.ts";
import { RecordingService } from "../src/recording-service.ts";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true }); });
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2)); };

/** A synthetic semester folder in the layout the user keeps (no real lecture content). */
async function semester() {
  const root = await mkdtemp(join(tmpdir(), "wbs066-src-")); roots.push(root);
  const rec = join(root, "합성 과목 00분반", "03주차", "녹음");
  const vid = join(root, "합성 과목 00분반", "03주차", "강의영상");
  await mkdir(rec, { recursive: true }); await mkdir(vid, { recursive: true });
  await writeFile(join(rec, "20260921_0903_3주차.opus"), Buffer.from("synthetic opus A"));
  await writeFile(join(rec, "20260921_0903_3주차.transcript.json"), JSON.stringify({
    segments: [{ start: 0, end: 1.5, text: " 합성 문장 하나" }, { start: 1.5, end: 3.25, text: "합성 문장 둘" }],
    language: "ko", model: "synthetic-model", recorded_seconds: 3.4,
    context: { course: { course_id: "900001" }, started: "2026-09-21T09:03:00+09:00", week: 3 },
  }));
  await writeFile(join(rec, "20260921_0903_3주차.readable.md"), "# 합성 정리본");
  await writeFile(join(rec, "20260921_0903_3주차.srt"), "1\n00:00:00,000 --> 00:00:01,500\n합성\n");
  await writeFile(join(vid, "03주차_1차시_합성.opus"), Buffer.from("synthetic opus B"));
  await writeFile(join(vid, "03주차_1차시_합성.transcript.json"), JSON.stringify({ segments: [{ start: 0, end: 2, text: "합성 강의" }], model: "synthetic-model", context: { course: { course_id: "900001" }, video: { content_id: "abc123def", title: "합성 1차시", duration: 2 } } }));
  // Things that are never imported or opened: code, other folders, a week without a number, an unknown course, a link.
  await writeFile(join(rec, "helper.py"), "raise SystemExit('must not be read')");
  await mkdir(join(root, "합성 과목 00분반", "_수업정보"), { recursive: true });
  await mkdir(join(root, "합성 과목 00분반", "기타", "녹음"), { recursive: true });
  await writeFile(join(root, "합성 과목 00분반", "기타", "녹음", "x.opus"), "x");
  await mkdir(join(root, "모르는 과목", "01주차", "녹음"), { recursive: true });
  await writeFile(join(root, "모르는 과목", "01주차", "녹음", "y.opus"), "y");
  await symlink(join(rec, "20260921_0903_3주차.opus"), join(rec, "link.opus"));
  return root;
}

async function app() {
  const dataRoot = await mkdtemp(join(tmpdir(), "wbs066-data-")); roots.push(dataRoot);
  const course = Course.parse({ id: randomUUID(), accountKey: "acct_synthetic01", termId: "t", sourceCourseId: "900001", title: "합성 과목 (LMS 이름)" });
  const weeks: Week[] = [1, 2, 3].map((n) => ({ id: randomUUID(), courseId: course.id, sourceWeekId: `m${n}`, label: `${n}주차`, order: n - 1 }));
  let calls = 0;
  const engine: Engine = { info: { name: "synthetic", version: "1" }, parameters: {}, transcribe: async () => { calls++; return { language: "ko", text: "엔진 전사", words: [] }; } };
  const recorder = new RecordingService({ dataRoot, micPermission: async () => "granted", freeBytes: () => 1024 ** 4 });
  const media = new MediaService({ dataRoot, accountKey: () => course.accountKey, courses: async () => [course], originals: () => recorder.originals(), recordings: (id) => recorder.list({ courseId: id }).recordings, engine,
    videos: async () => [], openOriginal: async () => {}, video: () => { throw new Error("unused"); } });
  await media.recover();
  return { dataRoot, course, weeks, recorder, media, calls: () => calls };
}

test("scan lists only week audio, matched to course by LMS number, week by folder and lecture by content id", async () => {
  const root = await semester(), a = await app();
  const importer = new LegacyImporter({ chooseFolder: async () => root, courses: async () => [a.course], weeks: async () => a.weeks, recordings: (id) => a.recorder.list({ courseId: id }).recordings, store: async () => assert.fail("scan stores nothing") });
  const { planId, items, folder } = await importer.scan();
  assert.ok(planId); assert.ok(folder);
  assert.deepEqual(items.map((i) => [i.path, i.kind, i.status, i.weekLabel, i.lectureSourceId ?? null]), [
    ["모르는 과목/01주차/녹음/y", "recording", "no_course", undefined, null],
    ["합성 과목 00분반/03주차/강의영상/03주차_1차시_합성", "lecture", "new", "3주차", "abc123def"],
    ["합성 과목 00분반/03주차/녹음/20260921_0903_3주차", "recording", "new", "3주차", null],
  ]);
  const recording = items.find((i) => i.kind === "recording" && i.status === "new")!;
  assert.equal(recording.title, "2026-09-21 09:03 녹음");
  assert.deepEqual(recording.docs.toSorted(), ["readable", "srt"]);
  assert.equal(items.find((i) => i.kind === "lecture")!.title, "합성 1차시");
  assert.deepEqual(await new LegacyImporter({ chooseFolder: async () => undefined, courses: async () => [], weeks: async () => [], recordings: () => [], store: async () => {} }).scan(), { items: [] }, "no folder chosen → nothing");
});

test("import copies audio, keeps the transcript and notes, files it under week and lecture, and does not transcribe it again", async () => {
  const root = await semester(), a = await app();
  const before = await readFile(join(root, "합성 과목 00분반", "03주차", "녹음", "20260921_0903_3주차.opus"));
  const importer = new LegacyImporter({ chooseFolder: async () => root, courses: async () => [a.course], weeks: async () => a.weeks, recordings: (id) => a.recorder.list({ courseId: id }).recordings,
    store: importStore({ adoptImport: (c, i) => a.media.adoptImport(c, i), importOriginal: (i) => a.recorder.importOriginal(i), register: (asset) => a.media.register(asset) }) });
  const plan = await importer.scan();
  const result = await importer.run({ planId: plan.planId!, itemIds: plan.items.map((i) => i.id) });
  assert.deepEqual(result, { imported: 2, skipped: 1, failed: [] }, "the item without a course is skipped");
  await tick();
  assert.equal(a.calls(), 0, "imported transcripts are not made again");
  const listing = await a.media.list(a.course.id);
  const recorded = listing.recordings.find((r) => r.importedFrom?.endsWith("녹음/20260921_0903_3주차"))!;
  assert.equal(recorded.weekId, a.weeks[2]!.id);
  assert.equal(recorded.startedAt, "2026-09-21T00:03:00Z");
  assert.equal(recorded.durationMs, 3400);
  assert.equal(listing.recordings.find((r) => r.importedFrom?.includes("강의영상"))!.lectureSourceId, "abc123def");
  const asset = listing.assets.find((x) => x.id === recorded.originalAssetId)!;
  assert.equal(asset.mediaType, "audio/ogg");
  const transcript = listing.transcripts.find((t) => t.sourceAssetId === asset.id)!;
  assert.equal(transcript.engine.name, IMPORTED_ENGINE);
  assert.deepEqual(transcript.segments.map((s) => [s.startMs, s.endMs, s.text]), [[0, 1500, "합성 문장 하나"], [1500, 3250, "합성 문장 둘"]]);
  assert.equal(listing.jobs.find((j) => j.sourceAssetId === asset.id)!.status, "succeeded");
  assert.deepEqual(listing.importedDocs?.[asset.id]?.toSorted(), ["readable", "srt"]);
  assert.equal((await a.media.importedDoc(a.course.id, asset.id, "readable")).text, "# 합성 정리본");
  await assert.rejects(a.media.importedDoc(a.course.id, asset.id, "corrections"), /가져온 문서/);
  assert.deepEqual((await a.media.asset(a.course.id, asset.id)).bytes, new Uint8Array(before), "the copy plays as the original");
  assert.deepEqual(await readFile(join(root, "합성 과목 00분반", "03주차", "녹음", "20260921_0903_3주차.opus")), before, "the user's file is unchanged");

  const again = await importer.scan();
  assert.deepEqual(again.items.filter((i) => i.courseId).map((i) => i.status), ["imported", "imported"], "a second scan shows them as already imported");
  assert.deepEqual(await importer.run({ planId: again.planId!, itemIds: again.items.map((i) => i.id) }), { imported: 0, skipped: 3, failed: [] });
  assert.equal(a.recorder.list({ courseId: a.course.id }).recordings.length, 2);
  await assert.rejects(importer.run({ planId: plan.planId!, itemIds: [plan.items[0]!.id] }), /다시 골라/, "an old plan cannot be run");
  await a.media.stop();
});

test("an original whose transcript cannot be read is transcribed like any recording", async () => {
  const root = await semester(), a = await app();
  await writeFile(join(root, "합성 과목 00분반", "03주차", "녹음", "20260921_0903_3주차.transcript.json"), JSON.stringify({ segments: "unreadable", context: { course: { course_id: "900001" } } }));
  const importer = new LegacyImporter({ chooseFolder: async () => root, courses: async () => [a.course], weeks: async () => a.weeks, recordings: (id) => a.recorder.list({ courseId: id }).recordings,
    store: importStore({ adoptImport: (c, i) => a.media.adoptImport(c, i), importOriginal: (i) => a.recorder.importOriginal(i), register: (asset) => a.media.register(asset) }) });
  const plan = await importer.scan();
  const item = plan.items.find((i) => i.path.endsWith("녹음/20260921_0903_3주차"))!;
  assert.equal(item.status, "new");
  await importer.run({ planId: plan.planId!, itemIds: [item.id] });
  await tick();
  assert.equal(a.calls(), 1);
  await a.media.stop();
});

test("transcript conversion keeps time order and drops malformed segments", () => {
  const t = toTranscript({ segments: [{ start: 2, end: 3, text: "b" }, { start: "x" }, { start: 0, end: 1, text: " a " }], model: "m" }, randomUUID(), randomUUID(), "2026-11-03T00:00:00Z")!;
  assert.deepEqual(t.segments.map((s) => s.text), ["a", "b"]);
  assert.equal(toTranscript({ segments: [] }, randomUUID(), randomUUID(), "2026-11-03T00:00:00Z"), undefined);
});
