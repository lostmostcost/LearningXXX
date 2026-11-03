import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { AudioImporter, dateInName } from "../src/audio-import.ts";

const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });

test("WBS-077: chosen files are checked (format, size, readable) and only good ones can be imported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wbs077-")); roots.push(dir);
  const memo = join(dir, "음성 메모 20260915 0903.m4a"), mp3 = join(dir, "lecture.MP3"), text = join(dir, "notes.txt"), empty = join(dir, "empty.wav"), broken = join(dir, "broken.mp3");
  await writeFile(memo, "synthetic m4a"); await writeFile(mp3, "synthetic mp3"); await writeFile(text, "x"); await writeFile(empty, ""); await writeFile(broken, "not audio");
  const stored: { title: string; type: string; weekId?: string | undefined; startedAt: string; durationMs: number; importedFrom: string; bytes: Uint8Array }[] = [];
  const importer = new AudioImporter({
    chooseFiles: async () => [memo, mp3, text, empty, broken],
    probe: async (path) => (path === broken ? undefined : 90.5),
    store: async (input) => { stored.push(input); return {} as never; },
  });
  const plan = await importer.choose();
  assert.ok(plan.planId);
  const byName = new Map(plan.files.map((f) => [f.name, f]));
  assert.equal(byName.get("음성 메모 20260915 0903.m4a")!.startedAt, "2026-09-15T00:03:00Z", "a date in the name is the recording time (Seoul)");
  assert.equal(byName.get("lecture.MP3")!.durationMs, 90_500);
  assert.equal(byName.get("lecture.MP3")!.problem, undefined, "extension case does not matter");
  assert.match(byName.get("notes.txt")!.problem!, /지원하지 않는 형식/);
  assert.match(byName.get("empty.wav")!.problem!, /빈 파일/);
  assert.match(byName.get("broken.mp3")!.problem!, /읽을 수 없는/);
  const course = randomUUID(), week = randomUUID();
  const result = await importer.run({ planId: plan.planId!, courseId: course, files: [
    { id: byName.get("음성 메모 20260915 0903.m4a")!.id, title: "3주차 강의", weekId: week },
    { id: byName.get("notes.txt")!.id, title: "x" },
  ] });
  assert.equal(result.imported, 1);
  assert.equal(result.failed.length, 1, "a rejected file cannot be imported");
  assert.deepEqual(stored.map((s) => [s.title, s.type, s.weekId, s.durationMs, new TextDecoder().decode(s.bytes)]), [["3주차 강의", "m4a", week, 90_500, "synthetic m4a"]]);
  await writeFile(mp3, "changed after choosing");
  const changed = await importer.run({ planId: plan.planId!, courseId: course, files: [{ id: byName.get("lecture.MP3")!.id, title: "y" }] });
  assert.match(changed.failed[0]!.message, /바뀌었습니다/);
  await assert.rejects(importer.run({ planId: randomUUID(), courseId: course, files: [{ id: randomUUID(), title: "z" }] }), /다시 골라/);
  assert.deepEqual(await new AudioImporter({ chooseFiles: async () => undefined, store: async () => ({}) as never }).choose(), { files: [] });
});

test("dates in file names", () => {
  assert.equal(dateInName("2026-09-07_09-00 강의.mp3"), "2026-09-07T00:00:00Z");
  assert.equal(dateInName("20261012.m4a"), "2026-10-12T03:00:00Z", "no time → noon Seoul");
  assert.equal(dateInName("새 녹음 3.m4a"), undefined);
  assert.equal(dateInName("20261345.m4a"), undefined);
});

test("probeDuration reads a real WAV with macOS afinfo", { skip: process.platform !== "darwin" }, async () => {
  const { probeDuration } = await import("../src/audio-import.ts");
  const { wavHeader } = await import("../src/recording-service.ts");
  const dir = await mkdtemp(join(tmpdir(), "wbs077-probe-")); roots.push(dir);
  const file = join(dir, "one-second.wav");
  await writeFile(file, Buffer.concat([wavHeader(32_000), Buffer.alloc(32_000)]));
  const seconds = await probeDuration(file);
  assert.ok(seconds !== undefined && Math.abs(seconds - 1) < 0.01, String(seconds));
  await writeFile(join(dir, "fake.mp3"), "not audio");
  assert.equal(await probeDuration(join(dir, "fake.mp3")), undefined);
});
