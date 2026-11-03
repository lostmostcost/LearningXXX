import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CollectionManifest } from "@learningxxx/contracts";
import { createDirectoryStore } from "@learningxxx/collector";
import { ExternalMaterials } from "../src/external-materials.ts";

const COURSE = "11111111-1111-4111-8111-111111111111";
const W1 = "22222222-2222-4222-8222-222222222221";
const manifest = {
  schemaVersion: 1, course: { id: COURSE, accountKey: "acct_abcdefgh", termId: "1", sourceCourseId: "1", title: "과목" },
  weeks: [{ id: W1, courseId: COURSE, sourceWeekId: "1", label: "1주차", order: 0 }], revision: 1, syncRunId: COURSE, generatedAt: "2026-09-01T00:00:00Z", items: [], tombstones: [],
} as unknown as CollectionManifest;

async function setup() {
  const base = await mkdtemp(join(tmpdir(), "external-"));
  const user = join(base, "user"); await mkdir(user);
  await writeFile(join(user, "논문.pdf"), "%PDF-1.4 synthetic");
  await writeFile(join(user, "정리.hwp"), "hwp-bytes");
  await writeFile(join(user, "run.command"), "#!/bin/sh");
  await writeFile(join(user, "empty.pdf"), "");
  await symlink(join(user, "논문.pdf"), join(user, "link.pdf"));
  let account: string | undefined = "acct_abcdefgh", n = 0, picked: string[] = [];
  const ext = new ExternalMaterials({
    root: join(base, "external"), accountKey: () => account, store: createDirectoryStore(join(base, "library")),
    collected: async () => manifest, chooseFiles: async () => picked,
    newId: () => `33333333-3333-4333-8333-${String(++n).padStart(12, "0")}`, now: () => new Date("2026-11-04T00:00:00Z"),
  });
  return { base, user, ext, pick: (names: string[]) => { picked = names.map((x) => join(user, x)); }, setAccount: (a: string | undefined) => { account = a; }, done: () => rm(base, { recursive: true, force: true }) };
}

describe("external materials", () => {
  it("adds chosen files to a week or 기타 자료 and serves them with the collected material", async () => {
    const t = await setup();
    try {
      t.pick(["논문.pdf", "정리.hwp", "run.command", "empty.pdf", "link.pdf"]);
      const plan = await t.ext.choose();
      const byName = Object.fromEntries(plan.files.map((f) => [f.name, f]));
      assert.equal(byName["논문.pdf"]!.problem, undefined);
      assert.match(byName["run.command"]!.problem!, /지원하지 않는/);
      assert.match(byName["empty.pdf"]!.problem!, /빈 파일/);
      assert.match(byName["link.pdf"]!.problem!, /일반 파일이 아닙니다/);
      const result = await t.ext.add({ planId: plan.planId!, courseId: COURSE, files: [
        { id: byName["논문.pdf"]!.id, title: "참고 논문", weekId: W1 },
        { id: byName["정리.hwp"]!.id, title: "" },
        { id: byName["run.command"]!.id, title: "x" },
      ] });
      assert.equal(result.added, 2);
      assert.equal(result.failed.length, 1);
      const merged = await t.ext.merge(manifest);
      const items = merged.items.map((i) => [i.resource.title, i.resource.weekId, i.resource.source, i.assets[0]!.mediaType]);
      assert.deepEqual(items, [["참고 논문", W1, "manual", "application/pdf"], ["정리.hwp", undefined, "manual", "application/x-hwp"]]);
      const asset = merged.items[0]!.assets[0]!;
      assert.equal(await readFile(join(t.base, "library", asset.storageKey), "utf8"), "%PDF-1.4 synthetic", "a copy in the app store");
      assert.equal(await readFile(join(t.user, "논문.pdf"), "utf8"), "%PDF-1.4 synthetic", "the original is untouched");
    } finally { await t.done(); }
  });

  it("moves, renames and removes only the app's entry; refuses unknown weeks and other accounts", async () => {
    const t = await setup();
    try {
      t.pick(["논문.pdf"]);
      const plan = await t.ext.choose();
      await t.ext.add({ planId: plan.planId!, courseId: COURSE, files: [{ id: plan.files[0]!.id, title: "논문" }] });
      const id = (await t.ext.merge(manifest)).items[0]!.resource.id;
      await t.ext.change({ courseId: COURSE, resourceId: id, weekId: W1, title: "새 이름" });
      assert.deepEqual((await t.ext.merge(manifest)).items.map((i) => [i.resource.title, i.resource.weekId]), [["새 이름", W1]]);
      await t.ext.change({ courseId: COURSE, resourceId: id, weekId: null });
      assert.equal((await t.ext.merge(manifest)).items[0]!.resource.weekId, undefined);
      await assert.rejects(t.ext.change({ courseId: COURSE, resourceId: id, weekId: "44444444-4444-4444-8444-444444444444" }), /없는 주차/);
      await assert.rejects(t.ext.add({ planId: "55555555-5555-4555-8555-555555555555", courseId: COURSE, files: [{ id, title: "" }] }), /다시 골라/);
      t.setAccount("acct_zzzzzzzz");
      assert.equal((await t.ext.merge(manifest)).items.length, 0, "another account does not see them");
      t.setAccount("acct_abcdefgh");
      await t.ext.change({ courseId: COURSE, resourceId: id, remove: true });
      assert.equal((await t.ext.merge(manifest)).items.length, 0);
      assert.equal(await readFile(join(t.user, "논문.pdf"), "utf8"), "%PDF-1.4 synthetic");
    } finally { await t.done(); }
  });
});
