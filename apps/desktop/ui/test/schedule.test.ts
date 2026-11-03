import assert from "node:assert/strict";
import { test } from "node:test";
import { inText, nowAndNext, orderByClass } from "../src/schedule.ts";

// Wednesday 2026-11-04 10:00 Seoul = 01:00Z.
const now = new Date("2026-11-04T01:00:00Z");
const times = [
  { courseId: "db", meetings: [{ day: "수" as const, start: "18:30", end: "20:00" }] },
  { courseId: "logic", meetings: [{ day: "수" as const, start: "09:00", end: "10:15" }, { day: "금" as const, start: "09:00", end: "10:15" }] },
  { courseId: "hr", meetings: [{ day: "월" as const, start: "13:00", end: "14:15" }] },
];

test("WBS-085: the class going on now and the next one, in Seoul time", () => {
  const r = nowAndNext(times, now);
  assert.equal(r.current?.courseId, "logic");
  assert.equal(r.next?.courseId, "db");
  assert.equal(r.next?.inMinutes, 8 * 60 + 30);
  assert.equal(nowAndNext(times, new Date("2026-11-04T01:20:00Z")).current, undefined, "10:20 is after 10:15");
  assert.equal(nowAndNext([], now).next, undefined);
});

test("WBS-085: courses in class first, then by next class, the rest in their own order", () => {
  const courses = [{ id: "x" }, { id: "hr" }, { id: "db" }, { id: "y" }, { id: "logic" }];
  assert.deepEqual(orderByClass(courses, times, now).map((c) => c.id), ["logic", "db", "hr", "x", "y"]);
  assert.equal(inText(40), "40분 뒤");
  assert.equal(inText(510), "9시간 뒤");
  assert.equal(inText(3000), "2일 뒤");
});
