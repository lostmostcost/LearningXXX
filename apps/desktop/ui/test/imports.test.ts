import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportItem } from "@learningxxx/contracts";
import { importSummary } from "../src/imports.ts";

const item = (over: Partial<ImportItem>): ImportItem => ({ id: "a".repeat(32), path: "합성 과목/03주차/녹음/x", kind: "recording", title: "x", hasTranscript: true, docs: [], bytes: 1, status: "new", ...over });

test("the import list is grouped by course and week, with counts by state", () => {
  const s = importSummary([
    item({ courseId: "11111111-1111-4111-8111-000000000001", courseTitle: "합성 과목", weekLabel: "3주차" }),
    item({ id: "b".repeat(32), path: "합성 과목/03주차/강의영상/y", kind: "lecture", courseId: "11111111-1111-4111-8111-000000000001", courseTitle: "합성 과목", weekLabel: "3주차", status: "imported" }),
    item({ id: "c".repeat(32), path: "모르는 과목/01주차/녹음/z", status: "no_course" }),
  ]);
  assert.deepEqual([s.new, s.imported, s.noCourse], [1, 1, 1]);
  assert.deepEqual(s.groups.map((g) => [g.title, g.items.length]), [["합성 과목 · 3주차", 2], ["모르는 과목 (앱에 없는 과목) · 01주차", 1]]);
});
