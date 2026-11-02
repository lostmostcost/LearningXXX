import assert from "node:assert/strict";
import { test } from "node:test";
import { CollectionManifest } from "@learningxxx/contracts";
import { courseBrief } from "../src/course-context.ts";

const C = "11111111-1111-4111-8111-000000000001";
const W1 = "22222222-2222-4222-8222-000000000001";
const W2 = "22222222-2222-4222-8222-000000000002";
const T = "2026-11-02T00:00:00Z";

const item = (n: number, weekId?: string) => ({
  resource: {
    id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`, courseId: C, ...(weekId ? { weekId } : {}),
    kind: "file", source: "lms", sourceId: `s${n}`, title: `자료 ${n}`, revision: 1, updatedAt: T,
  },
  assets: [],
});

test("the course brief names the course and lists materials by week in order", () => {
  const manifest = CollectionManifest.parse({
    schemaVersion: 1,
    course: { id: C, accountKey: "acct_synthetic01", termId: "2026-2", sourceCourseId: "95899", title: "합성개론" },
    weeks: [
      { id: W2, courseId: C, sourceWeekId: "2", label: "2주차", order: 2 },
      { id: W1, courseId: C, sourceWeekId: "1", label: "1주차", order: 1 },
    ],
    revision: 1, syncRunId: "44444444-4444-4444-8444-000000000001", generatedAt: T,
    items: [item(1, W2), item(2, W1), item(3)],
    tombstones: [],
  });
  const brief = courseBrief(manifest);
  assert.match(brief, /합성개론.*95899/);
  const order = ["1주차", "자료 2", "2주차", "자료 1", "주차 없음", "자료 3"].map((s) => brief.indexOf(s));
  assert.deepEqual(order, order.toSorted((a, b) => a - b));
  assert.ok(order.every((i) => i >= 0));
});
