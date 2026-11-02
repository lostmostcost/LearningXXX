import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CollectionManifest } from "@learningxxx/contracts";
import { materialLayout, syncMaterials } from "../src/course-materials.ts";

const C = "11111111-1111-4111-8111-000000000001";
const W1 = "22222222-2222-4222-8222-000000000001";
const T = "2026-11-02T00:00:00Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function manifest(files: { n: number; title: string; name: string; body: string; week?: string }[]) {
  return CollectionManifest.parse({
    schemaVersion: 1,
    course: { id: C, accountKey: "acct_synthetic01", termId: "2026-2", sourceCourseId: "1", title: "합성개론" },
    weeks: [{ id: W1, courseId: C, sourceWeekId: "1", label: "1주차/OT", order: 1 }],
    revision: 1, syncRunId: "44444444-4444-4444-8444-000000000001", generatedAt: T, tombstones: [],
    items: files.map((f) => ({
      resource: { id: `33333333-3333-4333-8333-${String(f.n).padStart(12, "0")}`, courseId: C, ...(f.week ? { weekId: f.week } : {}), kind: "file", source: "lms", sourceId: `s${f.n}`, title: f.title, revision: 1, updatedAt: T },
      assets: [{ id: `55555555-5555-4555-8555-${String(f.n).padStart(12, "0")}`, resourceId: `33333333-3333-4333-8333-${String(f.n).padStart(12, "0")}`, mediaType: "application/pdf", bytes: f.body.length, sha256: sha(f.body), storageKey: `objects/${sha(f.body)}`, originalName: f.name }],
    })),
  });
}

test("materials are laid out by week with readable, unique, safe names", () => {
  const layout = materialLayout(manifest([
    { n: 1, title: "OT 자료", name: "a.pdf", body: "1", week: W1 },
    { n: 2, title: "OT 자료", name: "b.PDF", body: "2", week: W1 },
    { n: 3, title: "../secret", name: "c.pdf", body: "3" },
  ]));
  assert.deepEqual(layout.map((e) => e.path), ["01 1주차 OT/OT 자료.pdf", "01 1주차 OT/OT 자료 (2).pdf", "00 주차 없음/secret.pdf"]);
});

test("the folder holds read-only copies of verified originals and drops what left the course", async () => {
  const root = mkdtempSync(join(tmpdir(), "wbs044-"));
  const store = join(root, "store");
  mkdirSync(join(store, "objects"), { recursive: true });
  const put = (body: string) => writeFileSync(join(store, "objects", sha(body)), body);
  put("one"); put("two");
  const dir = join(root, "materials");
  const source = { path: (k: string) => join(store, k), verify: async (k: string, s: string) => existsSync(join(store, k)) && sha(readFileSync(join(store, k), "utf8")) === s };

  const first = await syncMaterials(dir, materialLayout(manifest([
    { n: 1, title: "OT", name: "a.pdf", body: "one", week: W1 },
    { n: 2, title: "missing", name: "b.pdf", body: "never stored", week: W1 },
  ])), source);
  assert.deepEqual(first.map((e) => e.path), ["01 1주차 OT/OT.pdf"]);
  const ot = join(dir, "01 1주차 OT/OT.pdf");
  assert.equal(readFileSync(ot, "utf8"), "one");
  assert.equal(statSync(ot).mode & 0o222, 0, "read-only");

  writeFileSync(join(dir, "stray.md"), "x");
  const second = await syncMaterials(dir, materialLayout(manifest([{ n: 3, title: "2강", name: "c.pdf", body: "two" }])), source);
  assert.deepEqual(second.map((e) => e.path), ["00 주차 없음/2강.pdf"]);
  assert.equal(existsSync(ot), false);
  assert.equal(existsSync(join(dir, "stray.md")), false);
  assert.equal(existsSync(join(dir, "01 1주차 OT")), false);
});
